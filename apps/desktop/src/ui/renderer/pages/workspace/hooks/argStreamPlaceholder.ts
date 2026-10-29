
import type { TimelineEntry } from '../../../utils/workspaceUtils';

export const PLACEHOLDER_ID_PREFIX = 'timeline-tool-streaming';

export function isUnclaimedArgStreamPlaceholder(entry: TimelineEntry): boolean {
  return entry.type === 'tool_call'
    && entry.streaming === true
    && !entry.toolArgs
    && typeof entry.id === 'string'
    && entry.id.startsWith(PLACEHOLDER_ID_PREFIX);
}

/** 流式重试时要作废的条目: 本轮里还没生成完的调用 (重试会从头重新生成它们) */
export function supersededOnRetry(timeline: TimelineEntry[]): TimelineEntry[] {
  return timeline.filter((e) => e.pending === true && isUnclaimedArgStreamPlaceholder(e));
}

export function unclaimedAtRunEndPatch(
  run: { interrupted?: boolean },
  zh: boolean,
  reason?: string,
): Partial<TimelineEntry> {
  const base = { pending: false, streaming: false, success: false } as Partial<TimelineEntry>;
  if (run.interrupted) {
    return {
      ...base, type: 'tool_error' as TimelineEntry['type'],
      errorReason: 'interrupted', interrupted: true,
      errorMessage: zh ? '已停止, 这条命令还没生成完, 没有执行' : 'Stopped before this call was fully generated — it did not run',
    } as Partial<TimelineEntry>;
  }
  const why = reason?.trim();
  return {
    ...base, type: 'tool_error' as TimelineEntry['type'], level: 'error',
    errorReason: 'error',
    errorMessage: zh
      ? `模型还没把这条调用生成完就中断了, 没有执行${why ? `: ${why}` : ' (原因见本轮错误)'}`
      : `The model was cut off before finishing this call — it did not run${why ? `: ${why}` : ' (see the turn error)'}`,
  } as Partial<TimelineEntry>;
}

export function runEndToolCallPatch(
  prev: TimelineEntry,
  run: { interrupted?: boolean; failed?: boolean },
  zh: boolean,
): Partial<TimelineEntry> {
  const keepMsg = (prev as { errorMessage?: string }).errorMessage;
  if (run.interrupted) {
    return {
      type: 'tool_error' as TimelineEntry['type'], pending: false, success: false, level: 'error',
      errorReason: 'interrupted', interrupted: true,
      errorMessage: keepMsg || (zh ? '本轮已中断' : 'Turn interrupted'),
    } as Partial<TimelineEntry>;
  }
  if (run.failed) {
    return {
      type: 'tool_error' as TimelineEntry['type'], pending: false, success: false, level: 'error',
      errorReason: prev.errorReason || '运行失败',
      errorMessage: keepMsg || (zh ? '本轮运行失败, 这个工具没有返回结果' : 'The turn failed before this tool returned'),
    } as Partial<TimelineEntry>;
  }
  return { type: 'tool_result', pending: false, success: prev.success ?? true };
}
