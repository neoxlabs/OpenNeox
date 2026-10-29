import { useDeferredValue, useRef } from 'react';
import type { TimelineEntry } from '../../../utils/workspaceUtils';

/**
 * 判定"这一次变化是不是用户刚按下发送" —— 抽成纯函数以便测试
 * (仓库没装 @testing-library/react, 也不为一个判定引整套渲染测试依赖)。
 *
 * 判据是**尾部新增了一条 user_message**: 长度增长 + 尾部 id 变了 + 尾部是 user_message。
 * 三个条件缺一不可 —— 只看"尾部是 user_message"会把"内容更新但没新增"也算进来,
 * 只看"长度增长"会把历史回捞算进来。
 */
export function isUserJustSent(
  prevLen: number,
  prevTailId: string | undefined,
  next: TimelineEntry[],
): boolean {
  const tail = next[next.length - 1];
  if (!tail || tail.type !== 'user_message') return false;
  if (next.length <= prevLen) return false;
  return tail.id !== prevTailId;
}

export function useTimelineEventsForMapping(
  timelineEvents: TimelineEntry[],
  /** 当前会话 id —— 换会话时必须绕过 defer, 见下面注释 */
  sessionId?: string | null,
): TimelineEntry[] {
  const deferred = useDeferredValue(timelineEvents);
  const lastLenRef = useRef(timelineEvents.length);
  const lastTailIdRef = useRef<string | undefined>(undefined);

  const justSent = isUserJustSent(lastLenRef.current, lastTailIdRef.current, timelineEvents);
  lastLenRef.current = timelineEvents.length;
  lastTailIdRef.current = timelineEvents[timelineEvents.length - 1]?.id;

  const lastSessionRef = useRef<string | null | undefined>(sessionId);
  const pendingSwitchRef = useRef(false);
  if (sessionId !== lastSessionRef.current) {
    lastSessionRef.current = sessionId;
    pendingSwitchRef.current = true;
  }
  if (deferred === timelineEvents) pendingSwitchRef.current = false;

  /* 用户刚按下发送 / 刚换会话 ⇒ 绕过 defer 立刻上屏 */
  return justSent || pendingSwitchRef.current ? timelineEvents : deferred;
}
