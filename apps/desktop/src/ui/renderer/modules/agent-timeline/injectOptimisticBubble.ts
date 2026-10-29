
import { useEffect } from 'react';

/** 乐观气泡的 id 前缀 —— 引擎侧按它认领 */
export const OPTIMISTIC_INJECT_ID_PREFIX = 'msg-injected-local-';

export const INJECT_OPTIMISTIC_EVENT = 'neox:inject-optimistic';
export const INJECT_OPTIMISTIC_DROP_EVENT = 'neox:inject-optimistic-drop';

export interface InjectOptimisticDetail {
  sessionId: string;
  entryId: string;
  text: string;
}

/** 一次插话一个 id。带随机段: 同一句话连插两次要能各自成为独立气泡。 */
export function newOptimisticInjectId(): string {
  return `${OPTIMISTIC_INJECT_ID_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 按下插话 → 立刻落气泡。抛不出去不该挡住真正的插话, 所以整体 try 掉。 */
export function emitOptimisticInject(detail: InjectOptimisticDetail): void {
  try {
    window.dispatchEvent(new CustomEvent(INJECT_OPTIMISTIC_EVENT, { detail }));
  } catch { /* 事件系统不可用: 退化成"气泡晚点出现", 不影响消息本身 */ }
}

/** 没排上 / 被拒 / 改走普通发送 → 撤掉气泡, 不留用户没说过的假记录。 */
export function emitOptimisticInjectDrop(sessionId: string, entryId: string): void {
  try {
    window.dispatchEvent(new CustomEvent(INJECT_OPTIMISTIC_DROP_EVENT, {
      detail: { sessionId, entryId },
    }));
  } catch { /* 同上 */ }
}

/** 时间线条目里跟认领有关的那部分 (不依赖 TimelineEntry 全量类型, 这层只读三个字段) */
type ClaimableEntry = { id?: unknown; type?: unknown; detail?: unknown; injectedConfirmed?: unknown };

/**
 * 引擎那条事件该认领哪个已有气泡 —— 返回它的 id, 没有就 null (调用方照旧 append).
 *
 * 为什么按文本匹配而不是按 id: 事件里没有本地 id, 也不该为这个去改协议。
 * 同一句话连插两次时会有两条乐观气泡, 第一条事件认领第一条、第二条认领第二条 ——
 * 从前往后找即可, 顺序对得上。
 */
export function findClaimableOptimisticInject(
  entries: readonly ClaimableEntry[] | undefined,
  text: string,
): string | null {
  if (!entries || !text) return null;
  for (const e of entries) {
    if (typeof e.id === 'string'
      && e.id.startsWith(OPTIMISTIC_INJECT_ID_PREFIX)
      && e.type === 'user_message'
      && e.injectedConfirmed !== true
      && e.detail === text) {
      return e.id;
    }
  }
  return null;
}

/* ── 两端的接线 ──────────────────────────────────────────────────────────
 * 整块都放这里, 调用处各只剩一行 —— NeoxRuntimeBridge 和 useStreamHandler 都已经到
 * 文件大小棘轮的上限 (那两个文件是"改一处要手写四遍"的量级)。
 */

type AppendEntry = (sessionId: string | null | undefined, entry: any, forceSync?: boolean) => unknown;
type DeleteEntry = ((sessionId: string, entryId: string) => unknown) | undefined;

export function useOptimisticInjectBubbles(append: AppendEntry, remove: DeleteEntry): void {
  useEffect(() => {
    const onAdd = (e: Event) => {
      const d = ((e as CustomEvent).detail ?? {}) as Partial<InjectOptimisticDetail>;
      if (!d.sessionId || !d.entryId || !d.text) return;
      append(d.sessionId, {
        id: d.entryId,
        type: 'user_message',
        title: 'User',
        detail: d.text,
        timestamp: Date.now(),
        pending: false,
        injectedConfirmed: false,
        messageSource: 'desktop',
      }, true);
    };
    const onDrop = (e: Event) => {
      const d = ((e as CustomEvent).detail ?? {}) as Partial<InjectOptimisticDetail>;
      if (!d.sessionId || !d.entryId) return;
      void remove?.(d.sessionId, d.entryId);
    };
    window.addEventListener(INJECT_OPTIMISTIC_EVENT, onAdd);
    window.addEventListener(INJECT_OPTIMISTIC_DROP_EVENT, onDrop);
    return () => {
      window.removeEventListener(INJECT_OPTIMISTIC_EVENT, onAdd);
      window.removeEventListener(INJECT_OPTIMISTIC_DROP_EVENT, onDrop);
    };
  }, [append, remove]);
}

/**
 * 引擎那条 user_message_injected 的前半段: 能认领就认领, 返回 true 表示调用方不要再 append.
 *
 * 认领 = 原地更新那条乐观气泡 (保留它的位置和 sequence), 而不是新建一条 —— 引擎侧的
 * 时间戳跟本地 id 对不上, 无条件 append 就是同一句话两个气泡。
 */
export function claimOptimisticInject(opts: {
  sessionId: string;
  text: string;
  timestamp: number;
  messageSource: string;
  attachments?: InjectedImageAttachment[];
  entriesFor: (sessionId: string) => readonly ClaimableEntry[] | undefined;
  update: (sessionId: string, entryId: string, patch: Record<string, unknown>, forceSync?: boolean) => void;
}): boolean {
  const claimed = findClaimableOptimisticInject(opts.entriesFor(opts.sessionId), opts.text);
  if (!claimed) return false;
  opts.update(opts.sessionId, claimed, {
    injectedConfirmed: true,
    messageSource: opts.messageSource,
    ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
  }, true);
  return true;
}

export const QUEUE_SETTLE_EVENT_TYPES: ReadonlySet<string> = new Set(['user_message_injected', 'queued_message_removed']);

export interface InjectedImageAttachment {
  id: string;
  type: 'image';
  name: string;
  mediaType: string;
  data: string;
}

export function injectedImagesToAttachments(
  images: ReadonlyArray<{ mediaType?: string; data?: string; name?: string }> | undefined,
  stamp: number,
): InjectedImageAttachment[] {
  const out: InjectedImageAttachment[] = [];
  (images ?? []).forEach((img, i) => {
    if (typeof img?.data !== 'string' || !img.data) return;
    const mediaType = img.mediaType || 'image/png';
    out.push({
      id: `injected-img-${stamp}-${i}`,
      type: 'image',
      name: img.name || 'image.png',
      mediaType,
      data: img.data.startsWith('data:') ? img.data : `data:${mediaType};base64,${img.data}`,
    });
  });
  return out;
}

/**
 * 把一条被引擎消费掉的插话消息落到时间线上 —— 认领已有的乐观气泡, 没有就新建.
 *
 * 整段从 useStreamHandler 的 user_message_injected 分支搬过来 (那个文件到棘轮上限了),
 * 顺带让"认领"和"新建"这两条路只有一处定义。
 */
export function settleInjectedMessage(opts: {
  sessionId: string;
  text: string;
  timestamp: number;
  isBackgroundTaskNotification: boolean;
  images?: ReadonlyArray<{ mediaType?: string; data?: string; name?: string }>;
  entriesFor: (sessionId: string) => readonly ClaimableEntry[] | undefined;
  update: (sessionId: string, entryId: string, patch: Record<string, unknown>, forceSync?: boolean) => void;
  append: AppendEntry;
}): void {
  const { sessionId, text, timestamp } = opts;
  const messageSource = opts.isBackgroundTaskNotification ? 'system-background-task' : 'desktop';
  const attachments = injectedImagesToAttachments(opts.images, timestamp);
  const claimed = claimOptimisticInject({
    sessionId, text, timestamp, messageSource, attachments,
    entriesFor: opts.entriesFor,
    update: opts.update,
  });
  if (claimed) return;
  opts.append(sessionId, {
    id: `msg-injected-${timestamp}-${text.slice(0, 12)}`,
    type: 'user_message',
    title: 'User',
    detail: text,
    ...(attachments.length ? { attachments } : {}),
    timestamp,
    pending: false,
    messageSource,
  }, true);
}
