
export const SHELL_OUTPUT_HEAD_CHARS = 192 * 1024;
export const SHELL_OUTPUT_TAIL_CHARS = 64 * 1024;
/** 前台命令输出超过这个量就杀 —— 再多也只会被丢进省略号里。 */
export const SHELL_OUTPUT_HARD_KILL_CHARS = 16 * 1024 * 1024;
/** 超限后给 UI 推流的最小间隔 (内容只剩滚动的尾巴, 不必每块都推)。 */
export const SHELL_STREAM_CAPPED_INTERVAL_MS = 250;

function middleNotice(dropped: number, total: number): string {
  return `\n… [中间省略 ${dropped} 字符, 命令共输出 ${total} 字符 —— 已保留开头与结尾] …\n`;
}

/** 只保留开头 + 滚动结尾的文本累加器。append 摊还 O(块大小), 与总输出量无关。 */
export class BoundedText {
  private head = '';
  private tail = '';
  private total = 0;
  private capped = false;

  constructor(
    private readonly headCap = SHELL_OUTPUT_HEAD_CHARS,
    private readonly tailCap = SHELL_OUTPUT_TAIL_CHARS,
  ) {}

  append(text: string): void {
    if (!text) return;
    this.total += text.length;
    let rest = text;
    if (!this.capped) {
      if (this.head.length + rest.length <= this.headCap) {
        this.head += rest;
        return;
      }
      const room = this.headCap - this.head.length;
      this.head += rest.slice(0, room);
      rest = rest.slice(room);
      this.capped = true;
    }
    this.tail += rest;
    /* 攒到两倍再裁, 避免每块都复制一遍尾巴 */
    if (this.tail.length > this.tailCap * 2) this.tail = this.tail.slice(-this.tailCap);
  }

  /** 累计收到的字符数 (含已丢弃的中段)。 */
  get totalChars(): number { return this.total; }

  get isCapped(): boolean { return this.capped; }

  toString(): string {
    if (!this.capped) return this.head;
    const tail = this.tail.slice(-this.tailCap);
    const dropped = this.total - this.head.length - tail.length;
    return dropped > 0 ? this.head + middleNotice(dropped, this.total) + tail : this.head + tail;
  }
}

/** 一次性把任意长文本裁成 开头 + 结尾。 */
export function capShellText(text: string | undefined | null): string {
  if (!text) return '';
  if (text.length <= SHELL_OUTPUT_HEAD_CHARS + SHELL_OUTPUT_TAIL_CHARS) return text;
  const b = new BoundedText();
  b.append(text);
  return b.toString();
}
