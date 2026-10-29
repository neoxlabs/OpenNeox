/**
 * LanguageParser —— 语义层的"语言适配器"接口。
 *
 * 语义层对每种语言的 *唯一* 要求：给一个文件内容，吐一个 SymbolInput 数组。
 * 怎么 parse、用什么工具（tree-sitter / LSP / babel / 土制正则），交给具体实现决定。
 *
 * 为什么是接口而不是 tree-sitter 硬编码
 * ------------------------------------
 * 1. **允许多后端共存**：TypeScript 可以用 tree-sitter；Python 可以用 LSP；
 *    Markdown 可以用 remark AST；每种语言按最合适的工具来。
 * 2. **测试友好**：单测里注入一个 InMemoryMockParser，不需要启动 tree-sitter。
 * 3. **延迟依赖**：tree-sitter 是可选 native 依赖，没装也不影响核心流程。
 *    真正的 parser 实现是 lazy-loaded 的。
 */

import type { SymbolKind } from '../types.js';
import type { SymbolInput, IdentifierUsageInput } from '../symbolStore/SymbolStore.js';

/**
 * 一次 parse 的输入。
 */
export interface ParseInput {
  /** 文件路径（用于错误信息、日志） */
  path: string;
  /** 文件内容 */
  content: string;
  /** 语言 id，e.g. 'typescript'。调用方已经决定好的 */
  language: string;
}

/**
 * 一次 parse 的输出。
 *
 * `symbols` 已经是"符号数组"的形态 —— 父子关系通过 parentIndex 建立
 *   （同一数组内的下标）。顺序应该是 "先父后子"，这样 SymbolStore 写入时
 *   能按顺序拿到父的 id。
 * `usages` 是 identifier 使用点清单，Find Usages 的原料。不是所有 parser
 *   都必须填；没填则 Find Usages 对该文件没结果。
 */
export interface ParseResult {
  symbols: SymbolInput[];
  usages?: IdentifierUsageInput[];
  /** parse 是否有错误；有错误时仍可能有部分符号可用 */
  hasErrors: boolean;
  /** 可选的诊断消息 */
  diagnostics?: Array<{ line: number; column: number; message: string }>;
}

/**
 * LanguageParser —— 语言适配器接口。
 *
 * 一个 parser 实例可以被并发调用（如果底层线程安全），但更常见的做法是
 * 每个 Worker 线程持一个 parser 实例，通过 message passing 串行使用。
 */
export interface LanguageParser {
  /** 这个 parser 处理的语言 id 列表，例如 ['typescript', 'typescriptreact'] */
  readonly languages: readonly string[];

  /**
   * 初始化。对 tree-sitter 来说这里会 load native .node + load grammar；
   * 对 LSP 来说这里会 spawn 子进程。可能抛出（native dep 没装等场景）。
   */
  init(): Promise<void>;

  /** 运行一次 parse，返回符号数组 */
  parse(input: ParseInput): Promise<ParseResult>;

  /** 释放资源，可选 */
  dispose?(): Promise<void> | void;
}

// ============================================================================
// 通用工具：根据文件扩展名猜测语言 id
// ----------------------------------------------------------------------------
// 这不是"万能检测" —— 只是兜底猜测。如果未来接入 LSP，LSP 自己会给出
// 更权威的语言 id。
// ============================================================================

const EXT_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.swift': 'swift',
  '.rb': 'ruby',
  '.php': 'php',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.cs': 'csharp',
  '.scala': 'scala',
  '.dart': 'dart',
  '.lua': 'lua',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.vue': 'vue',
  '.svelte': 'svelte',
};

export function languageFromPath(path: string): string | undefined {
  const dotIdx = path.lastIndexOf('.');
  if (dotIdx < 0) return undefined;
  const ext = path.slice(dotIdx).toLowerCase();
  return EXT_TO_LANGUAGE[ext];
}

/** 这些 kind 是 "容器型符号"，它们包含子符号 */
export function isContainerKind(kind: SymbolKind): boolean {
  return (
    kind === 'class' ||
    kind === 'interface' ||
    kind === 'enum' ||
    kind === 'namespace' ||
    kind === 'module' ||
    kind === 'package'
  );
}
