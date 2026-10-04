/**
 * Orchestrated Batch Executor — 统一批次调度
 *
 * Batch orchestration groups safe reads and serializes state-changing tools with
 * 分组 + ConcurrencyLimiter + FILE_SCOPED_WRITE_TOOLS 文件级锁 + global barrier)
 * the same path for runner and agentLoop.
 *
 * Orchestration semantics:
 *   1. 遍历 toolCalls, 按 isParallelSafe 分组:
 *        · 读类(并发安全)→ parallelCalls
 *        · 写类/其他     → serialCalls
 *      一旦遇到第一个 unsafe, 剩余全部归 serial(保持 tool_calls 顺序语义)
 *   2. Phase 1: parallelCalls 受 ConcurrencyLimiter 并发跑
 *   3. Phase 2: serialCalls 按文件级锁编排:
 *        · barrier 工具(无路径 / 非 scoped-write)  → flush 当前 scopedBatch 后单独跑
 *        · scoped 工具(write_file/edit_file 等)    → 无路径冲突可加入当前 scopedBatch 并发跑, 有冲突先 flush
 *   4. 回收所有 outcome, 按输入顺序对齐返回
 *
 * Outcomes are returned in the original tool-call order.
 */

import path from 'path';
import type { ToolCall } from '../../types/index.js';
import { orchestrateToolUse } from './orchestrate.js';
import type { ToolUseContext, ToolUseOutcome } from './types.js';
import { isParallelSafeTool } from '../parallelSafeTools.js';
import { createConcurrencyLimiter, getMaxToolConcurrency } from '../concurrencyLimiter.js';
import { parseToolArguments } from '../toolArgsParser.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { NEOX_HOME_DIRNAME } from '../../platform/neoxHome.js';

/**
 * 默认的"文件级锁"工具集(参与路径级串行/并行判定):
 *   · 相同文件调用串行
 *   · 不同文件调用可并发
 * 不在这个集合的 state-modifying 工具(如 execute_shell / run_tests / git_commit)
 * 没有可提取的"目标路径", 作为 global barrier 处理:flush 当前 scopedBatch 后独占跑。
 */
export const DEFAULT_FILE_SCOPED_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write_file', 'write',
  'edit', 'edit_file',
  'delete_file',
  'rename_file', 'move_file',
  'create_directory',
]);

/** Extract affected file paths from common argument shapes. Tools can provide
 * getAffectedResources to replace this default. */
function defaultExtractAffectedPaths(
  _toolName: string,
  args: Record<string, unknown>,
): string[] {
  const a = args as Record<string, unknown>;
  const collected: string[] = [];

  /* 单字段 */
  const singles: Array<unknown> = [
    a.file_path, a.filePath, a.path, a.file,
    a.target, a.dest, a.destination,
    a.old_path, a.new_path, a.source_path, a.destination_path,
  ];
  for (const v of singles) {
    if (typeof v === 'string' && v.length > 0) collected.push(v);
  }

  /* paths: array of strings */
  if (Array.isArray(a.paths)) {
    for (const v of a.paths) {
      if (typeof v === 'string' && v.length > 0) collected.push(v);
    }
  }

  /* hunks: [{file_path: ..., ...}, ...] — multi-file edit */
  if (Array.isArray(a.hunks)) {
    for (const h of a.hunks) {
      if (h && typeof h === 'object') {
        const hh = h as Record<string, unknown>;
        const p = hh.file_path ?? hh.filePath ?? hh.path;
        if (typeof p === 'string' && p.length > 0) collected.push(p);
      }
    }
  }

  /* contents_by_path / files_by_path: {path: content} map */
  for (const mapField of ['contents_by_path', 'files_by_path', 'files']) {
    const m = a[mapField];
    if (m && typeof m === 'object' && !Array.isArray(m)) {
      for (const key of Object.keys(m)) {
        if (key.length > 0) collected.push(key);
      }
    }
  }

  /* 去重保留顺序 */
  return Array.from(new Set(collected));
}

/** 仅测试用 — 暴露内部 defaultExtractAffectedPaths 供单测验证 */
export const defaultExtractAffectedPathsForTesting = defaultExtractAffectedPaths;

function normalizePath(raw: string, workspacePath: string | undefined): string {
  const cleaned = raw.trim();
  if (!cleaned || cleaned === '/dev/null') return '';
  const resolved = path.isAbsolute(cleaned)
    ? cleaned
    : path.resolve(workspacePath || process.cwd(), cleaned);
  const normalized = path.normalize(resolved).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

// ════════════════════════════════════════════════════════════════════════════
// 公开接口
// ════════════════════════════════════════════════════════════════════════════

export interface OrchestratedBatchOptions {
  /** 共享 orchestrate 上下文(适配器挂载/invokeTool 实现等) */
  ctx: ToolUseContext;
  /** 判定工具是否并发安全(默认使用 canonical PARALLEL_SAFE_TOOLS) */
  isParallelSafe?: (toolName: string) => boolean;
  /** 文件级锁工具集(默认 DEFAULT_FILE_SCOPED_WRITE_TOOLS) */
  fileScopedWriteTools?: ReadonlySet<string>;
  /** 从 args 提取受影响路径(默认读 file_path / path / old_path 等) */
  extractAffectedPaths?: (toolName: string, args: Record<string, unknown>) => string[];
  /** 路径标准化的 workspace 根(默认 ctx.workspacePath) */
  workspacePath?: string;
  /** 并发上限(默认 getMaxToolConcurrency(), env NEOX_MAX_TOOL_CONCURRENCY) */
  maxConcurrency?: number;
  /** 取消信号(默认 ctx.signal) */
  signal?: AbortSignal;
  /** 每个 tool 开始执行之前调用(用于计数 / onToolCallStart / tool_call 事件) */
  onBeforeEach?: (toolCall: ToolCall) => void;
  /** 每个 tool 拿到 outcome 之后立即调用(用于 onToolCallComplete / 日志) */
  onOutcome?: (outcome: ToolUseOutcome, toolCall: ToolCall) => void;
  /** 可选日志器, 用于 debug */
  logger?: { debug?: (msg: string) => void; warn?: (msg: string) => void };
}

export interface OrchestratedBatchResult {
  /** 按输入 toolCalls 顺序对齐的 outcome 列表(抓不到的不填, 不会 undefined) */
  outcomes: ToolUseOutcome[];
  /** 批次总耗时 */
  durationMs: number;
  /** 是否有 outcome.terminateLoop(HARD loop / critical risk 请求终止主循环) */
  hasForceTerminate: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// 主函数
// ════════════════════════════════════════════════════════════════════════════

export async function runOrchestratedBatch(
  toolCalls: readonly ToolCall[],
  options: OrchestratedBatchOptions,
): Promise<OrchestratedBatchResult> {
  const startedAt = Date.now();
  const {
    ctx,
    isParallelSafe = isParallelSafeTool,
    fileScopedWriteTools = DEFAULT_FILE_SCOPED_WRITE_TOOLS,
    extractAffectedPaths = defaultExtractAffectedPaths,
    workspacePath = ctx.workspacePath,
    maxConcurrency = getMaxToolConcurrency(),
    signal = ctx.signal,
    onBeforeEach,
    onOutcome,
    logger,
  } = options;

  const outcomeById = new Map<string, ToolUseOutcome>();
  const toolCallById = new Map<string, ToolCall>();
  for (const tc of toolCalls) toolCallById.set(tc.id, tc);

  // ── 内部:单 tool 执行包装, 触发 onBeforeEach/onOutcome ──
  const runOne = async (tc: ToolCall): Promise<void> => {
    try {
      onBeforeEach?.(tc);
    } catch (err: any) {
      logger?.warn?.(`[BATCH] onBeforeEach threw: ${err?.message ?? err}`);
    }
    /* runOne never rejects:
     *
     * Each failed call receives its own unsuccessful outcome so sibling calls
     * still return their real results.
     */
    let outcome: ToolUseOutcome;
    try {
      outcome = await orchestrateToolUse(tc, ctx);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      logger?.warn?.(`[BATCH] orchestrateToolUse threw for ${tc.function?.name}: ${msg}`);
      outcome = {
        toolCallId: tc.id,
        toolName: tc.function?.name ?? 'unknown',
        success: false,
        finalOutput: `Tool failed: ${msg}`,
        totalDurationMs: 0,
      } as unknown as ToolUseOutcome;
    }
    outcomeById.set(outcome.toolCallId, outcome);
    try {
      onOutcome?.(outcome, tc);
    } catch (err: any) {
      logger?.warn?.(`[BATCH] onOutcome threw: ${err?.message ?? err}`);
    }
  };

  // ── 1. 分组(parallel vs serial, hit serial 后剩余全 serial 保序) ──
  // 判定优先级:
  //   1. tool.isConcurrencySafe(args) 返回值(参数敏感, 最优先)
  //   2. 全局白名单 isParallelSafe(name)(fallback)
  //
  // 场景举例:
  //   · readfile(file, num_lines=10000)  → tool.isConcurrencySafe=false(避免并发 OOM)
  //   · readfile(file, num_lines=200)    → tool.isConcurrencySafe=true
  //   · execute_shell("ls -la")           → tool.isConcurrencySafe=true(只读 shell)
  //   · execute_shell("rm -rf /")         → tool.isConcurrencySafe=false
  const judgeParallelSafe = (tc: ToolCall): boolean => {
    const name = tc.function?.name || '';
    const nameLower = name.toLowerCase();
    const tool = ctx.tools.find((t) => t.name === name);
    // 1) 找到对应 Tool 定义, 优先看动态判定(参数敏感, 最优先)
    if (tool?.isConcurrencySafe) {
      const parsed = parseToolArguments(tc.function?.arguments || '{}', name);
      const args = parsed.ok ? (parsed.args ?? {}) : {};
      try {
        return tool.isConcurrencySafe(args);
      } catch {
        // tool 内部判定函数异常 → 保守串行
        return false;
      }
    }
    // 2) 静态标记优先 — 新工具只需在定义里写 parallelSafety: 'safe' 就生效,
    //    不必再往 PARALLEL_SAFE_TOOLS 白名单里加。
    //    注意:'unsafe' 显式拒绝,但 'safe' + isReadOnly 两种都算 safe。
    if (tool) {
      if (tool.parallelSafety === 'unsafe') return false;
      if (tool.parallelSafety === 'safe') return true;
      if (tool.isReadOnly === true) return true;
    }
    // 3) fallback 到全局 canonical 白名单(由 name 判定, 兼容旧工具)
    return isParallelSafe(nameLower);
  };

  const parallelCalls: ToolCall[] = [];
  const serialCalls: ToolCall[] = [];
  let hitSerial = false;
  for (const tc of toolCalls) {
    if (!hitSerial && judgeParallelSafe(tc)) {
      parallelCalls.push(tc);
    } else {
      hitSerial = true;
      serialCalls.push(tc);
    }
  }

  // ── 2. Phase 1: 并发读(受 maxConcurrency 限流) ──
  if (parallelCalls.length > 0) {
    const cap = Math.min(maxConcurrency, parallelCalls.length);
    logger?.debug?.(`[BATCH] parallel=${parallelCalls.length} cap=${cap}`);
    if (parallelCalls.length === 1) {
      await runOne(parallelCalls[0]);
    } else {
      // limiter 自身不再打看门狗(taskWatchMs:0)——工具级可观测性已由 execute stage
      // 的 stallGuard(120s 心跳 + 硬超时)覆盖, 避免双重日志噪音。
      const limit = createConcurrencyLimiter(maxConcurrency, { label: 'toolBatch', taskWatchMs: 0 });
      await Promise.all(parallelCalls.map((tc) => limit(() => runOne(tc))));
    }
  }

  // ── 3. Phase 2: 串行/文件锁(写类) ──
  if (serialCalls.length > 0) {
    const getWritePlan = (
      tc: ToolCall,
    ): { kind: 'barrier' } | { kind: 'scoped'; keys: string[] } => {
      const name = (tc.function?.name || '').toLowerCase();
      const tool = ctx.tools.find((t) => t.name === tc.function?.name);

      /* 路径来源优先级 (W2 接入):
       *   1. tool.getAffectedResources(args) — tool 自报 (准确覆盖复杂 args 形态)
       *   2. extractAffectedPaths(name, args) — 默认 fallback (8 字段 + hunks/paths/map)
       *
       * tool 不在 fileScopedWriteTools 白名单 + 没实现 getAffectedResources →
       * 当作 barrier (无可信路径信号, 保守串行). */

      const parsed = parseToolArguments(tc.function?.arguments || '{}', tc.function?.name);
      if (!parsed.ok) return { kind: 'barrier' };
      const args = parsed.args ?? {};

      let raw: string[];
      if (tool?.getAffectedResources) {
        try {
          raw = tool.getAffectedResources(args);
        } catch (err: any) {
          logger?.warn?.(`[BATCH] tool.getAffectedResources threw for ${name}: ${err?.message ?? err}, fallback to barrier`);
          return { kind: 'barrier' };
        }
      } else if (fileScopedWriteTools.has(name)) {
        raw = extractAffectedPaths(name, args);
      } else {
        return { kind: 'barrier' };
      }

      const keys = Array.from(
        new Set(raw.map((p) => normalizePath(p, workspacePath)).filter(Boolean)),
      ).sort();
      return keys.length > 0 ? { kind: 'scoped', keys } : { kind: 'barrier' };
    };

    const scopedBatch: ToolCall[] = [];
    const activeKeys = new Set<string>();
    const flushScoped = async () => {
      if (scopedBatch.length === 0) return;
      const batch = [...scopedBatch];
      scopedBatch.length = 0;
      activeKeys.clear();
      logger?.debug?.(`[BATCH] flush scoped=${batch.length}`);
      await Promise.all(batch.map(runOne));
    };

    /* 吞吐修复: 此前 hitSerial 后剩余调用全部逐个串行 —— 模型发
     * [read, read, edit, read, read] 这种常见"改完读回验证"batch 时, edit 之后
     * 的只读也被一个一个跑, 墙钟被结构性放大。
     * 现在串行尾巴内: **连续的 parallel-safe 段作为一组并发**执行。组间仍严格
     * 按序 (进写组前先清读组, 进读组前先清写组), 所以 read-after-write /
     * write-after-read 语义与之前完全一致, 只是组内不再排队。 */
    const safeGroup: ToolCall[] = [];
    const flushSafeGroup = async () => {
      if (safeGroup.length === 0) return;
      const batch = [...safeGroup];
      safeGroup.length = 0;
      if (batch.length === 1) {
        await runOne(batch[0]);
        return;
      }
      logger?.debug?.(`[BATCH] flush tail parallel-safe group=${batch.length}`);
      const limit = createConcurrencyLimiter(maxConcurrency, { label: 'toolBatchTail', taskWatchMs: 0 });
      await Promise.all(batch.map((tc) => limit(() => runOne(tc))));
    };

    for (const tc of serialCalls) {
      if (signal?.aborted) {
        logger?.warn?.('[BATCH] aborted, skipping remaining serial tools');
        break;
      }
      if (judgeParallelSafe(tc)) {
        /* 只读段开始前先让 pending 写落地, 保证读到的是写后内容 */
        await flushScoped();
        safeGroup.push(tc);
        continue;
      }
      /* 写/不安全调用前先清只读组 (write-after-read 保序) */
      await flushSafeGroup();
      const plan = getWritePlan(tc);
      if (plan.kind === 'barrier') {
        await flushScoped();
        await runOne(tc);
        continue;
      }
      const conflict = plan.keys.some((k) => activeKeys.has(k));
      if (conflict) {
        await flushScoped();
      }
      scopedBatch.push(tc);
      for (const k of plan.keys) activeKeys.add(k);
    }
    await flushSafeGroup();
    await flushScoped();
  }

  // ── 4. 按输入顺序还原 outcomes ──
  const outcomes: ToolUseOutcome[] = [];
  for (const tc of toolCalls) {
    const o = outcomeById.get(tc.id);
    if (o) outcomes.push(o);
  }
  const hasForceTerminate = outcomes.some((o) => o.terminateLoop);

  /* 诊断 (审计, 受 NEOX_DIAG_LOG=1): 只读沙箱下被拦的那一轮**没有
     assistant_message** (落库条目只到 file_stream/thinking 就停了), 用户看到沉默。
     要定位是不是这里 terminateLoop 把主循环打断的 —— cliLogger 在桌面运行里不落盘,
     所以直接写诊断文件。 */
  try {
    if (process.env.NEOX_DIAG_LOG === '1') {
      const blocked = outcomes.filter((o) => (o as { blockedBy?: string }).blockedBy || o.terminateLoop);
      if (blocked.length > 0) {
        fs.appendFileSync(
          nodePath.join(os.homedir(), NEOX_HOME_DIRNAME, 'logs', 'explore-debug.log'),
          `[${new Date().toISOString()}] [BATCH_BLOCKED] ${JSON.stringify({
            hasForceTerminate,
            blocked: blocked.map((o) => ({
              tool: (o as { toolName?: string }).toolName,
              blockedBy: (o as { blockedBy?: string }).blockedBy,
              terminateLoop: o.terminateLoop === true,
              reason: String((o as { reason?: string }).reason ?? '').slice(0, 160),
            })),
          })}\n`,
        );
      }
    }
  } catch { /* 诊断不拖累主路径 */ }

  return {
    outcomes,
    durationMs: Date.now() - startedAt,
    hasForceTerminate,
  };
}
