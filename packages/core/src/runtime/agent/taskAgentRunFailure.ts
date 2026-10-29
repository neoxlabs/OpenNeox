import type { AgentRuntimeEvent, RunTaskResult } from '../runtimeTypes.js';
import { appendDiagLog } from './diagLogFile.js';

function normalizeMessage(message?: string | null): string | undefined {
  const normalized = message?.trim();
  return normalized ? normalized : undefined;
}

/* 将错误事件完整序列化到控制台和诊断日志，保留分类、堆栈及错误字段；非错误 status 事件不记录。 */
function logTaskAgentErrorEvent(tag: string, event: AgentRuntimeEvent) {
  let payload: any = null;
  try {
    /* 序列化时给 Error 对象友好处理 (默认 JSON.stringify 会丢 name/message/stack) */
    const safe = JSON.stringify(event, (_k, v) => {
      if (v instanceof Error) {
        return {
          __error_name: v.name,
          __error_message: v.message,
          __error_stack: v.stack,
          __error_cause: (v as any).cause,
        };
      }
      return v;
    }, 2);
    payload = safe;
    console.error(`[TASK_AGENT_ERR/${tag}]`, safe);
  } catch (e) {
    /* 序列化兜底, 至少打可见字段 */
    payload = {
      type: (event as any).type,
      message: (event as any).message,
      status: (event as any).status,
      keys: Object.keys(event as any),
    };
    console.error(`[TASK_AGENT_ERR/${tag}]`, payload);
  }
  appendDiagLog(`TASK_AGENT_ERR/${tag}`, payload);
}

/* 按 error_classified、error、status/error 的顺序保存错误原因，并用内部优先级标记防止通用事件覆盖具体原因。 */
const PRIORITY_PREFIX = '\x01P';
const PRIORITY_CLASSIFIED = 3;
const PRIORITY_ERROR = 2;
const PRIORITY_STATUS = 1;

function encodeWithPriority(message: string, priority: number): string {
  return `${PRIORITY_PREFIX}${priority}:${message}`;
}
function decodePriority(marked?: string): { priority: number; message: string } {
  if (!marked) return { priority: 0, message: '' };
  if (marked.startsWith(PRIORITY_PREFIX)) {
    const rest = marked.slice(PRIORITY_PREFIX.length);
    const colonIdx = rest.indexOf(':');
    if (colonIdx > 0) {
      const priority = parseInt(rest.slice(0, colonIdx), 10);
      if (!Number.isNaN(priority)) {
        return { priority, message: rest.slice(colonIdx + 1) };
      }
    }
  }
  return { priority: 0, message: marked };
}
/** 外部消费方 (resolveTaskAgentRunError 之外任何地方) 拿到 raw runtimeError 后调这个剥掉优先级前缀. */
export function stripCapturedErrorPriority(marked?: string): string | undefined {
  if (!marked) return marked;
  return decodePriority(marked).message || undefined;
}

function updateWithPriority(
  event: AgentRuntimeEvent,
  current: string | undefined,
  incomingPriority: number,
  tag: string,
): string | undefined {
  logTaskAgentErrorEvent(tag, event);
  const message = normalizeMessage((event as any).message);
  if (!message) return current;

  const { priority: currentPriority } = decodePriority(current);
  /* 严格大于才覆盖 — 同级不覆盖, 保留首个 (先到 = 距真实错因更近). */
  if (incomingPriority > currentPriority) {
    return encodeWithPriority(message, incomingPriority);
  }
  return current;
}

export function captureTaskAgentRuntimeError(
  event: AgentRuntimeEvent,
  current?: string,
): string | undefined {
  if (event.type === 'error_classified') {
    return updateWithPriority(event, current, PRIORITY_CLASSIFIED, 'classified');
  }

  if (event.type === 'error') {
    return updateWithPriority(event, current, PRIORITY_ERROR, 'error');
  }

  if (event.type === 'status' && event.status === 'error') {
    return updateWithPriority(event, current, PRIORITY_STATUS, 'status');
  }

  return current;
}

/** agentRuntimeHost 使用的中断状态标签；下游在解析原因时将其与真实错误原因分开。 */
export const INTERRUPT_STATUS_LABEL = 'Task interrupted';

/**
 * 把 `Task interrupted` / `Task interrupted: <真正的原因>` 归一成"真正的原因"。
 *   · 只有标签 → undefined (等于没有错因, 别再往下游传)
 *   · 标签 + 原因 → 只留原因
 *   · 压根不是这个标签 → 原样返回
 */
export function stripInterruptLabel(message?: string): string | undefined {
  const text = normalizeMessage(message);
  if (!text) return undefined;
  if (text === INTERRUPT_STATUS_LABEL) return undefined;
  if (text.startsWith(`${INTERRUPT_STATUS_LABEL}:`)) {
    return normalizeMessage(text.slice(INTERRUPT_STATUS_LABEL.length + 1));
  }
  return text;
}

export function resolveTaskAgentRunError(
  summary: Pick<RunTaskResult, 'failed' | 'interrupted' | 'output'>,
  runtimeError: string | undefined,
  defaultMessage: string,
): string | null {
  const outputMessage = normalizeMessage(summary.output);
  if (summary.interrupted) {
    /* interrupted 只表示本轮未完成；保留捕获到的真实原因，使调用方区分可重试的传输故障和主动停止。 */
    const cause = stripInterruptLabel(stripCapturedErrorPriority(runtimeError));
    return cause ? `aborted: ${cause}` : 'aborted';
  }
  /* runtimeError 从 captureTaskAgentRuntimeError 出来带内部 \x01P<priority>: 前缀, 剥掉 */
  const cleanRuntimeError = stripCapturedErrorPriority(runtimeError);
  if (summary.failed) {
    return normalizeMessage(cleanRuntimeError)
      || outputMessage
      || defaultMessage;
  }
  if (cleanRuntimeError) {
    return cleanRuntimeError;
  }

  if (outputMessage && /^error\s*:/i.test(outputMessage)) {
    return outputMessage.replace(/^error\s*:\s*/i, '') || defaultMessage;
  }
  return null;
}
