/**
 * Session State - 会话状态管理
 *
 * 用于 Guardrails 跨工具调用追踪，解决以下问题：
 * 1. 防止重复写入同一文件
 * 2. 检测相似路径冲突
 * 3. 追踪工具调用历史
 */

import type { RunContext } from '../types/index.js';
import { createSessionScopedStore } from './sessionScope.js';

// 惰性加载 logger（仅在 Node.js 环境中可用）
let cliLogger: any = null;
let loggerLoadAttempted = false;

function getLogger() {
  if (!loggerLoadAttempted) {
    loggerLoadAttempted = true;
    // 仅在 Node.js 环境且非 UI 模式下尝试加载
    if (typeof process !== 'undefined' && process.env && !process.env.NEOX_UI_MODE) {
      try {
        // 使用动态 import 以支持 ES modules
        import('../platform/cliLogger.js').then(module => {
          cliLogger = module.cliLogger;
        }).catch(() => {
          // 忽略浏览器环境的导入错误
        });
      } catch {
        // 忽略错误
      }
    }
  }
  return cliLogger;
}

/**
 * 编辑记录详情
 */
export interface EditRecord {
  /** 编辑的旧内容（用于检测重复编辑） */
  oldString: string;
  /** 编辑的新内容 */
  newString: string;
  /** 时间戳 */
  timestamp: number;
  /** 是否成功 */
  success: boolean;
}

/**
 *  文件读取缓存记录 - Claude Code 风格
 * 用于 edit_file 验证 old_string 必须是最近 read 内容的子串
 */
export interface FileReadCache {
  /** 文件完整内容 */
  content: string;
  /** 读取时间戳 */
  timestamp: number;
  /** 文件总行数 */
  totalLines: number;
  /** 读取的行范围 (如果是部分读取) */
  lineRange?: { start: number; end: number };
}

/**
 * 会话状态
 */
export interface SessionState {
  /** 已写入的文件 (path -> { checksum, lines, timestamp }) */
  writtenFiles: Map<string, {
    checksum: string;
    lines: number;
    timestamp: number;
  }>;

  /** 已编辑的文件 (path -> edit count) */
  editedFiles: Map<string, number>;

  /** 编辑详情记录 (path -> EditRecord[]) - 用于检测重复/幻觉编辑 */
  editDetails: Map<string, EditRecord[]>;

  /** 文件读取缓存 (path -> FileReadCache) - Claude Code 风格：edit 必须基于最近 read 的内容 */
  fileReadCache: Map<string, FileReadCache>;

  /** 工具调用历史 */
  toolCallHistory: Array<{
    name: string;
    args: Record<string, any>;
    timestamp: number;
    success: boolean;
  }>;

  /** 创建时间 */
  createdAt: number;
}

/**
 * 使用 WeakMap 存储会话状态，避免内存泄漏
 */
const sessionStates = new WeakMap<RunContext, SessionState>();

/**
 * 没有 RunContext 时的会话状态 —— 按会话分桶, 不是进程级全局。
 */
const scopedSessionStates = createSessionScopedStore<SessionState>(() => createSessionState(), { inherit: false });

/**
 * 创建新的会话状态
 */
function createSessionState(): SessionState {
  return {
    writtenFiles: new Map(),
    editedFiles: new Map(),
    editDetails: new Map(),
    fileReadCache: new Map(),
    toolCallHistory: [],
    createdAt: Date.now(),
  };
}

/**
 * 获取会话状态
 *
 * @param context - 运行时上下文（可选）
 * @returns 会话状态
 */
export function getSessionState(context?: RunContext): SessionState {
  if (context) {
    let state = sessionStates.get(context);
    if (!state) {
      state = createSessionState();
      sessionStates.set(context, state);

      //  调试日志
      if (process.env.CLI_DEBUG === '1') {
        const logger = getLogger();
        logger?.debug('SESSION', `Created NEW SessionState for context: ${Object.keys(context).join(',')}`);
      }
    } else {
      //  调试日志
      if (process.env.CLI_DEBUG === '1') {
        const logger = getLogger();
        logger?.debug('SESSION', `Retrieved EXISTING SessionState for context: ${Object.keys(context).join(',')}, history: ${state.toolCallHistory.length}`);
      }
    }
    return state;
  }

  /* Without a RunContext, use the session-scoped store instead of process-wide
   * state so file ledgers and tool history remain isolated. */
  return scopedSessionStates.get();
}

/**
 * 重置无 RunContext 那条路的会话状态。
 * 不传 scope 时只重置当前会话; 传 'all' 时全清 (测试用)。
 */
export function resetGlobalSessionState(scope?: 'all'): void {
  if (scope === 'all') scopedSessionStates.clearAll();
  else scopedSessionStates.clearScope();
}

/**
 * 记录文件写入
 */
export function recordFileWrite(
  context: RunContext | undefined,
  filePath: string,
  checksum: string,
  lines: number
): void {
  const state = getSessionState(context);
  state.writtenFiles.set(normalizePath(filePath), {
    checksum,
    lines,
    timestamp: Date.now(),
  });
}

/**
 * 记录文件编辑
 */
export function recordFileEdit(
  context: RunContext | undefined,
  filePath: string,
  oldString?: string,
  newString?: string,
  success: boolean = true
): void {
  const state = getSessionState(context);
  const normalizedPath = normalizePath(filePath);
  const currentCount = state.editedFiles.get(normalizedPath) || 0;
  state.editedFiles.set(normalizedPath, currentCount + 1);

  //  记录编辑详情（用于检测重复编辑）
  if (oldString !== undefined && newString !== undefined) {
    const records = state.editDetails.get(normalizedPath) || [];
    records.push({
      oldString,
      newString,
      timestamp: Date.now(),
      success,
    });
    // 限制每个文件最多保存 20 条编辑记录
    if (records.length > 20) {
      records.shift();
    }
    state.editDetails.set(normalizedPath, records);
  }
}

// ============================================================================
//  文件读取缓存 - Claude Code 风格
// ============================================================================

/**
 *  记录文件读取内容
 *
 * 每次 readfile 成功后调用，缓存文件内容供 edit_file 验证
 */
export function recordFileRead(
  context: RunContext | undefined,
  filePath: string,
  content: string,
  lineRange?: { start: number; end: number }
): void {
  const state = getSessionState(context);
  const normalizedPath = normalizePath(filePath);

  state.fileReadCache.set(normalizedPath, {
    content,
    timestamp: Date.now(),
    totalLines: content.split('\n').length,
    lineRange,
  });

  // 限制缓存大小，最多保留 50 个文件的读取缓存
  if (state.fileReadCache.size > 50) {
    // 删除最旧的缓存
    let oldestPath = '';
    let oldestTime = Infinity;
    for (const [path, cache] of state.fileReadCache) {
      if (cache.timestamp < oldestTime) {
        oldestTime = cache.timestamp;
        oldestPath = path;
      }
    }
    if (oldestPath) {
      state.fileReadCache.delete(oldestPath);
    }
  }
}

/**
 *  获取文件的读取缓存
 */
export function getFileReadCache(
  context: RunContext | undefined,
  filePath: string
): FileReadCache | undefined {
  const state = getSessionState(context);
  return state.fileReadCache.get(normalizePath(filePath));
}

/**
 *  验证 old_string 是否是最近读取内容的子串 - Claude Code 核心验证
 *
 * 返回:
 * - isValid: true 如果 old_string 在缓存内容中存在
 * - reason: 如果验证失败，说明原因
 * - cachedContent: 缓存的内容（用于错误提示）
 * - suggestion: 建议的修复方法
 */
export function validateOldStringAgainstCache(
  context: RunContext | undefined,
  filePath: string,
  oldString: string
): {
  isValid: boolean;
  hasCache: boolean;
  reason?: string;
  cachedContent?: string;
  cacheTimestamp?: number;
  suggestion?: string;
} {
  const state = getSessionState(context);
  const normalizedPath = normalizePath(filePath);
  const cache = state.fileReadCache.get(normalizedPath);

  if (!cache) {
    return {
      isValid: false,
      hasCache: false,
      reason: `文件 ${filePath} 尚未被读取。edit 前必须先 readfile 该文件。`,
      suggestion: `请先执行: readfile("${filePath}")`,
    };
  }

  // 检查 old_string 是否在缓存内容中
  if (cache.content.includes(oldString)) {
    return {
      isValid: true,
      hasCache: true,
      cacheTimestamp: cache.timestamp,
    };
  }

  // old_string 不在缓存中，分析原因
  const cacheAge = Math.round((Date.now() - cache.timestamp) / 1000);

  // 尝试找到最相似的内容
  const oldLines = oldString.split('\n');
  const cacheLines = cache.content.split('\n');

  // 查找第一行（忽略空白）是否存在
  const firstLineTrimmed = oldLines[0].trim();
  let foundLineIdx = -1;
  for (let i = 0; i < cacheLines.length; i++) {
    if (cacheLines[i].trim() === firstLineTrimmed) {
      foundLineIdx = i;
      break;
    }
  }

  let reason = `old_string 与 ${cacheAge} 秒前读取的文件内容不匹配。`;
  let suggestion = '';

  if (foundLineIdx >= 0) {
    // 找到了相似内容，可能是空白字符问题
    const actualFirstLine = cacheLines[foundLineIdx];
    if (oldLines[0] !== actualFirstLine) {
      reason += ` 第1行空白字符不匹配: 你的="${oldLines[0].substring(0, 50)}" vs 文件="${actualFirstLine.substring(0, 50)}"`;
      suggestion = `old_string 的缩进与文件不一致。请从 readfile 输出中精确复制，不要手动调整空白字符。`;
    } else {
      // 第一行匹配，后续行不匹配
      for (let j = 1; j < oldLines.length && (foundLineIdx + j) < cacheLines.length; j++) {
        if (oldLines[j] !== cacheLines[foundLineIdx + j]) {
          reason += ` 第${j + 1}行不匹配。`;
          break;
        }
      }
      suggestion = `请重新 readfile 文件，从输出中精确复制要替换的内容。`;
    }
  } else {
    reason += ` 未找到匹配的起始行。`;
    suggestion = `文件内容可能已更改，或 old_string 是手动输入而非从 readfile 复制。请重新 readfile("${filePath}") 获取最新内容。`;
  }

  return {
    isValid: false,
    hasCache: true,
    reason,
    cachedContent: cache.content,
    cacheTimestamp: cache.timestamp,
    suggestion,
  };
}

/**
 *  清除文件的读取缓存（文件被修改后调用）
 */
export function clearFileReadCache(
  context: RunContext | undefined,
  filePath: string
): void {
  const state = getSessionState(context);
  state.fileReadCache.delete(normalizePath(filePath));
}

/**
 *  检查是否为重复/幻觉编辑
 *
 * 检测以下情况：
 * 1. 相同的 old_string -> new_string 编辑（完全重复）
 * 2. old_string 已经在之前的编辑中被替换（幻觉编辑）
 * 3. new_string 已经存在于之前的编辑结果中（已应用）
 */
export function checkDuplicateEdit(
  context: RunContext | undefined,
  filePath: string,
  oldString: string,
  newString: string
): {
  isDuplicate: boolean;
  reason?: string;
  previousEdit?: EditRecord;
} {
  const state = getSessionState(context);
  const normalizedPath = normalizePath(filePath);
  const records = state.editDetails.get(normalizedPath) || [];

  for (const record of records) {
    // 检查 1: 完全相同的编辑（重复调用）
    if (record.oldString === oldString && record.newString === newString) {
      return {
        isDuplicate: true,
        reason: record.success
          ? '此编辑已在本会话中成功执行，无需重复'
          : '此编辑之前执行失败，请先检查文件内容',
        previousEdit: record,
      };
    }

    // 检查 2: old_string 是之前某次编辑的 new_string（幻觉：尝试编辑已修改的内容）
    // 这是最常见的幻觉模式：LLM 不知道文件已被修改
    if (record.success && record.newString === oldString) {
      return {
        isDuplicate: true,
        reason: `此内容已在 ${Math.round((Date.now() - record.timestamp) / 1000)} 秒前被修改。` +
          `原内容 "${truncateString(record.oldString, 50)}" 已被替换为 "${truncateString(record.newString, 50)}"`,
        previousEdit: record,
      };
    }

    // 检查 3: new_string 与之前的 new_string 相同（目标状态已达成）
    if (record.success && record.newString === newString && record.oldString !== oldString) {
      return {
        isDuplicate: true,
        reason: `目标内容已存在于文件中（${Math.round((Date.now() - record.timestamp) / 1000)} 秒前应用）`,
        previousEdit: record,
      };
    }
  }

  return { isDuplicate: false };
}

/**
 * 获取文件的编辑历史
 */
export function getEditHistory(
  context: RunContext | undefined,
  filePath: string
): EditRecord[] {
  const state = getSessionState(context);
  return state.editDetails.get(normalizePath(filePath)) || [];
}

/**
 * 截断字符串用于显示
 */
function truncateString(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + '...';
}

/**
 * 记录工具调用
 */
export function recordToolCall(
  context: RunContext | undefined,
  name: string,
  args: Record<string, any>,
  success: boolean
): void {
  const state = getSessionState(context);

  //  调试日志
  if (process.env.CLI_DEBUG === '1') {
    const logger = getLogger();
    logger?.debug('SESSION', `recordToolCall called:`);
    logger?.debug('SESSION', `  - tool: ${name}`);
    logger?.debug('SESSION', `  - success: ${success}`);
    logger?.debug('SESSION', `  - context exists: ${!!context}`);
    logger?.debug('SESSION', `  - context identity: ${context ? Object.keys(context).join(',') : 'none'}`);
    logger?.debug('SESSION', `  - history length before: ${state.toolCallHistory.length}`);
  }

  state.toolCallHistory.push({
    name,
    args,
    timestamp: Date.now(),
    success,
  });

  //  调试日志
  if (process.env.CLI_DEBUG === '1') {
    const logger = getLogger();
    logger?.debug('SESSION', `  - history length after: ${state.toolCallHistory.length}`);
  }

  // 限制历史记录大小
  if (state.toolCallHistory.length > 100) {
    state.toolCallHistory.shift();
  }
}

/**
 * 检查文件是否已写入
 */
export function isFileWritten(
  context: RunContext | undefined,
  filePath: string
): boolean {
  const state = getSessionState(context);
  return state.writtenFiles.has(normalizePath(filePath));
}

/**
 * 获取已写入文件的信息
 */
export function getWrittenFileInfo(
  context: RunContext | undefined,
  filePath: string
): { checksum: string; lines: number; timestamp: number } | undefined {
  const state = getSessionState(context);
  return state.writtenFiles.get(normalizePath(filePath));
}

/**
 * 查找相似路径
 *
 * 检测类似 WorkHoursTimer vs WorkHourTimer 的情况
 */
export function findSimilarPath(
  filePath: string,
  context: RunContext | undefined
): string | null {
  const state = getSessionState(context);
  const normalizedInput = normalizePath(filePath).toLowerCase();
  const inputBasename = getBasename(normalizedInput);

  for (const existingPath of state.writtenFiles.keys()) {
    const existingBasename = getBasename(existingPath.toLowerCase());

    // 计算 Levenshtein 距离
    const distance = levenshteinDistance(inputBasename, existingBasename);
    const maxLen = Math.max(inputBasename.length, existingBasename.length);

    // 相似度阈值：差异小于 20%
    if (distance > 0 && distance <= maxLen * 0.2) {
      return existingPath;
    }

    // 检查是否只是单复数差异 (Timer vs Timers, Hour vs Hours)
    if (isSingularPluralVariant(inputBasename, existingBasename)) {
      return existingPath;
    }
  }

  return null;
}

/**
 * 获取最近的工具调用
 */
export function getRecentToolCalls(
  context: RunContext | undefined,
  limit: number = 10
): SessionState['toolCallHistory'] {
  const state = getSessionState(context);

  //  调试日志
  if (process.env.CLI_DEBUG === '1') {
    const logger = getLogger();
    logger?.debug('SESSION', `getRecentToolCalls called:`);
    logger?.debug('SESSION', `  - context exists: ${!!context}`);
    logger?.debug('SESSION', `  - context identity: ${context ? Object.keys(context).join(',') : 'none'}`);
    logger?.debug('SESSION', `  - total history length: ${state.toolCallHistory.length}`);
    logger?.debug('SESSION', `  - limit: ${limit}`);
    logger?.debug('SESSION', `  - returning ${Math.min(state.toolCallHistory.length, limit)} calls`);
  }

  return state.toolCallHistory.slice(-limit);
}

/**
 * 获取特定工具的连续调用次数
 */
export function getConsecutiveToolCallCount(
  context: RunContext | undefined,
  toolName: string
): number {
  const state = getSessionState(context);
  let count = 0;

  // 从后往前数
  for (let i = state.toolCallHistory.length - 1; i >= 0; i--) {
    if (state.toolCallHistory[i].name === toolName) {
      count++;
    } else {
      break;
    }
  }

  return count;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 规范化路径
 */
function normalizePath(filePath: string): string {
  // 移除尾部斜杠，统一使用 /
  return filePath.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * 获取文件名
 */
function getBasename(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || '';
}

/**
 * 计算 Levenshtein 距离
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= a.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= b.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // 删除
        matrix[i][j - 1] + 1,      // 插入
        matrix[i - 1][j - 1] + cost // 替换
      );
    }
  }

  return matrix[a.length][b.length];
}

/**
 * 检查是否为单复数变体
 */
function isSingularPluralVariant(a: string, b: string): boolean {
  // 移除扩展名
  const aName = a.replace(/\.[^.]+$/, '');
  const bName = b.replace(/\.[^.]+$/, '');

  // 检查 s 结尾差异
  if (aName + 's' === bName || bName + 's' === aName) {
    return true;
  }

  // 检查 es 结尾差异
  if (aName + 'es' === bName || bName + 'es' === aName) {
    return true;
  }

  return false;
}
