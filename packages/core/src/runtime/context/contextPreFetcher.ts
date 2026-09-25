
import fs from 'fs/promises';
import path from 'path';
import type { IndexManager } from '../../tools/smart-read/indexManager.js';
import type { FileIndex, SymbolInfo, SymbolKind } from '../../tools/smart-read/types.js';
import { modelRegistry } from '@neoxlabs/platform/models/registry/index.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

// ============================================================================
// Types
// ============================================================================

export interface RepoMapConfig {
  /** 工作目录 */
  workDir: string;
  /** IndexManager 实例（可选，没有就 fallback） */
  indexManager?: IndexManager;
  /** 当前模型名称 — 决定 token 预算 */
  modelName?: string;
}

export interface RepoMapResult {
  /** 格式化后的 repo map 文本（直接注入 system prompt） */
  map: string;
  /** 估算 tokens */
  estimatedTokens: number;
  /** 是否来自 AST 索引（false = 纯目录树 fallback） */
  fromIndex: boolean;
  /** 文件数 */
  fileCount: number;
  /** 符号数 */
  symbolCount: number;
  /** 生成耗时 ms */
  durationMs: number;
}

// ============================================================================
// Token estimation
// ============================================================================

/** 粗估 token 数（英文 ~4 char/token，CJK ~1.5 char/token） */
function estimateTokens(text: string): number {
  if (!text) return 0;
  // 大部分是代码（ASCII）→ 0.25 tokens/char
  return Math.ceil(text.length * 0.25);
}

/** 根据模型获取 repo map 可用的 token 预算 */
function getRepoMapBudget(modelName?: string): number {
  if (!modelName) return 4000; // 默认 4000 tokens

  const model = modelRegistry.getModel(modelName);
  const maxInput = model?.maxInputTokens ?? 128_000;

  // Repo map 占输入窗口的 3-5%（紧凑，始终有用）
  // 大窗口模型给更多，小窗口模型给更少
  if (maxInput >= 400_000) return 8000;   // GPT-5.x: 8000 tokens
  if (maxInput >= 200_000) return 6000;   // Claude Opus: 6000 tokens
  if (maxInput >= 128_000) return 4000;   // GPT-4o: 4000 tokens
  return 2500;                             // 小模型: 2500 tokens
}

// ============================================================================
// Symbol formatting
// ============================================================================

/** 符号类型的简写 */
const KIND_ABBR: Record<SymbolKind, string> = {
  class: 'class',
  interface: 'iface',
  function: 'fn',
  method: 'method',
  variable: 'var',
  type: 'type',
  enum: 'enum',
  constant: 'const',
};

/** 格式化单个符号 — 尽量紧凑 */
function formatSymbol(sym: SymbolInfo, indent: string): string {
  const kind = KIND_ABBR[sym.kind] || sym.kind;

  // 使用签名（如果有），否则只显示名称
  if (sym.signature) {
    // 截断过长签名
    const sig = sym.signature.length > 80
      ? sym.signature.slice(0, 77) + '...'
      : sym.signature;
    return `${indent}${kind} ${sig}`;
  }

  return `${indent}${kind} ${sym.name}`;
}

/** 格式化一个文件的符号列表 */
function formatFileSymbols(symbols: SymbolInfo[], maxSymbols: number): string {
  const lines: string[] = [];
  let count = 0;

  for (const sym of symbols) {
    if (count >= maxSymbols) {
      lines.push(`    ... +${symbols.length - count} more`);
      break;
    }

    lines.push(formatSymbol(sym, '    '));
    count++;

    // 类/接口的子符号（方法）
    if (sym.children && sym.children.length > 0) {
      const maxChildren = Math.min(sym.children.length, 5);
      for (let i = 0; i < maxChildren; i++) {
        lines.push(formatSymbol(sym.children[i], '      '));
        count++;
      }
      if (sym.children.length > maxChildren) {
        lines.push(`      ... +${sym.children.length - maxChildren} methods`);
      }
    }
  }

  return lines.join('\n');
}

// ============================================================================
// Directory tree building
// ============================================================================

interface TreeNode {
  name: string;
  isDir: boolean;
  children: Map<string, TreeNode>;
  /** 文件的符号（仅文件节点） */
  symbols?: SymbolInfo[];
  /** 文件行数 */
  totalLines?: number;
  /** 导入列表 */
  imports?: string[];
}

function buildTree(fileIndices: FileIndex[], workDir: string): TreeNode {
  const root: TreeNode = { name: '', isDir: true, children: new Map() };

  for (const fi of fileIndices) {
    const relPath = path.relative(workDir, fi.path).replace(/\\/g, '/');
    const parts = relPath.split('/');

    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;

      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          isDir: !isLast,
          children: new Map(),
        });
      }

      const node = current.children.get(part)!;
      if (isLast) {
        node.symbols = fi.symbols;
        node.totalLines = fi.totalLines;
        node.imports = fi.imports
          ?.filter(imp => !imp.module.startsWith('.') === false) // 只保留本地 import
          .map(imp => imp.module)
          .slice(0, 5);
      }

      current = node;
    }
  }

  return root;
}

/** 渲染树为文本，带 token 预算控制 */
function renderTree(
  node: TreeNode,
  prefix: string,
  budget: { remaining: number },
  maxSymbolsPerFile: number,
): string[] {
  if (budget.remaining <= 0) return [];

  const lines: string[] = [];
  const entries = Array.from(node.children.entries())
    .sort(([, a], [, b]) => {
      // 目录在前，文件在后
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  for (let i = 0; i < entries.length; i++) {
    if (budget.remaining <= 0) break;

    const [, child] = entries[i];
    const isLast = i === entries.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const nextPrefix = prefix + (isLast ? '    ' : '│   ');

    if (child.isDir) {
      // 目录
      const dirLine = `${prefix}${connector}${child.name}/`;
      lines.push(dirLine);
      budget.remaining -= estimateTokens(dirLine);

      const childLines = renderTree(child, nextPrefix, budget, maxSymbolsPerFile);
      lines.push(...childLines);
    } else {
      // 文件
      const lineInfo = child.totalLines ? ` (${child.totalLines}L)` : '';
      const fileLine = `${prefix}${connector}${child.name}${lineInfo}`;
      lines.push(fileLine);
      budget.remaining -= estimateTokens(fileLine);

      // 符号
      if (child.symbols && child.symbols.length > 0 && budget.remaining > 100) {
        const symbolText = formatFileSymbols(child.symbols, maxSymbolsPerFile);
        const symbolTokens = estimateTokens(symbolText);

        if (budget.remaining >= symbolTokens) {
          lines.push(symbolText);
          budget.remaining -= symbolTokens;
        }
      }
    }
  }

  return lines;
}

// ============================================================================
// Fallback: lightweight directory tree (no AST index)
// ============================================================================

async function buildFallbackTree(
  workDir: string,
  budget: number,
): Promise<{ text: string; fileCount: number }> {
  const CODE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go',
    '.java', '.c', '.cpp', '.h', '.hpp', '.css', '.scss',
    '.json', '.yaml', '.yml', '.toml', '.md',
  ]);

  const IGNORE_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
    'target', 'vendor', '.neox', 'coverage', '.turbo',
  ]);

  const lines: string[] = [];
  let fileCount = 0;
  let tokenCount = 0;

  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (depth > 5 || tokenCount > budget) return;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch { return; }

    // 排序：目录前，文件后
    const sorted = entries
      .filter(e => !e.name.startsWith('.') && !IGNORE_DIRS.has(e.name))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 30); // 每目录最多 30 个条目

    for (let i = 0; i < sorted.length; i++) {
      if (tokenCount > budget) break;

      const entry = sorted[i];
      const isLast = i === sorted.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const nextPrefix = prefix + (isLast ? '    ' : '│   ');

      if (entry.isDirectory()) {
        const line = `${prefix}${connector}${entry.name}/`;
        lines.push(line);
        tokenCount += estimateTokens(line);
        await walk(path.join(dir, entry.name), nextPrefix, depth + 1);
      } else if (CODE_EXTENSIONS.has(path.extname(entry.name))) {
        const line = `${prefix}${connector}${entry.name}`;
        lines.push(line);
        tokenCount += estimateTokens(line);
        fileCount++;
      }
    }
  }

  await walk(workDir, '', 0);
  return { text: lines.join('\n'), fileCount };
}

// ============================================================================
// Main: RepoMap Generator
// ============================================================================

/** 内存缓存 — 避免每轮 turn 都重新生成 */
let cachedMap: RepoMapResult | null = null;
let cachedWorkDir: string | null = null;
let cachedModelName: string | null = null;
let cachedAt = 0;
const CACHE_TTL = 60_000; // 60 秒缓存

/**
 * 生成 Repo Map
 *
 * 优先使用 IndexManager 的 AST 索引；如果索引不存在，fallback 到纯目录树。
 */
export async function generateRepoMap(config: RepoMapConfig): Promise<RepoMapResult> {
  const startMs = Date.now();

  // 检查缓存
  if (
    cachedMap &&
    cachedWorkDir === config.workDir &&
    cachedModelName === (config.modelName ?? '') &&
    Date.now() - cachedAt < CACHE_TTL
  ) {
    return { ...cachedMap, durationMs: 0 };
  }

  const budget = getRepoMapBudget(config.modelName);
  const indexManager = config.indexManager;

  let result: RepoMapResult;

  // 尝试从 AST 索引生成
  if (indexManager) {
    const hasIndex = await indexManager.hasIndex().catch(() => false);

    if (hasIndex) {
      result = await generateFromIndex(indexManager, config.workDir, budget);
    } else {
      // 索引不存在 → fallback
      result = await generateFallback(config.workDir, budget);
    }
  } else {
    result = await generateFallback(config.workDir, budget);
  }

  result.durationMs = Date.now() - startMs;

  // 更新缓存
  cachedMap = result;
  cachedWorkDir = config.workDir;
  cachedModelName = config.modelName ?? '';
  cachedAt = Date.now();

  cliLogger.info('REPO_MAP', `Generated in ${result.durationMs}ms`, {
    fromIndex: result.fromIndex,
    files: result.fileCount,
    symbols: result.symbolCount,
    tokens: result.estimatedTokens,
    budget,
  });

  return result;
}

/** 使缓存失效（文件修改时调用） */
export function invalidateRepoMapCache(): void {
  cachedMap = null;
  cachedAt = 0;
}

// ============================================================================
// 从 IndexManager 生成（精确版）
// ============================================================================

async function generateFromIndex(
  indexManager: IndexManager,
  workDir: string,
  budget: number,
): Promise<RepoMapResult> {
  // 加载所有 file indices
  const filesDir = path.join(indexManager.indexDir, 'files');
  let indexFiles: string[];
  try {
    indexFiles = await fs.readdir(filesDir);
  } catch {
    return generateFallback(workDir, budget);
  }

  const fileIndices: FileIndex[] = [];
  for (const file of indexFiles) {
    if (!file.endsWith('.json')) continue;
    try {
      const content = await fs.readFile(path.join(filesDir, file), 'utf-8');
      fileIndices.push(JSON.parse(content) as FileIndex);
    } catch { /* skip corrupt */ }
  }

  if (fileIndices.length === 0) {
    return generateFallback(workDir, budget);
  }

  // 构建树
  const tree = buildTree(fileIndices, workDir);

  // 根据预算决定每个文件显示多少符号
  let maxSymbolsPerFile: number;
  if (budget >= 8000) {
    maxSymbolsPerFile = 10;
  } else if (budget >= 5000) {
    maxSymbolsPerFile = 6;
  } else {
    maxSymbolsPerFile = 3;
  }

  // 渲染
  const header = `## 🗺️ Repo Map`;
  const headerTokens = estimateTokens(header);
  const budgetTracker = { remaining: budget - headerTokens - 50 };
  const treeLines = renderTree(tree, '', budgetTracker, maxSymbolsPerFile);
  const treeText = treeLines.join('\n');

  const fullMap = `${header}\n${treeText}`;
  const totalSymbols = fileIndices.reduce((sum, fi) => sum + fi.symbols.length, 0);

  return {
    map: fullMap,
    estimatedTokens: estimateTokens(fullMap),
    fromIndex: true,
    fileCount: fileIndices.length,
    symbolCount: totalSymbols,
    durationMs: 0,
  };
}

// ============================================================================
// Fallback 纯目录树
// ============================================================================

async function generateFallback(
  workDir: string,
  budget: number,
): Promise<RepoMapResult> {
  const header = `## 🗺️ Repo Map (目录结构)`;
  const headerTokens = estimateTokens(header);

  const { text, fileCount } = await buildFallbackTree(workDir, budget - headerTokens - 50);
  const fullMap = `${header}\n${text}`;

  return {
    map: fullMap,
    estimatedTokens: estimateTokens(fullMap),
    fromIndex: false,
    fileCount,
    symbolCount: 0,
    durationMs: 0,
  };
}
