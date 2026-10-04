import type { InjectWhen } from './runtimeTypes.js';

export interface QueuedInjection {
  text: string;
  timestamp: Date;
  images?: Array<{ mediaType: string; data: string; name?: string }>;
  when: InjectWhen;
}

export class InjectedMessageQueue {
  private items: QueuedInjection[] = [];

  get length(): number {
    return this.items.length;
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
