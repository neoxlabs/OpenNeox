/**
 * Semantic Layer 类型定义
 *
 * 本模块是 Neox 的 "IDEA-like 语义层" ——  在 VFS / EditorService 之上
 * 提供符号索引、补全、跳转、引用查找、Command Palette 等高阶能力。
 *
 * 设计来源
 * --------
 * 对照 IntelliJ Platform 的三个核心概念 + 做大幅裁剪：
 *
 *   IDEA                        |  Neox 对应
 *   ---------------------------- | --------------------------------
 *   PSI (Program Structure ...)  |  tree-sitter 具体语法树 + SymbolInfo 包装
 *   StubIndex                    |  SQLite symbols 表（轻量符号摘要）
 *   FileBasedIndex               |  SQLite files 表 + chokidar 增量触发
 *   CompletionContributor        |  CompletionProvider 接口（可多 backend）
 *   CompletionWeigher            |  CompletionRanker 二次排序
 *   PsiElementFinder             |  DefinitionResolver 跨文件查符号
 *   SearchEverywhere             |  CommandPalette + FuzzyMatcher
 *
 * 核心价值
 * --------
 * 1. **全量索引 + 增量更新**：启动时用 tree-sitter 扫全工程进 SQLite；
 *    文件变动时通过 chokidar → bus 事件 → 增量重新 parse。
 * 2. **服务化**：所有能力从 SemanticService 这一个门面暴露；
 *    UI 层 (Monaco provider / Command Palette) 只跟 SemanticService 对话。
 * 3. **异步 + 分片调度**：bootstrap / 增量索引异步执行，并在批次间主动让出事件循环。
 * 4. **可插拔语言支持**：新增语言 = 新增一个 LanguageParser 实现。
 *    默认先支持 TypeScript / JavaScript，后续按需加 Python / Go / Java。
 *
 * 不变式
 * ------
 * - 所有 SymbolInfo.id 全局唯一（SQLite 自增）
 * - SymbolInfo.filePath 必须对应 files 表中 indexed=true 的一条记录
 * - 索引在 bootstrap() 完成前不对外提供查询（返回空或抛 NotReadyError）
 */

import { createServiceToken } from '../container/ServiceContainer.js';
import { createTopic } from '../bus/MessageBus.js';
import type { ServiceToken } from '../container/ServiceContainer.js';
import type { Topic } from '../bus/MessageBus.js';

// ============================================================================
// 符号种类 (SymbolKind)
// ----------------------------------------------------------------------------
// 对齐 LSP 的 SymbolKind + 少量本地扩展。用字符串 enum 方便 SQLite 存储 /
// 调试时一眼看懂，不用数字做不必要的映射。
// ============================================================================

export type SymbolKind =
  | 'file'
  | 'module'
  | 'namespace'
  | 'package'
  | 'class'
  | 'interface'
  | 'enum'
  | 'enum-member'
  | 'type-alias'
  | 'function'
  | 'method'
  | 'constructor'
  | 'property'
  | 'field'
  | 'variable'
  | 'constant'
  | 'parameter'
  | 'decorator'
  | 'import'
  | 'export'
  | 'unknown';

// ============================================================================
// 基本几何类型
// ============================================================================

/** 代码里的一个位置 —— 零起点行列 */
export interface Position {
  line: number;
  column: number;
}

/** 代码里的一个范围 —— [start, end) */
export interface Range {
  start: Position;
  end: Position;
}

/**
 * 文件定位 —— 用于跳转 / 引用 / 搜索结果等场景。
 * 故意不把 symbolId 放这里，定位是"位置"概念，不一定跟任何符号绑定。
 */
export interface FileLocation {
  filePath: string;
  range: Range;
  /** 该位置所在行的原文（可选，用于 UI 预览；不展示时可省） */
  preview?: string;
}

// ============================================================================
// 符号 / 文件 / 引用
// ============================================================================

/**
 * 符号信息 —— IDEA PSI 中 PsiNamedElement + Navigation 的 Neox 裁剪版。
 *
 * 故意不做成"完整的 AST 节点" —— 本层只负责"符号存在 + 它在哪 + 它是什么种类"，
 * 真正的 AST 节点留在 tree-sitter tree 上，需要时再按位置查回去。
 */
export interface SymbolInfo {
  /** SQLite 主键。-1 表示"尚未持久化"的临时对象（parse 中间态） */
  id: number;
  /** 符号名。e.g. "EditorService" / "handleClick" / "MAX_SIZE" */
  name: string;
  kind: SymbolKind;
  /** 符号所在文件绝对路径（workspace 相对或绝对，跟 VfsService 保持一致） */
  filePath: string;
  /** 符号"定义位置"的完整范围（整个函数 / 类体，不只是名字） */
  range: Range;
  /** 符号"名字"的精确范围（用于 rename / 高亮），可能不同于 range */
  nameRange?: Range;
  /**
   * 类型签名 / 函数签名的单行描述。e.g.
   *   "function add(a: number, b: number): number"
   *   "class EditorService implements IEditorService"
   * 展示在补全、hover、outline 里。
   */
  signature?: string;
  /** JSDoc / docstring 纯文本（Markdown 保留）。可选，用于 hover */
  documentation?: string;
  /**
   * 父符号 ID —— class 里的 method / namespace 里的 function。
   * null 表示"顶层符号"。
   */
  parentId: number | null;
  /**
   * 容器路径 —— 一个反向展开的父链，例如 "MyClass.MyInner.myMethod"。
   * 冗余存储是为了让 Command Palette 显示时不用递归查 parent。
   */
  containerName?: string;
  /** 导出修饰 —— 影响跨文件可见性，影响 ranking */
  exported?: boolean;
  /** static / async / private 等修饰，以空格分隔的字符串 */
  modifiers?: string;
}

/**
 * 文件索引条目 —— 代表"这个文件已经被索引器看到"。
 */
export interface FileInfo {
  id: number;
  path: string;
  /** 语言 id，e.g. 'typescript' / 'javascript' / 'python' */
  language: string;
  /** mtime（epoch ms），增量索引用它判断是否需要重新 parse */
  mtime: number;
  /** 内容 hash（sha1 前 16 字符足矣），mtime 相同但内容变了时兜底 */
  hash: string;
  /** 最近一次索引完成时间 */
  indexedAt: number;
  /** 该文件当前是否已被索引（false = 在队列里等，true = 已写 DB） */
  indexed: boolean;
  /** 当前文件内符号数量（冗余字段，展示进度用） */
  symbolCount: number;
}

/**
 * 引用信息 —— 某个符号的使用点。
 *
 * IDEA 里 Reference 本身是一个 PSI 子树，这里大幅裁剪为"哪个 symbol
 * 在哪个文件的哪个位置被引用"。
 */
export interface ReferenceInfo {
  id: number;
  symbolId: number;
  filePath: string;
  range: Range;
  /** 该行代码片段，UI 预览用 */
  preview?: string;
}

// ============================================================================
// 补全 / 跳转 / 搜索结果
// ============================================================================

/** 补全候选。对齐 Monaco 的 CompletionItem，再加一些内部字段用于排序 */
export interface CompletionItem {
  label: string;
  kind: SymbolKind;
  /** 展示在 label 右侧的次要信息，例如类型签名 */
  detail?: string;
  /** hover 面板的详细说明 */
  documentation?: string;
  /** 实际插入文本（可能跟 label 不同 —— 包含模板、snippets 等） */
  insertText: string;
  /**
   * 排序分 —— 越大越靠前。Monaco 自己有 sortText，我们在转换时把 score
   * 映射成倒序字符串。
   */
  score: number;
  /** 来源 backend 名，调试用 */
  source?: string;
  /** 如果是某个已索引符号的候选，带上 symbol id，点击可跳转 */
  symbolId?: number;
}

/** 跳转定义结果 */
export interface Definition {
  location: FileLocation;
  /** 如果跳到的是已索引符号，带上符号信息；否则是 LSP fallback */
  symbol?: SymbolInfo;
}

/**
 * Command Palette 搜索结果的一条。
 * "items" 可以是文件、符号、命令、action 等任何可搜索的东西 ——
 * 每一条都带 kind 区分，UI 层根据 kind 渲染不同的图标 / 预览。
 */
export interface PaletteItem {
  kind: 'file' | 'symbol' | 'command' | 'action';
  /** 展示的主文本 */
  label: string;
  /** 次要文本（path 、container、快捷键等） */
  sublabel?: string;
  /** 匹配字符下标数组，UI 可据此做高亮（fzf style） */
  matchedIndices?: number[];
  /** 排序分，越大越靠前 */
  score: number;
  /** 对应的业务数据（file path / symbol id / command id），执行时用到 */
  payload: Record<string, unknown>;
}

// ============================================================================
// 索引状态 + 进度
// ============================================================================

export type IndexingState =
  | 'idle'
  | 'bootstrapping'   // 启动扫盘
  | 'ready'            // 全量索引完成，接受增量
  | 'incremental'      // 正在处理增量
  | 'error';

export interface IndexingProgress {
  /** 当前状态 */
  state: IndexingState;
  /** 已索引文件数 */
  filesIndexed: number;
  /** 总文件数（bootstrap 后确定） */
  filesTotal: number;
  /** 累计符号数 */
  symbolsTotal: number;
  /** 当前正在处理的文件（进度展示用） */
  currentFile?: string;
  /** 如果 state === 'error'，错误信息放这里 */
  error?: string;
}

// ============================================================================
// MessageBus Topic
// ----------------------------------------------------------------------------
// SemanticService 发布两类事件：
//   - 索引生命周期事件：bootstrap 开始 / 进度 / 完成 / 报错
//   - 符号变更事件：某个文件的符号集被更新
// 订阅者包括：Command Palette UI、Outline 面板、Monaco 补全 provider 等
// ============================================================================

/**
 * Semantic 层在 MessageBus 上发布的事件接口。
 *
 * 订阅者只实现关心的方法即可，缺方法的调用会被 MessageBus 自动跳过。
 */
export interface SemanticEvents {
  /** 全量索引启动 */
  onBootstrapStarted(): void;
  /** 索引进度更新（节流 ~100ms 一次） */
  onProgress(progress: IndexingProgress): void;
  /** 全量索引完成，可对外提供查询 */
  onReady(progress: IndexingProgress): void;
  /** 某个文件的符号集被更新（增量 parse 完成后） */
  onFileIndexed(filePath: string, symbols: SymbolInfo[]): void;
  /** 某个文件被从索引里移除（文件被删 / rename 离开） */
  onFileRemoved(filePath: string): void;
  /** 索引出错（不致命，UI 应该展示但不应崩溃） */
  onError(message: string, details?: Record<string, unknown>): void;
}

/** Semantic 层在 MessageBus 上的 topic */
export const SEMANTIC_TOPIC: Topic<SemanticEvents> =
  createTopic<SemanticEvents>('ide.semantic');

// ============================================================================
// ServiceContainer Token
// ----------------------------------------------------------------------------
// 作用域 = 'workspace'：语义索引绑定到 workspace —— 切换 workspace 应该
// 重建整个 SemanticService（索引 DB 落在用户级缓存目录的 semantic/，workspace 独立）。
// ============================================================================

// 前向引用 —— SemanticService 在另一文件里定义
export const SEMANTIC_SERVICE: ServiceToken<
  import('./SemanticService.js').SemanticService
> = createServiceToken('semantic', 'workspace');
