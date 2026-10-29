/**
 * ProjectMemoryV2 — 层级化项目记忆加载器
 *
 * 统一加载：
 *   1. .neox/project.md  (项目级)
 *   2. .neox/modules/*.md (模块级)
 *   3. .neox/rules/*.md   (条件规则)
 *   4. NEOX.md            (向后兼容)
 */

import fs from 'fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'path';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { loadCardsFromDir } from '../knowledge/loader.js';
import { knowledgeRegistry } from '../knowledge/registry.js';
import type { KnowledgeCard } from '../knowledge/types.js';

// ============================================================================
// 类型
// ============================================================================

export interface ProjectMemoryV2Result {
  /** 记忆实际是从哪个目录加载的 —— 未必是 workDir, 见 resolveMemoryRoot。 */
  root: string;
  /** 项目级记忆内容 */
  project: string | null;
  /** 项目记忆来源文件 */
  projectSource: string | null;
  /** 模块级上下文 Map<目录名, 内容> */
  modules: Map<string, string>;
  /** 条件规则 Map<文件名, { globs, content }> */
  rules: Map<string, RuleEntry>;
}

export interface RuleEntry {
  /** 匹配的 glob 模式 */
  globs: string[];
  /** 规则内容（不含 frontmatter） */
  content: string;
  /** 来源文件路径 */
  sourcePath: string;
}

// ============================================================================
// 常量
// ============================================================================

const NEOX_DIR = '.neox';
const MODULES_DIR = 'modules';
const RULES_DIR = 'rules';
const PROJECT_MD = 'project.md';
const LEGACY_NEOX_MD = 'NEOX.md';
const MAX_PROJECT_CHARS = 8000;
const MAX_MODULE_CHARS = 4000;
const MAX_RULE_CHARS = 2000;

export function resolveMemoryRoot(workDir: string, homeDir: string = os.homedir()): string {
  const home = path.resolve(homeDir);
  let gitRoot: string | null = null;
  let dir = path.resolve(workDir);
  for (let i = 0; i < 40; i++) {
    /* 走到 home 就停 —— home 自己也不看 (~/.neox 不是项目记忆) */
    if (dir === home) break;
    if (fsSync.existsSync(path.join(dir, NEOX_DIR, PROJECT_MD))
      || fsSync.existsSync(path.join(dir, LEGACY_NEOX_MD))) return dir;
    if (!gitRoot && fsSync.existsSync(path.join(dir, '.git'))) gitRoot = dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return gitRoot ?? path.resolve(workDir);
}

// ============================================================================
// 主加载函数
// ============================================================================

/**
 * 加载项目的完整层级化记忆
 */
export async function loadProjectMemoryV2(rawWorkDir: string): Promise<ProjectMemoryV2Result> {
  const workDir = resolveMemoryRoot(rawWorkDir);
  const result: ProjectMemoryV2Result = {
    root: workDir,
    project: null,
    projectSource: null,
    modules: new Map(),
    rules: new Map(),
  };

  // 1. 加载项目级记忆
  const projectResult = await loadProjectFile(workDir);
  result.project = projectResult.content;
  result.projectSource = projectResult.source;

  // 2. 加载模块级上下文
  result.modules = await loadModules(workDir);

  // 3. 加载条件规则
  result.rules = await loadRules(workDir);

  // 4. 知识卡 L2: 带 paths glob 的知识卡并入 rules 池 (key 加 knowledge: 前缀) —
  //    DynamicContextInjector 的 matchRules 零改动直接生效 (设计 NEOX_KNOWLEDGE_BASE_DESIGN.md §2.3)
  for (const [key, entry] of loadKnowledgeRules(workDir)) {
    result.rules.set(key, entry);
  }

  const moduleCount = result.modules.size;
  const ruleCount = result.rules.size;
  if (result.project || moduleCount > 0 || ruleCount > 0) {
    cliLogger.info('PROJECT_MEMORY_V2', 'Loaded', {
      hasProject: !!result.project,
      source: result.projectSource,
      modules: moduleCount,
      rules: ruleCount,
    });
  }

  return result;
}

// ============================================================================
// 项目级记忆
// ============================================================================

async function loadProjectFile(workDir: string): Promise<{ content: string | null; source: string | null }> {
  // 优先级: .neox/project.md > NEOX.md
  const candidates = [
    { path: path.join(workDir, NEOX_DIR, PROJECT_MD), name: `.neox/${PROJECT_MD}` },
    { path: path.join(workDir, LEGACY_NEOX_MD), name: LEGACY_NEOX_MD },
  ];

  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate.path, 'utf-8');
      if (!raw.trim()) continue;

      const content = raw.length > MAX_PROJECT_CHARS
        ? raw.slice(0, MAX_PROJECT_CHARS) + '\n...(truncated)'
        : raw;

      return { content, source: candidate.name };
    } catch {
      // file not found, try next
    }
  }

  return { content: null, source: null };
}

// ============================================================================
// 模块级上下文
// ============================================================================

async function loadModules(workDir: string): Promise<Map<string, string>> {
  const modules = new Map<string, string>();
  const modulesDir = path.join(workDir, NEOX_DIR, MODULES_DIR);

  try {
    const files = await fs.readdir(modulesDir);
    const mdFiles = files.filter(f => f.endsWith('.md')).sort();

    for (const file of mdFiles) {
      try {
        const filePath = path.join(modulesDir, file);
        const raw = await fs.readFile(filePath, 'utf-8');
        if (!raw.trim()) continue;

        const content = raw.length > MAX_MODULE_CHARS
          ? raw.slice(0, MAX_MODULE_CHARS) + '\n...(truncated)'
          : raw;

        // 文件名去掉 .md 后缀作为 key
        const key = file.replace(/\.md$/, '');
        modules.set(key, content);
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // modules dir doesn't exist — that's fine
  }

  return modules;
}

// ============================================================================
// 条件规则
// ============================================================================

/**
 * 解析 frontmatter 中的 globs 字段
 *
 * 支持格式:
 * ---
 * globs: ["*.ts", "*.tsx"]
 * ---
 */
function parseFrontmatter(raw: string): { globs: string[]; body: string } {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) {
    return { globs: [], body: raw };
  }

  const frontmatter = match[1];
  const body = match[2];

  // 解析 globs 行
  const globsMatch = frontmatter.match(/globs:\s*\[([^\]]*)\]/);
  if (!globsMatch) {
    return { globs: [], body };
  }

  const globs = globsMatch[1]
    .split(',')
    .map(s => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);

  return { globs, body };
}

async function loadRules(workDir: string): Promise<Map<string, RuleEntry>> {
  const rules = new Map<string, RuleEntry>();
  const rulesDir = path.join(workDir, NEOX_DIR, RULES_DIR);

  try {
    const files = await fs.readdir(rulesDir);
    const mdFiles = files.filter(f => f.endsWith('.md')).sort();

    for (const file of mdFiles) {
      try {
        const filePath = path.join(rulesDir, file);
        const raw = await fs.readFile(filePath, 'utf-8');
        if (!raw.trim()) continue;

        const { globs, body } = parseFrontmatter(raw);
        const content = body.length > MAX_RULE_CHARS
          ? body.slice(0, MAX_RULE_CHARS) + '\n...(truncated)'
          : body;

        const key = file.replace(/\.md$/, '');
        rules.set(key, { globs, content: content.trim(), sourcePath: filePath });
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // rules dir doesn't exist — that's fine
  }

  return rules;
}

// ============================================================================
// 知识卡 L2 (条件触发)
// ============================================================================

/**
 * 把带 paths glob 的知识卡转成 RuleEntry 并入 rules 池。
 *
 * 注意:
 *   - 只收带 paths 的卡 — 无 paths 的卡若进池会被 matchRules 当"始终加载"(globs 空 = always),
 *     那是 L0 索引的职责, 不是 L2。
 *   - 同 id 的卡 workspace 覆盖 user (后 set 覆盖)。
 *   - knowledge 模块异常不影响 memory 加载 (兜 try/catch)。
 */
function loadKnowledgeRules(workDir: string): Map<string, RuleEntry> {
  const rules = new Map<string, RuleEntry>();
  try {
    const cardsById = new Map<string, KnowledgeCard>();
    for (const card of loadCardsFromDir(knowledgeRegistry.getUserKnowledgeDir(), 'user', workDir)) {
      cardsById.set(card.id, card);
    }
    for (const card of loadCardsFromDir(knowledgeRegistry.getWorkspaceKnowledgeDir(workDir), 'workspace', workDir)) {
      cardsById.set(card.id, card);
    }
    for (const card of cardsById.values()) {
      if (!card.meta.paths?.length) continue;
      /* always 卡全文已常驻 system prompt (knowledge-index section), 再进 glob 池就双份了 */
      if (card.meta.always) continue;
      const body = card.body.length > MAX_RULE_CHARS
        ? card.body.slice(0, MAX_RULE_CHARS) + '\n...(truncated)'
        : card.body;
      rules.set(`knowledge:${card.id}`, {
        globs: card.meta.paths,
        content: `[知识卡] ${card.meta.title} (全文: ${card.displayPath})\n${body}`.trim(),
        sourcePath: card.filePath,
      });
    }
  } catch (err: any) {
    cliLogger.debug('PROJECT_MEMORY_V2', `knowledge rules load failed: ${err?.message}`);
  }
  return rules;
}

// ============================================================================
// 匹配工具
// ============================================================================

/**
 * 根据文件路径匹配适用的规则
 */
export function matchRules(
  rules: Map<string, RuleEntry>,
  filePath: string,
): RuleEntry[] {
  if (rules.size === 0) return [];

  const matched: RuleEntry[] = [];
  const normalizedPath = filePath.replace(/\\/g, '/');

  for (const [, rule] of rules) {
    if (rule.globs.length === 0) {
      // 无 globs = 始终加载
      matched.push(rule);
      continue;
    }

    for (const glob of rule.globs) {
      if (matchGlob(normalizedPath, glob)) {
        matched.push(rule);
        break;
      }
    }
  }

  return matched;
}

/**
 * 简单 glob 匹配（支持 *, **, ?）
 */
function matchGlob(filePath: string, pattern: string): boolean {
  // 转换 glob 为正则
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');

  try {
    const regex = new RegExp(`(^|/)${regexStr}$`);
    return regex.test(filePath);
  } catch {
    return false;
  }
}

/**
 * 根据目录路径获取对应的模块上下文
 */
export function getModuleContext(
  modules: Map<string, string>,
  dirPath: string,
  workDir: string,
): string | null {
  if (modules.size === 0) return null;

  // 计算相对路径并转换为 module key 格式
  const relative = path.relative(workDir, dirPath).replace(/\\/g, '/');
  // src/runtime → src-runtime
  const key = relative.replace(/\//g, '-');

  // 精确匹配
  if (modules.has(key)) return modules.get(key)!;

  // 尝试父目录匹配
  const parts = key.split('-');
  for (let i = parts.length - 1; i >= 1; i--) {
    const parentKey = parts.slice(0, i).join('-');
    if (modules.has(parentKey)) return modules.get(parentKey)!;
  }

  return null;
}

// ============================================================================
// 格式化输出（注入 system prompt 用）
// ============================================================================

/** 按 ## 标题切 .neox/project.md, 给 lazy 加载用. */
export interface ProjectSection {
  title: string;
  size: number;
  preview: string;  /* 第一行 / 前 80 字符摘要 */
}

export function extractProjectSections(content: string): ProjectSection[] {
  const sections: ProjectSection[] = [];
  const lines = content.split('\n');
  let curTitle: string | null = null;
  let curBody = '';
  const flush = () => {
    if (curTitle) {
      const body = curBody.trim();
      const firstMeaningfulLine = body.split('\n').find(l => l.trim() && !l.startsWith('#') && !l.startsWith('-')) ?? '';
      sections.push({
        title: curTitle,
        size: body.length,
        preview: firstMeaningfulLine.slice(0, 80),
      });
    }
  };
  for (const line of lines) {
    const m = /^##\s+(.+)$/.exec(line);
    if (m) {
      flush();
      curTitle = m[1]!.trim();
      curBody = '';
    } else if (curTitle) {
      curBody += line + '\n';
    }
  }
  flush();
  return sections;
}

/** 拿指定 section 的全文 (含标题). null = 未找到. */
export function readProjectSection(content: string, sectionTitle: string): string | null {
  const lines = content.split('\n');
  const matchTitle = sectionTitle.toLowerCase();
  let inTarget = false;
  let captured: string[] = [];
  for (const line of lines) {
    const m = /^##\s+(.+)$/.exec(line);
    if (m) {
      if (inTarget) break;   /* 下一个 ## 标题, 当前 section 结束 */
      if (m[1]!.trim().toLowerCase() === matchTitle) {
        inTarget = true;
        captured.push(line);
        continue;
      }
    }
    if (inTarget) captured.push(line);
  }
  return captured.length > 0 ? captured.join('\n').trim() : null;
}

/**
 * 将项目记忆格式化为 system prompt 片段 — **lazy 模式**: 只发索引 + 头部摘要,
 * 节省 ~5-10K tokens. 全文走 `memory({action:'read', category:'project', section:'xxx'})` 按需读.
 *
 * 没 `## section` 标题时回退发头部 ~600 字符摘要 + tip 让 LLM 知道有全文可读.
 */
export function formatProjectMemoryForPrompt(result: ProjectMemoryV2Result): string {
  const parts: string[] = [];

  if (result.project) {
    const sections = extractProjectSections(result.project);
    if (sections.length === 0) {
      /* 平铺无 section, 发头部摘要 + tip */
      const preview = result.project.slice(0, 600);
      const truncated = result.project.length > 600;
      parts.push(
        `## 项目记忆 (${result.projectSource}, ${result.project.length} 字符)\n${preview}${truncated ? '...\n\n[查全文: `memory({action:"read", category:"project"})`]' : ''}`
      );
    } else {
      /* 有 ## 标题切片, 发索引 + 头部摘要 */
      const headerLines = result.project.split('\n').slice(0, 8).join('\n');
      const indexLines = sections.map(s =>
        `  - ${s.title}${s.preview ? ` — ${s.preview}` : ''} (~${s.size} 字符)`
      ).join('\n');
      parts.push(
        `## 项目记忆索引 (${result.projectSource}, ${result.project.length} 字符)\n` +
        `${headerLines}\n\n` +
        `Sections (用 \`memory({action:"read", category:"project", section:"xxx"})\` 按需读全文):\n${indexLines}`
      );
    }
  }

  /* 模块索引 — 已经是 lazy (只列名, 不注入内容). 保持. */
  if (result.modules.size > 0) {
    const moduleList = Array.from(result.modules.keys())
      .map(k => `  - ${k}`)
      .join('\n');
    parts.push(`## 可用模块上下文\n操作相关目录时会自动加载. 显式读用 \`memory({action:"read", category:"module", module_path:"xxx"})\`:\n${moduleList}`);
  }

  return parts.join('\n\n');
}
