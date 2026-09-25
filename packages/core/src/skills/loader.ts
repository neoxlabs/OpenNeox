/**
 * SkillLoader - 加载和解析 SKILL.md 文件
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Skill, SkillMetadata, SkillSource } from '@neoxlabs/kernel/skills/types.js';
import { deriveDefaultTrustLevel } from '@neoxlabs/kernel/skills/types.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

/**
 * 解析 YAML frontmatter
 */
function parseYamlFrontmatter(content: string): {
  metadata: Record<string, unknown>;
  body: string;
} {
  const BOM = String.fromCharCode(0xfeff);
  const normalized = (content.startsWith(BOM) ? content.slice(1) : content).replace(/\r\n?/g, '\n');
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*(?:\n([\s\S]*))?$/;
  const match = normalized.match(frontmatterRegex);

  if (!match) {
    return { metadata: {}, body: content };
  }

  const yamlContent = match[1];
  const body = match[2] ?? '';

  // 简单的 YAML 解析（支持基本格式）
  const metadata: Record<string, unknown> = {};
  const lines = yamlContent.split('\n');
  let currentKey = '';
  let currentIndent = 0;
  let nestedObject: Record<string, unknown> | null = null;
  /* 上一个顶层键是普通标量 —— 其后缩进的续行属于它 (YAML plain scalar 折行) */
  let plainScalarKey: string | null = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    // 跳过空行和注释
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const indent = line.search(/\S/);
    const trimmedLine = line.trim();

    if (indent > 0 && plainScalarKey && typeof metadata[plainScalarKey] === 'string') {
      metadata[plainScalarKey] = `${metadata[plainScalarKey] as string} ${trimmedLine}`;
      continue;
    }
    plainScalarKey = null;

    // 检查是否是数组项
    if (trimmedLine.startsWith('- ')) {
      const value = trimmedLine.slice(2).trim().replace(/^["']|["']$/g, '');
      if (currentKey && nestedObject && nestedObject === metadata[currentKey]
          && Object.keys(nestedObject).length === 0) {
        metadata[currentKey] = [];
        nestedObject = null;
      }
      if (currentKey && Array.isArray(metadata[currentKey])) {
        (metadata[currentKey] as string[]).push(value);
      } else if (nestedObject && currentKey) {
        if (!Array.isArray(nestedObject[currentKey])) {
          nestedObject[currentKey] = [];
        }
        (nestedObject[currentKey] as string[]).push(value);
      }
      continue;
    }

    // 检查是否是键值对
    const colonIndex = trimmedLine.indexOf(':');
    if (colonIndex > 0) {
      const key = trimmedLine.slice(0, colonIndex).trim();
      const value = trimmedLine.slice(colonIndex + 1).trim();

      const block = /^([|>])([+-]?)\d*$/.exec(value);
      if (block && (indent === 0 || nestedObject)) {
        const { text, nextIndex } = readBlockScalar(lines, lineIndex + 1, indent, block[1] as '|' | '>');
        lineIndex = nextIndex - 1;
        if (indent === 0) {
          currentKey = key;
          currentIndent = 0;
          nestedObject = null;
          metadata[key] = text;
        } else if (nestedObject) {
          nestedObject[key] = text;
          currentKey = key;
        }
        continue;
      }

      if (indent === 0) {
        // 顶层键
        currentKey = key;
        currentIndent = 0;
        nestedObject = null;
        if (value !== '' && !/^["'[]/.test(value)) plainScalarKey = key;

        if (value === '') {
          // 可能是嵌套对象或数组
          metadata[key] = {};
          nestedObject = metadata[key] as Record<string, unknown>;
        } else if (value.startsWith('[') && value.endsWith(']')) {
          // 内联数组
          const arrayContent = value.slice(1, -1);
          metadata[key] = arrayContent
            .split(',')
            .map((v) => v.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean);
        } else {
          // 普通值
          metadata[key] = parseValue(value);
        }
      } else if (nestedObject) {
        // 嵌套键
        if (value === '') {
          nestedObject[key] = {};
        } else if (value.startsWith('[') && value.endsWith(']')) {
          const arrayContent = value.slice(1, -1);
          nestedObject[key] = arrayContent
            .split(',')
            .map((v) => v.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean);
        } else {
          nestedObject[key] = parseValue(value);
        }
        currentKey = key;
      }
    }
  }

  return { metadata, body };
}

/**
 * 读 YAML 块标量 (| 字面 / > 折叠) 的内容行: 从 start 起, 缩进比键深的行 (及其间的空行) 都属于它。
 * 返回拼好的文本和下一个未消费行的下标。尾部空行一律去掉 (相当于 strip, 对描述类字段足够)。
 */
function readBlockScalar(
  lines: string[],
  start: number,
  keyIndent: number,
  style: '|' | '>',
): { text: string; nextIndex: number } {
  const collected: string[] = [];
  let i = start;
  let blockIndent = -1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { collected.push(''); continue; }
    const ind = line.search(/\S/);
    if (ind <= keyIndent) break;
    if (blockIndent < 0) blockIndent = ind;
    collected.push(line.slice(Math.min(ind, blockIndent)));
  }
  while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
  if (style === '|') return { text: collected.join('\n'), nextIndex: i };
  /* 折叠: 相邻非空行用空格连, 空行变换行 */
  let text = '';
  for (const l of collected) {
    if (l === '') text += '\n';
    else text += (text && !text.endsWith('\n') ? ' ' : '') + l.trim();
  }
  return { text, nextIndex: i };
}

/**
 * 解析 YAML 值
 *
 * 不做数字转换: frontmatter 里没有哪个字段是数字, 而 `version: 1.10` 被转成 1.1、
 * `name: 2048` 被转成数字后 registry 里 `metadata.name.toLowerCase()` 直接 TypeError。
 */
function parseValue(value: string): string | boolean {
  // 移除引号
  const unquoted = value.replace(/^["']|["']$/g, '');

  // 布尔值
  if (unquoted === 'true') return true;
  if (unquoted === 'false') return false;

  return unquoted;
}

/**
 * 验证并转换元数据
 */
function validateMetadata(raw: Record<string, unknown>): SkillMetadata {
  /* 非字符串标量 (`name: true` 之类) 转成字符串 —— 下游到处 `.toLowerCase()` */
  const asText = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const name = asText(raw.name).trim();
  const description = asText(raw.description).trim();

  if (!name) {
    throw new Error('Skill metadata must have a name');
  }
  if (!description) {
    throw new Error('Skill metadata must have a description');
  }
  if (name.length > 64) {
    throw new Error('Skill name must be at most 64 characters');
  }
  const DESC_MAX = 200;
  const clampedDescription = description.length > DESC_MAX
    ? `${description.slice(0, DESC_MAX - 1).trimEnd()}…`
    : description;

  const metadata: SkillMetadata = {
    name,
    description: clampedDescription,
  };

  // 英文描述 (i18n 用) — 可选. SKILL.md 里加 description_en 字段即可.
  if (raw.description_en) {
    metadata.description_en = String(raw.description_en);
  }

  // 可选字段
  if (raw.dependencies) {
    metadata.dependencies = raw.dependencies as string;
  }
  if (raw.context) {
    metadata.context = raw.context as 'main' | 'fork';
  }
  if (raw.agent) {
    metadata.agent = raw.agent as string;
  }
  if (raw['user-invocable'] !== undefined) {
    metadata['user-invocable'] = raw['user-invocable'] as boolean;
  }

  // Hooks
  if (raw.hooks && typeof raw.hooks === 'object') {
    metadata.hooks = raw.hooks as SkillMetadata['hooks'];
  }

  if (raw.model && raw.model !== 'inherit') {
    metadata.model = raw.model as string;
  }
  if (raw.effort) {
    const effort = raw.effort as string;
    if (['low', 'medium', 'high', 'max'].includes(effort)) {
      metadata.effort = effort as SkillMetadata['effort'];
    }
  }
  if (raw.shell) {
    metadata.shell = raw.shell as 'bash' | 'powershell';
  }
  if (raw.when_to_use || raw.whenToUse) {
    metadata.whenToUse = (raw.when_to_use || raw.whenToUse) as string;
  }
  if (raw['argument-hint'] || raw.argumentHint) {
    metadata.argumentHint = (raw['argument-hint'] || raw.argumentHint) as string;
  }
  if (raw.version) {
    metadata.version = raw.version as string;
  }
  if (raw['hide-from-slash-command-tool'] === 'true' || raw.disableModelInvocation === true) {
    metadata.disableModelInvocation = true;
  }

  if (raw.paths) {
    if (Array.isArray(raw.paths)) {
      metadata.paths = raw.paths as string[];
    } else if (typeof raw.paths === 'string') {
      // 逗号分隔，支持 brace 展开 (如 "src/*.{ts,tsx}")
      metadata.paths = splitPathPatterns(raw.paths as string);
    }
  }

  // Neox 扩展
  if (raw.neox && typeof raw.neox === 'object') {
    metadata.neox = raw.neox as SkillMetadata['neox'];
  }

  return metadata;
}

function splitPathPatterns(input: string): string[] {
  const result: string[] = [];
  let current = '';
  let braceDepth = 0;

  for (const ch of input) {
    if (ch === '{') { braceDepth++; current += ch; }
    else if (ch === '}') { braceDepth--; current += ch; }
    else if (ch === ',' && braceDepth === 0) {
      const trimmed = current.trim();
      if (trimmed) result.push(trimmed);
      current = '';
    } else {
      current += ch;
    }
  }

  const trimmed = current.trim();
  if (trimmed) result.push(trimmed);
  return result;
}

/**
 * SkillLoader 类
 */
export class SkillLoader {
  /**
   * 从目录加载所有 skills
   */
  async loadFromDirectory(dir: string, source: SkillSource): Promise<Skill[]> {
    const skills: Skill[] = [];

    if (!fs.existsSync(dir)) {
      return skills;
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const skillDir = path.join(dir, entry.name);
      /* 软链的技能目录也要认 (与 registry.discoverExternalSkills 同一条教训):
       * Dirent 对软链报 isDirectory()=false, 只判它会把"统一放在 git 仓里、软链进
       * ~/.neox/skills"的技能全当不存在 —— 而且连一条 warn 都没有。statSync 跟随软链。 */
      if (!entry.isDirectory()) {
        if (!entry.isSymbolicLink()) continue;
        try {
          if (!fs.statSync(skillDir).isDirectory()) continue;  /* 链到文件 */
        } catch {
          if (source !== 'builtin') {
            cliLogger.warn('SKILLS', `Skipping broken skill symlink: ${skillDir}`);
          }
          continue;
        }
      }

      const skillFilePath = path.join(skillDir, 'SKILL.md');

      if (!fs.existsSync(skillFilePath)) continue;

      if (source === 'builtin') {
        const skill = await this.loadSkill(skillDir, entry.name, source);
        skills.push(skill);
        continue;
      }
      try {
        const skill = await this.loadSkill(skillDir, entry.name, source);
        skills.push(skill);
      } catch (error) {
        cliLogger.warn(
          'SKILLS',
          `Failed to load skill from ${skillDir}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return skills;
  }

  /**
   * 加载单个 skill
   */
  async loadSkill(
    skillDir: string,
    id: string,
    source: SkillSource
  ): Promise<Skill> {
    const skillFilePath = path.join(skillDir, 'SKILL.md');
    const content = fs.readFileSync(skillFilePath, 'utf-8');

    const supportFiles = await this.loadSupportFiles(skillDir);

    let fileIdentity: string | undefined;
    try {
      fileIdentity = fs.realpathSync(skillFilePath);
    } catch {
      fileIdentity = skillFilePath;
    }

    /* K2: 默认 trustLevel 按 source 推; .neox-skill.json 里如有 trustLevel 字段, 优先它 (K4 升级路径).
     *   读 .neox-skill.json 失败 / 无该字段 → 用默认推断, 不影响 skill 加载. */
    let trustLevel = deriveDefaultTrustLevel(source);
    try {
      const metaPath = path.join(skillDir, '.neox-skill.json');
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as { trustLevel?: 'trusted' | 'limited' };
        if (meta.trustLevel === 'trusted' || meta.trustLevel === 'limited') {
          trustLevel = meta.trustLevel;
        }
      }
    } catch { /* ignore corrupt .neox-skill.json, use default */ }

    return this.buildSkill({
      id,
      source,
      skillFilePath,
      content,
      supportFiles,
      trustLevel,
      fileIdentity,
    });
  }

  /**
   * 从内存快照加载 skills — 烘焙的内置技能走这条路 (发行版 asar 里没有 SKILL.md 明文).
   * 形状: { skillId: { 'SKILL.md': '...', 'references/x.md': '...' } }, 由 scripts/bake-skills.mjs 生成.
   *
   * 与磁盘路径的唯一差别是"文件从哪来" —— 解析/校验完全同一套 buildSkill.
   * 任何一个技能解析失败直接抛: 烘焙内容是我们自己 build 出来的, 坏了就是 build 坏了, 不吞。
   */
  loadFromSnapshot(
    snapshot: Record<string, Record<string, string>>,
    source: SkillSource,
    originLabel: string,
  ): Skill[] {
    const skills: Skill[] = [];
    for (const [id, files] of Object.entries(snapshot)) {
      const content = files['SKILL.md'];
      if (content === undefined) {
        throw new Error(`[skills] ${originLabel} 里的 "${id}" 没有 SKILL.md — 快照损坏`);
      }
      const supportFiles = new Map<string, string>();
      for (const [rel, text] of Object.entries(files)) {
        if (rel === 'SKILL.md') continue;
        supportFiles.set(rel, text);
      }
      const skillFilePath = `${originLabel}/${id}/SKILL.md`;
      skills.push(
        this.buildSkill({
          id,
          source,
          skillFilePath,
          content,
          supportFiles,
          trustLevel: deriveDefaultTrustLevel(source),
          fileIdentity: skillFilePath,
        }),
      );
    }
    return skills;
  }

  /** 解析 + 校验 SKILL.md 正文, 组装 Skill. 磁盘和烘焙快照共用, 保证两态行为一致. */
  private buildSkill(args: {
    id: string;
    source: SkillSource;
    skillFilePath: string;
    content: string;
    supportFiles: Map<string, string>;
    trustLevel: Skill['trustLevel'];
    fileIdentity: string | undefined;
  }): Skill {
    const { metadata: rawMetadata, body } = this.parseSkillFile(args.content);
    const metadata = validateMetadata(rawMetadata);
    const trimmed = body.trim();
    /* 浏览器录制 (带 neox-browser-recipe 块的) 默认不进 `/` 菜单 —— 新录的会在 frontmatter 里
     * 自己写 user-invocable: false (见 browserRecipes.renderSkillMd), 这里兜住在那之前录下的老文件,
     * 不用去改用户磁盘上的东西。文件里显式写了 true 的照它。 */
    if (metadata['user-invocable'] === undefined && trimmed.includes('```neox-browser-recipe')) {
      metadata['user-invocable'] = false;
    }

    const declaredTools = (metadata as { neox?: { allowedTools?: unknown } })?.neox?.allowedTools;
    const trustLevel = (args.source === 'workspace'
      && args.trustLevel === 'trusted'
      && Array.isArray(declaredTools) && declaredTools.length > 0)
      ? 'limited' as const
      : args.trustLevel;

    return {
      id: args.id,
      path: args.skillFilePath,
      source: args.source,
      trustLevel,
      metadata,
      content: trimmed,
      supportFiles: args.supportFiles.size > 0 ? args.supportFiles : undefined,
      fileIdentity: args.fileIdentity,
      contentLength: trimmed.length,
    };
  }

  /**
   * 解析 SKILL.md 文件内容
   */
  parseSkillFile(content: string): {
    metadata: Record<string, unknown>;
    body: string;
  } {
    return parseYamlFrontmatter(content);
  }

  /**
   * 加载支持文件
   */
  async loadSupportFiles(skillDir: string): Promise<Map<string, string>> {
    const supportFiles = new Map<string, string>();
    /* 允许递归一层子目录 (references/, scripts/, examples/) —— 对齐 Codex 家 skill 组织.
     * 子目录里的文件 key 保留相对路径 (e.g. "references/content-rules.md"), 方便 agent 引用. */
    const textExtensions = new Set([
      '.txt', '.md', '.json', '.yaml', '.yml', '.sh', '.js', '.ts', '.py', '.mjs', '.cjs',
    ]);

    const walk = (dir: string, prefix: string): void => {
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          /* 只递一层, 防跳皮子目录; 忽略隐藏 / node_modules */
          if (prefix) continue;
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          walk(full, rel);
          continue;
        }
        if (!entry.isFile()) continue;
        if (rel === 'SKILL.md') continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!textExtensions.has(ext)) continue;
        try {
          const content = fs.readFileSync(full, 'utf-8');
          supportFiles.set(rel, content);
        } catch { /* 忽略读取错误 */ }
      }
    };
    walk(skillDir, '');

    return supportFiles;
  }
}

export const skillLoader = new SkillLoader();
