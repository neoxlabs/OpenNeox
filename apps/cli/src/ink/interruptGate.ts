import { requestInputPrefill } from './inputPrefill.js';
import { getLanguage } from '../i18n/index.js';

export type UnansweredPrompt = { text: string; removed: boolean } | null;

export interface InterruptHost {
  takeUnansweredPrompt(): UnansweredPrompt;
  discardUnshownStreams(): void;
  finalizeStreams(): void;
  addEntry(entry: { type: any; text: string }): void;
}

export class InterruptGate {
  /** esc 之后到下一条用户消息之前: 丢弃在途的流式 delta */
  closed = false;

  constructor(private readonly host: InterruptHost) {}

  begin(): UnansweredPrompt {
    const r = this.host.takeUnansweredPrompt();
    if (r?.removed) this.host.discardUnshownStreams();
    else this.host.finalizeStreams();
    this.closed = true;
    return r;
  }

  finish(unanswered: UnansweredPrompt): void {
    let zh = false;
    try { zh = getLanguage() === 'zh'; } catch { /* */ }
    if (unanswered && unanswered.text.trim()) requestInputPrefill(unanswered.text);
    if (unanswered?.removed) return;
    this.host.addEntry({
      type: 'interrupted',
      text: unanswered
        ? (zh ? '已中断 · 消息已放回输入框' : 'Interrupted · message restored to the input')
        : (zh ? '已中断 · 接下来要怎么做?' : 'Interrupted · what should Neox do instead?'),
    });
  }

  reset(): void {
    this.closed = false;
  }
}
