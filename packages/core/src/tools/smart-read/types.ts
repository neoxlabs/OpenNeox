/**
 * readfile System - Type Definitions
 * 智能文件读取系统类型定义
 */

/**
 * 定位器类型 - 用于精准定位代码位置
 */
export type LocatorType = 'line' | 'pattern' | 'symbol' | 'function' | 'class' | 'range';

/**
 * 符号类型
 */
export type SymbolKind = 'function' | 'class' | 'interface' | 'method' | 'variable' | 'type' | 'enum' | 'constant';

/**
 * 行定位器 - 通过行号定位
 */
export interface LineLocator {
  type: 'line';
  start: number;
  end?: number;
}

/**
 * 模式定位器 - 通过正则表达式定位
 */
export interface PatternLocator {
  type: 'pattern';
  regex: string;
  /** 匹配第几个结果 (默认: 1) */
  matchIndex?: number;
  /** 上下文行数 */
  context?: number;
}

/**
 * 符号定位器 - 通过符号名称定位
 */
export interface SymbolLocator {
  type: 'symbol';
  name: string;
  kind?: SymbolKind;
  /** 是否模糊匹配 */
  fuzzy?: boolean;
}

/**
 * 函数定位器 - 快捷方式
 */
export interface FunctionLocator {
  type: 'function';
  name: string;
  /** 类名 (用于方法) */
  className?: string;
}

/**
 * 类定位器 - 快捷方式
 */
export interface ClassLocator {
  type: 'class';
  name: string;
}

/**
 * 范围定位器 - 通过开始/结束模式定位
 */
export interface RangeLocator {
  type: 'range';
  startPattern: string;
  endPattern: string;
}

/**
 * 统一定位器类型
 */
export type Locator =
  | LineLocator
  | PatternLocator
  | SymbolLocator
  | FunctionLocator
  | ClassLocator
  | RangeLocator;

/**
 * 智能读取选项
 */
export interface SmartReadOptions {
  /** 文件路径 */
  path: string;
  /** 定位器 */
  locator?: Locator;
  /** 读取模式 */
  mode?: 'full' | 'chunk' | 'smart';
  /** 小文件自动 full 读取阈值 (行数) */
  autoFullThreshold?: number;
  /** 块大小 (默认: 200) */
  chunkSize?: number;
  /** 上下文扩展行数 (默认: 10) */
  expandContext?: number;
  /** 最大读取行数 */
  maxLines?: number;
  /** 是否使用索引 (如果可用) */
  useIndex?: boolean;
}

/**
 * 读取结果
 */
export interface ReadResult {
  /** 是否成功 */
  success: boolean;
  /** 文件路径 */
  path: string;
  /** 文件总行数 */
  totalLines: number;
  /** 读取的起始行 */
  startLine: number;
  /** 读取的结束行 */
  endLine: number;
  /** 内容 (带行号, 给模型看) */
  content: string;
  /** 展示区域的原始文本 (无行号)。给 readLedger 存证据 + edit 做区域校验/重定位, 免得为拿原文重读整文件。 */
  raw?: string;
  /** 是否被截断 */
  truncated: boolean;
  /** 使用的策略 */
  strategy: 'index' | 'grep' | 'chunk' | 'full';
  /** 额外信息 */
  metadata?: {
    /** 匹配的符号信息 */
    symbol?: SymbolInfo;
    /** grep 匹配行 */
    matchedLine?: number;
    /** 模块信息 */
    module?: string;
  };
  /** 错误信息 */
  error?: string;
}

/**
 * 符号信息 (来自索引或解析)
 */
export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  signature?: string;
  docstring?: string;
  /** 所属类/模块 */
  parent?: string;
  /** 子符号 (如类的方法) */
  children?: SymbolInfo[];
}

/**
 * 文件索引
 */
export interface FileIndex {
  /** 文件路径 */
  path: string;
  /** 文件哈希 (用于检查是否过期) */
  hash: string;
  /** 最后修改时间 */
  mtime: number;
  /** 总行数 */
  totalLines: number;
  /** 符号列表 */
  symbols: SymbolInfo[];
  /** 导入语句 */
  imports: Array<{ module: string; line: number; names?: string[] }>;
  /** 导出语句 */
  exports: Array<{ name: string; line: number; kind?: SymbolKind }>;
}

/**
 * 索引元信息
 */
export interface IndexMetadata {
  /** 索引版本 */
  version: string;
  /** 创建时间 */
  createdAt: number;
  /** 最后更新时间 */
  updatedAt: number;
  /** 索引的文件数 */
  fileCount: number;
  /** 索引的符号数 */
  symbolCount: number;
  /** 支持的语言 */
  languages: string[];
  /** 索引目录 */
  indexDir: string;
}

/**
 * 索引配置
 */
export interface IndexConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 是否自动提示构建 */
  autoPrompt: boolean;
  /** 支持的语言 */
  languages: string[];
  /** 包含的文件模式 */
  include: string[];
  /** 排除的路径 */
  exclude: string[];
  /** 缓存目录 */
  cacheDir: string;
  /** 最大文件大小 (MB) */
  maxFileSize: number;
}

/**
 * 索引构建结果
 */
export interface IndexBuildResult {
  success: boolean;
  filesIndexed: number;
  symbolsFound: number;
  timeMs: number;
  errors: Array<{ file: string; error: string }>;
}

/**
 * 符号搜索结果
 */
export interface SymbolSearchResult {
  symbol: SymbolInfo;
  file: string;
  score: number; // 匹配分数
}

/**
 * 语言解析器接口
 */
export interface LanguageParser {
  /** 支持的语言 ID */
  languageId: string;
  /** 支持的文件扩展名 */
  extensions: string[];
  /** 解析文件并提取符号 */
  parse(content: string, filePath: string): Promise<SymbolInfo[]>;
  /** 构建符号匹配模式 */
  buildSymbolPattern(name: string, kind?: SymbolKind): string;
}

/**
 * 默认配置
 */
export const DEFAULT_INDEX_CONFIG: IndexConfig = {
  enabled: false,
  autoPrompt: true,
  languages: ['typescript', 'javascript', 'python', 'java', 'go', 'rust'],
  include: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.py', '**/*.java', '**/*.go', '**/*.rs'],
  exclude: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/__pycache__/**', '**/target/**', '**/vendor/**'],
  cacheDir: '.neox/index',
  maxFileSize: 5, // 5MB
};

export const DEFAULT_CHUNK_SIZE = 300;
export const DEFAULT_CONTEXT_LINES = 10;
export const MAX_CHUNK_SIZE = 4000;
export const DEFAULT_FULL_READ_THRESHOLD = 2000;
