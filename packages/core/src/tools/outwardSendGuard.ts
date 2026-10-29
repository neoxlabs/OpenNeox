/**
 * outwardSendGuard.ts — 以用户名义发出去的消息, 同收件人 + 同文本 2 分钟内只发一次 (S-07).
 *
 * 手机那条在 Dart (apps/mobile/lib/core/local_agent/tools/outward_send_guard.dart),
 * 电脑这条 (iMessage) 在这里。判定放在真正执行发送的那一步, 不依赖模型。
 * 发送失败不记账, 还能重试。
 */

export const OUTWARD_SEND_WINDOW_MS = 2 * 60_000;

export const DUPLICATE_SEND_MESSAGE = '2 分钟内已发过同样内容, 不要重复发送';

function keyOf(recipient: string, text: string): string {
  const who = recipient.toLowerCase().replace(/[\s\-()]/g, '');
  const what = text.replace(/\r\n/g, '\n').trim();
  return `${who}\u0000${what}`;
}

export class OutwardSendGuard {
  private readonly lastSent = new Map<string, number>();

  constructor(
    private readonly windowMs: number = OUTWARD_SEND_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** 2 分钟内发过同样的内容 (同收件人 + 同文本) → true: 拦下, 不再发 */
  isDuplicate(recipient: string, text: string): boolean {
    const at = this.lastSent.get(keyOf(recipient, text));
    if (at === undefined) return false;
    /* 时钟回拨 (at 落在未来) 也算刚发过 —— 宁可拦下, 不要重复 */
    return this.now() - at < this.windowMs;
  }

  /** 真发出去了才记 (失败不记, 允许重试) */
  remember(recipient: string, text: string): void {
    this.prune();
    this.lastSent.set(keyOf(recipient, text), this.now());
  }

  clear(): void {
    this.lastSent.clear();
  }

  private prune(): void {
    const now = this.now();
    for (const [k, at] of this.lastSent) {
      if (now - at >= this.windowMs) this.lastSent.delete(k);
    }
  }
}

/** 进程内共用一份 —— 直接调用与电脑节点 (computer.exec) 都走同一个工具实现 */
export const outwardSendGuard = new OutwardSendGuard();
