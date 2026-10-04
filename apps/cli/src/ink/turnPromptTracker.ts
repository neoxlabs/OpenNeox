import type { TimelineEntry } from './InkRuntime.js';

/** 不算"模型已回应"的条目: 系统告知类 + 流式中不显示的思考 */
const SILENT_TYPES = ['info', 'warning', 'error', 'header_reemit', 'interrupted', 'queued_message', 'thinking', 'reasoning'];
/** 已写进滚动区时也不算回应的 (思考一旦进了滚动区, 用户就看见了 "∴ 推理" 那一行, 算回应) */
const NOTICE_TYPES = SILENT_TYPES.filter(t => t !== 'thinking' && t !== 'reasoning');

export interface TurnPromptHost {
  staticEntries(): TimelineEntry[];
  pendingEntries(): TimelineEntry[];
  setPendingEntries(list: TimelineEntry[]): void;
  commitPendingEntry(id: number): void;
}

export class TurnPromptTracker {
  private heldId: number | null = null;
  private lastUserId: number | null = null;
  private lastUserText: string | null = null;
  private outputSinceUser = false;

  constructor(private readonly host: TurnPromptHost) {}

  isHeld(id: number): boolean {
    return id === this.heldId;
  }

  /** 用户消息已作为 pending 加入 → 扣住它 */
  hold(id: number): number {
    this.heldId = id;
    this.lastUserId = id;
    return id;
  }

  /** 记下这条条目: 用户消息 = 新一轮; 非静默条目 = 模型已回应 */
  track(entry: { type: string; message?: any }): void {
    if (entry.type === 'user') {
      const c = entry.message?.content;
      this.lastUserText = typeof c === 'string' ? c
        : Array.isArray(c) ? c.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('') : null;
      this.outputSinceUser = false;
    } else if (!SILENT_TYPES.includes(entry.type)) {
      this.outputSinceUser = true;
    }
  }

  /** addPendingEntry 入口: 模型真开口 (思考不算, 流式时不显示) → 先放行扣着的用户消息 */
  beforePendingAdd(entry: { type: string; message?: any }): void {
    if (entry.type !== 'user' && !SILENT_TYPES.includes(entry.type)) this.release();
    this.track(entry);
  }

  /** 扣着的用户消息写进滚动区 (在任何别的条目落进滚动区之前调用, 保证它排在前面) */
  release(): void {
    if (this.heldId === null) return;
    const id = this.heldId;
    this.heldId = null;
    if (this.host.pendingEntries().some(e => e.id === id)) this.host.commitPendingEntry(id);
  }

  /** 某条 pending 被提交: 是扣着的那条就只清标记, 别的就先放行扣着的 */
  beforeCommit(id: number): void {
    if (id === this.heldId) this.heldId = null;
    else this.release();
  }

  /** pending 满了被自动挤进滚动区的是扣着的那条 → 清标记 */
  onAutoCommit(id: number): void {
    if (id === this.heldId) this.heldId = null;
  }

  take(): { text: string; removed: boolean } | null {
    const text = this.lastUserText;
    this.lastUserText = null;
    const pending = this.host.pendingEntries();
    if (this.heldId !== null && pending.some(e => e.id === this.heldId)) {
      const id = this.heldId;
      this.heldId = null;
      this.host.setPendingEntries(pending.filter(e => e.id !== id && e.type !== 'thinking' && e.type !== 'reasoning'));
      return text ? { text, removed: true } : null;
    }
    /* 流式文字不全走 addEntry/addPendingEntry (有按 key 更新的通道), outputSinceUser 可能漏记 —— 以实际条目为准 */
    const since = this.lastUserId;
    const answered = this.outputSinceUser || (since !== null && (
      this.host.staticEntries().some(e => e.id > since && !NOTICE_TYPES.includes(e.type as string))
      || pending.some(e => e.id > since && !SILENT_TYPES.includes(e.type as string))));
    return !answered && text ? { text, removed: false } : null;
  }
}
