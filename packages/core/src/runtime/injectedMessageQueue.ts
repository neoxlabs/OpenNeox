import type { AgentRuntimeEvent, InjectWhen } from './runtimeTypes.js';

export interface QueuedInjection {
  text: string;
  timestamp: Date;
  images?: Array<{ mediaType: string; data: string; name?: string }>;
  when: InjectWhen;
}

export class InjectedMessageQueue {
  private items: QueuedInjection[] = [];
  private closedForRun = false;

  get length(): number {
    return this.items.length;
  }

  get closed(): boolean {
    return this.closedForRun;
  }

  /** 新一轮开始: 重新收排队消息 */
  open(): void {
    this.closedForRun = false;
  }

  /** 过了 run-end drain: 不再收 */
  close(): void {
    this.closedForRun = true;
  }

  /** @returns 入队后的位置 (1-based) */
  push(item: QueuedInjection): number {
    this.items.push(item);
    return this.items.length;
  }

  snapshot(): QueuedInjection[] {
    return [...this.items];
  }

  takeAll(): QueuedInjection[] {
    const all = this.items;
    this.items = [];
    return all;
  }

  takeNextStep(): QueuedInjection[] {
    const now = this.items.filter((m) => m.when === 'next-step');
    if (now.length) this.items = this.items.filter((m) => m.when !== 'next-step');
    return now;
  }

  drainForContinue(emit: (event: AgentRuntimeEvent) => void): QueuedInjection[] {
    const drained = this.takeAll();
    emit({ type: 'text_complete' });
    for (const msg of drained) {
      if (msg.text) emit({ type: 'user_message_injected', text: msg.text, images: msg.images });
    }
    emit({ type: 'queued_messages_processed', count: drained.length });
    return drained;
  }

  promoteAll(): void {
    for (const m of this.items) m.when = 'next-step';
  }

  /** text = 撤指定那条 (最后一条同文本的); 不传 = 撤最后一条。摘不到 = 已被消费 → null */
  remove(text?: string): QueuedInjection | null {
    let idx = this.items.length - 1;
    if (text !== undefined) {
      idx = -1;
      for (let i = this.items.length - 1; i >= 0; i--) {
        if (this.items[i]!.text === text) { idx = i; break; }
      }
    }
    if (idx < 0) return null;
    return this.items.splice(idx, 1)[0] ?? null;
  }
}
