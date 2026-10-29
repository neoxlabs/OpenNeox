/**
 * ModuleContext — 模块上下文生成器
 *
 * 扫描项目目录结构，用 LLM 生成每个模块的上下文文件到 .neox/modules/*.md
 * 支持三种模式：
 *   - project: 只生成 project.md
 *   - deep: project.md + 所有模块
 *   - module <path>: 指定目录
 */

import fs from 'fs/promises';
import path from 'path';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

// ============================================================================
// 类型
// ============================================================================

export type InitScope = 'project' | 'deep' | 'module';

export interface InitOptions {
  workDir: string;
  scope: InitScope;
  /** scope=module 时指定的目录路径 */
  modulePath?: string;
  /** LLM 调用函数（由调用方注入） */
  llmCall: (prompt: string, systemPrompt: string) => Promise<string>;
  /** 进度回调 */
  onProgress?: (step: string, current: number, total: number) => void;
  /** explore 任务 Agent 调用（用于 deep 模式读取目录内容） */
  exploreDir?: (dirPath: string) => Promise<string>;
  /** 最大并行数 */
  maxParallel?: number;
}

export interface InitResult {
  projectMdPath: string | null;
  modulePaths: string[];
  errors: string[];
}

// ============================================================================
// 常量
// ============================================================================

const NEOX_DIR = '.neox';
const MODULES_DIR = 'modules';
const PROJECT_MD = 'project.md';

/** 忽略的目录 */
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.neox', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.svelte-kit', '__pycache__', '.venv', 'venv',
  'target', 'vendor', '.idea', '.vscode', '.cache', 'tmp', 'temp',
]);

/** 项目检测文件 */
const PROJECT_MARKERS: Record<string, string> = {
  'package.json': 'Node.js / TypeScript',
  'go.mod': 'Go',
  'Cargo.toml': 'Rust',
  'pyproject.toml': 'Python',
  'requirements.txt': 'Python',
  'pom.xml': 'Java (Maven)',
  'build.gradle': 'Java (Gradle)',
  'Gemfile': 'Ruby',
  'composer.json': 'PHP',
  'CMakeLists.txt': 'C/C++',
};

// ============================================================================
// 主入口
// ============================================================================

export async function runInit(options: InitOptions): Promise<InitResult> {
  const { workDir, scope } = options;
  const result: InitResult = { projectMdPath: null, modulePaths: [], errors: [] };

  // 确保 .neox 目录存在
  const neoxDir = path.join(workDir, NEOX_DIR);
  await fs.mkdir(neoxDir, { recursive: true });

  if (scope === 'project' || scope === 'deep') {
    // Step 1: 生成 project.md
    options.onProgress?.('生成项目记忆', 1, scope === 'deep' ? 3 : 1);
    try {
      const projectPath = await generateProjectMd(options);
      result.projectMdPath = projectPath;
    } catch (e: any) {
      result.errors.push(`project.md: ${e.message}`);
    }
  }

  if (scope === 'deep') {
    // Step 2: 扫描关键目录
    options.onProgress?.('扫描项目结构', 2, 3);
    const dirs = await findKeyDirectories(workDir);

    // Step 3: 并行生成模块上下文
    options.onProgress?.('生成模块上下文', 3, 3);
    const modulesDir = path.join(neoxDir, MODULES_DIR);
    await fs.mkdir(modulesDir, { recursive: true });

    const maxParallel = options.maxParallel ?? 3;
    const results = await parallelMap(dirs, maxParallel, async (dir, idx) => {
      options.onProgress?.(`模块 ${dir.name}`, idx + 1, dirs.length);
      try {
        const mdPath = await generateModuleMd(options, dir.path, dir.name);
        return { path: mdPath, error: null };
      } catch (e: any) {
        return { path: null, error: `${dir.name}: ${e.message}` };
      }
    });

    for (const r of results) {
      if (r.path) result.modulePaths.push(r.path);
      if (r.error) result.errors.push(r.error);
    }
  }

  if (scope === 'module' && options.modulePath) {
    // 单模块模式
    const modulesDir = path.join(neoxDir, MODULES_DIR);
    await fs.mkdir(modulesDir, { recursive: true });

    const dirName = path.relative(workDir, options.modulePath).replace(/\//g, '-') || 'root';
    options.onProgress?.(`模块 ${dirName}`, 1, 1);
    try {
      const mdPath = await generateModuleMd(options, options.modulePath, dirName);
      result.modulePaths.push(mdPath);
    } catch (e: any) {
      result.errors.push(`${dirName}: ${e.message}`);
    }
  }

  cliLogger.info('INIT', 'Complete', {
    scope,
    project: !!result.projectMdPath,
    modules: result.modulePaths.length,
    errors: result.errors.length,
  });

  return result;
}

// ============================================================================
// project.md 生成
// ============================================================================

async function generateProjectMd(options: InitOptions): Promise<string> {
  const { workDir, llmCall } = options;

  // 收集项目信息
  const info = await collectProjectInfo(workDir);

  const systemPrompt = `你是项目文档生成器。根据提供的项目信息，生成简洁的项目记忆文件。
输出 Markdown 格式，包含以下章节：
# 项目概述（1-2 句话）
## 技术栈（列表）
## 目录结构（关键目录说明）
## 架构要点（核心设计模式、数据流）
## 开发约定（命名、代码风格、重要规则）

要求：
- 简洁，总长度不超过 200 行
- 只写确定的信息，不猜测
- 用中文`;

  const content = await llmCall(info, systemPrompt);

  const outputPath = path.join(workDir, NEOX_DIR, PROJECT_MD);
  await fs.writeFile(outputPath, content, 'utf-8');
  return outputPath;
}

async function collectProjectInfo(workDir: string): Promise<string> {
  const parts: string[] = [];

  // 检测项目类型
  for (const [file, lang] of Object.entries(PROJECT_MARKERS)) {
    try {
      const content = await fs.readFile(path.join(workDir, file), 'utf-8');
      parts.push(`## ${file} (${lang})\n${content.slice(0, 2000)}`);
      break; // 只取第一个匹配的
    } catch { /* not found */ }
  }

  // README
  for (const name of ['README.md', 'readme.md', 'README']) {
    try {
      const content = await fs.readFile(path.join(workDir, name), 'utf-8');
      parts.push(`## README\n${content.slice(0, 3000)}`);
      break;
    } catch { /* not found */ }
  }

  // 目录结构（depth=2）
  const tree = await buildTree(workDir, 2);
  parts.push(`## 目录结构\n${tree}`);

  return parts.join('\n\n');
}

// ============================================================================
// module md 生成
// ============================================================================

async function generateModuleMd(
  options: InitOptions,
  dirPath: string,
  dirName: string,
): Promise<string> {
  const { workDir, llmCall } = options;

  // 收集模块信息
  let moduleInfo: string;
  if (options.exploreDir) {
    moduleInfo = await options.exploreDir(dirPath);
  } else {
    moduleInfo = await collectModuleInfo(dirPath, workDir);
  }

  const systemPrompt = `你是代码模块文档生成器。根据提供的模块信息，生成简洁的模块上下文文件。
输出 Markdown 格式：
# {目录路径} — {一句话职责}
## 关键文件（文件名 + 一句话说明，最多 10 个）
## 核心类型/接口（名称列表）
## 依赖关系（上游/下游模块）
## 约定（该模块特有的规则）

要求：
- 极简，不超过 80 行
- 只写确定的信息
- 用中文`;

  const content = await llmCall(moduleInfo, systemPrompt);

  const outputPath = path.join(workDir, NEOX_DIR, MODULES_DIR, `${dirName}.md`);
  await fs.writeFile(outputPath, content, 'utf-8');
  return outputPath;
}

async function collectModuleInfo(dirPath: string, workDir: string): Promise<string> {
  const parts: string[] = [];
  const relative = path.relative(workDir, dirPath);
  parts.push(`目录: ${relative}`);

  // 列出文件
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const files = entries
      .filter(e => e.isFile() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort();
    const dirs = entries
      .filter(e => e.isDirectory() && !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort();

    parts.push(`文件: ${files.join(', ')}`);
    if (dirs.length > 0) parts.push(`子目录: ${dirs.join(', ')}`);
  } catch { /* skip */ }

  // 读取入口文件
  const entryFiles = ['index.ts', 'index.js', 'mod.ts', 'main.ts', 'main.go', 'lib.rs', '__init__.py'];
  for (const entry of entryFiles) {
    try {
      const content = await fs.readFile(path.join(dirPath, entry), 'utf-8');
      parts.push(`## ${entry}\n${content.slice(0, 3000)}`);
      break;
    } catch { /* not found */ }
  }

  // 读取 README（如有）
  try {
    const readme = await fs.readFile(path.join(dirPath, 'README.md'), 'utf-8');
    parts.push(`## README\n${readme.slice(0, 1500)}`);
  } catch { /* not found */ }

  return parts.join('\n\n');
}

// ============================================================================
// 工具函数
// ============================================================================

async function findKeyDirectories(workDir: string): Promise<Array<{ name: string; path: string }>> {
  const result: Array<{ name: string; path: string }> = [];

  // 查找 src/ 下的一级子目录
  const srcDir = path.join(workDir, 'src');
  try {
    const entries = await fs.readdir(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !IGNORE_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        const dirPath = path.join(srcDir, entry.name);
        const name = `src-${entry.name}`;
        result.push({ name, path: dirPath });
      }
    }
  } catch { /* no src dir */ }

  // 如果没有 src/，查找根目录下的关键目录
  if (result.length === 0) {
    const commonDirs = ['lib', 'app', 'pkg', 'cmd', 'internal', 'api', 'core', 'modules'];
    try {
      const entries = await fs.readdir(workDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && commonDirs.includes(entry.name)) {
          result.push({ name: entry.name, path: path.join(workDir, entry.name) });
        }
      }
    } catch { /* skip */ }
  }

  return result;
}

async function buildTree(dir: string, maxDepth: number, prefix = '', depth = 0): Promise<string> {
  if (depth >= maxDepth) return '';

  const lines: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const filtered = entries
      .filter(e => !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    for (let i = 0; i < filtered.length; i++) {
      const entry = filtered[i];
      const isLast = i === filtered.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';

      if (entry.isDirectory()) {
        lines.push(`${prefix}${connector}${entry.name}/`);
        const subtree = await buildTree(
          path.join(dir, entry.name), maxDepth, prefix + childPrefix, depth + 1,
        );
        if (subtree) lines.push(subtree);
      } else {
        lines.push(`${prefix}${connector}${entry.name}`);
      }
    }
  } catch { /* skip */ }

  return lines.join('\n');
}

async function parallelMap<T, R>(
  items: T[],
  maxParallel: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(maxParallel, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
