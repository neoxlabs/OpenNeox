
import type { Tool } from '../../../types/index.js';
import { block, ok, type StageResult } from '../types.js';
import type { ToolUseContext } from '../types.js';
import type { ToolUiMeta } from '../../types/toolResult.js';
import {
  withTimeout,
  withWatchdog,
  isStallTimeoutError,
  envTimeoutMs,
} from '../../../utils/stallGuard.js';

export interface ExecuteResult {
  output: string;
  success: boolean;
  durationMs: number;
  /** 双轨道分离 —— 工具返回 ToolResult 时携带给 UI 的 meta,不进 LLM */
  uiMeta?: ToolUiMeta;
}

/** 工具执行心跳阈值:执行超过此时长开始打"还在跑"日志(不打断) */
const TOOL_EXEC_WATCH_MS = envTimeoutMs('NEOX_TOOL_EXEC_WATCH_MS', 120_000);
/** 工具执行硬超时:超过此时长 abort 工具并返回 timeout(0 = 关闭硬超时) */
const TOOL_HARD_TIMEOUT_MS = envTimeoutMs('NEOX_TOOL_HARD_TIMEOUT_MS', 1_800_000);

/**
 * 组合多个 AbortSignal:任一 abort 则组合信号 abort。
 * 不依赖 AbortSignal.any(Node 20.3+ 才有), 手写以兼容 engines>=20.0.0。
 */
function combineSignals(signals: AbortSignal[]): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  for (const s of signals) {
    if (s.aborted) {
      controller.abort();
      break;
    }
    const onAbort = () => controller.abort();
    s.addEventListener('abort', onAbort, { once: true });
    listeners.push(() => s.removeEventListener('abort', onAbort));
  }
  return {
    signal: controller.signal,
    cleanup: () => { for (const off of listeners) off(); },
  };
}

export async function runExecuteStage(
  tool: Tool,
  args: Record<string, unknown>,
  ctx: ToolUseContext,
  toolCallId?: string,
): Promise<StageResult<ExecuteResult>> {
  if (ctx.signal.aborted) {
    return block('aborted', 'Aborted before tool execution started');
  }

  const start = Date.now();
  const label = `tool:${tool.name}`;

  // ── 硬超时控制器:超时即 abort 工具底层 signal, 让真正的资源(进程/请求)有机会停 ──
  const timeoutController = new AbortController();
  const { signal: effectiveSignal, cleanup: cleanupSignals } = combineSignals([
    ctx.signal,
    timeoutController.signal,
    /* 转向信号 (用户在工具跑着时插话): 与硬超时同一条路 —— 掐的是工具本身 (长命令/子进程),
     * 不是外层 run; 详见 ToolUseContext.steeringSignal 的注释。 */
    ...(ctx.steeringSignal ? [ctx.steeringSignal] : []),
  ]);

  /* Q1: per-tool timeout 粒度.
   *   Tool.timeoutMs 字段之前声明但 execute 没用. 现在生效:
   *   - 优先 tool.timeoutMs (tool 自己最清楚自己该多久, 例: git_clone 设 10min,
   *     readfile 设 30s, llm_call 子工具设 5min)
   *   - 否则 fallback 全局 TOOL_HARD_TIMEOUT_MS (env NEOX_TOOL_HARD_TIMEOUT_MS, 默认 30min)
   *   - 0 = 关闭硬超时 (tool 自己 timeoutMs=0 或 env=0)
   *
   *   这解决: 大文件 readfile 不再等 30min 才能放手, git_clone 不会被 30min 截杀,
   *   单一阈值无法同时满足"短任务快超时" + "长任务允许跑"两个矛盾需求. */
  const effectiveTimeoutMs = (typeof tool.timeoutMs === 'number' && tool.timeoutMs >= 0)
    ? tool.timeoutMs
    : TOOL_HARD_TIMEOUT_MS;
  const timeoutSource = (typeof tool.timeoutMs === 'number' && tool.timeoutMs >= 0)
    ? `tool.timeoutMs`
    : `NEOX_TOOL_HARD_TIMEOUT_MS`;

  try {
    // 内层:工具执行 + abortableRace(用户 abort / 超时 abort 都让上层链路 <50ms 解除)
    // 中层:软看门狗(执行过久打心跳, 早期可见)
    const raced = withWatchdog(
      abortableRace(
        ctx.invokeTool(tool, args, effectiveSignal, toolCallId),
        effectiveSignal,
      ),
      {
        label,
        warnAfterMs: TOOL_EXEC_WATCH_MS,
        context: { toolCallId, tool: tool.name },
      },
    );

    // 外层:硬超时兜底。超时 → 打 STALL TIMEOUT 日志 + abort 工具 + 抛 StallTimeoutError.
    // effectiveTimeoutMs = 0 时关闭硬超时 (适合 tool 自己有内部 timeout 的场景).
    const result = effectiveTimeoutMs === 0
      ? await raced
      : await withTimeout(raced, {
          label,
          timeoutMs: effectiveTimeoutMs,
          context: { toolCallId, tool: tool.name, timeoutSource },
          onTimeout: () => timeoutController.abort(),
        });

    const durationMs = Date.now() - start;
    return ok<ExecuteResult>({
      output: result.output,
      success: result.success,
      durationMs,
      uiMeta: result.uiMeta,
    });
  } catch (err: any) {
    const durationMs = Date.now() - start;

    // 硬超时:明确区分于普通 abort / 异常, 给 LLM 可读的超时原因
    if (isStallTimeoutError(err)) {
      const hint = timeoutSource === 'tool.timeoutMs'
        ? `Raise tool.timeoutMs on tool definition if this tool legitimately needs longer.`
        : `Raise NEOX_TOOL_HARD_TIMEOUT_MS env or set tool.timeoutMs on the tool definition.`;
      return block(
        'timeout',
        `Tool "${tool.name}" exceeded hard timeout ${effectiveTimeoutMs}ms (from ${timeoutSource}) and was aborted after ${durationMs}ms. ` +
          `The operation may still be running in the background. Consider breaking it into smaller steps. ` +
          hint,
      );
    }

    // 用户 abort:归类为 aborted 而不是 execution_error
    if (ctx.signal.aborted || err?.name === 'AbortError') {
      return block('aborted', `Aborted during "${tool.name}" execution after ${durationMs}ms`);
    }
    return block(
      'execution_error',
      `Tool "${tool.name}" threw: ${err?.message ?? String(err)}`,
    );
  } finally {
    cleanupSignals();
  }
}

/**
 * 把 Promise 和 AbortSignal race:一旦 signal 触发, 立刻 reject AbortError。
 * Tool 内部如果没检查 signal, 这里提供兜底:用户感知 <50ms 就取消生效。
 * Tool 自身仍可能在后台继续(Node 资源的释放由它自己管理), 但 LLM 链路不等。
 */
function abortableRace<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  // 无条件消费 inner promise 的 rejection。
  // 场景:abort 先胜利后, inner 的 tool.function 可能继续跑并抛错 —— 如果没有
  // consumer, Node 会警告 unhandled rejection。这一行静默 swallow, 同时下方的
  // .then(resolve, reject) 正常传播成功/失败给 outer。
  promise.catch(() => { /* silenced — outer promise decides */ });

  if (signal.aborted) return Promise.reject(buildAbortError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(buildAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function buildAbortError(): Error {
  const err = new Error('Operation was aborted by user');
  err.name = 'AbortError';
  return err;
}
