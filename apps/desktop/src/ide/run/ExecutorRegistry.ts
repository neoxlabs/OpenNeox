/**
 * ExecutorRegistry —— "启动方式" 注册表 (Run / Debug / Coverage / ...)
 *
 * 相比 ConfigurationType 这一层更薄 —— executor 只是一组 metadata (id +
 * displayName + icon), 没有 factory 和 instance 的概念. 但我们仍然做成
 * registry, 这样 v1.x 加 Coverage / Profile 时不用动核心代码.
 *
 * 内置的 RUN / DEBUG 两个 executor 由 renderer 启动时调 registerBuiltIns()
 * 注入. (不在这里 hardcode —— 让纯平台层保持跟具体 id 无关)
 */

import type { MessageBus } from '../bus/MessageBus.js';
import { EXECUTORS_TOPIC } from './types.js';
import type { Executor } from './types.js';

export interface ExecutorRegistryOptions {
  bus: MessageBus;
}

export type ExecutorUnregister = () => void;

export class ExecutorRegistry {
  private readonly entries = new Map<string, Executor>();
  private readonly order: string[] = [];
  private readonly bus: MessageBus;

  constructor(options: ExecutorRegistryOptions) {
    this.bus = options.bus;
  }

  register(executor: Executor): ExecutorUnregister {
    if (this.entries.has(executor.id)) {
      throw new Error(`Executor "${executor.id}" already registered`);
    }
    this.entries.set(executor.id, executor);
    this.order.push(executor.id);
    this.bus.publisher(EXECUTORS_TOPIC).onRegistered(executor);
    return () => {
      if (this.entries.get(executor.id) === executor) {
        this.entries.delete(executor.id);
        const idx = this.order.indexOf(executor.id);
        if (idx >= 0) this.order.splice(idx, 1);
        this.bus.publisher(EXECUTORS_TOPIC).onUnregistered(executor.id);
      }
    };
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): Executor | undefined {
    return this.entries.get(id);
  }

  /** 按注册顺序返回 —— 通常是 [run, debug, ...] */
  list(): Executor[] {
    return this.order.map((id) => this.entries.get(id)!).filter(Boolean);
  }
}
