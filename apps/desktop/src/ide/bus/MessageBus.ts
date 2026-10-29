/**
 * MessageBus — 类型化 pub/sub 事件总线
 *
 * 灵感来源：IntelliJ Platform 的 MessageBus + Topic 模型。
 *
 * 设计目标
 * --------
 * 1. **类型安全**：Topic 是一个接口，订阅者实现这个接口；
 *    没有 string-based event name 撞车的风险。
 * 2. **多方法 topic**：一个 topic 可以包含多个事件方法，
 *    例如 FileEvents = { onCreated, onChanged, onDeleted }。
 *    订阅者只实现关心的方法即可，缺方法的方法调用会被自动跳过。
 * 3. **错误隔离**：一个订阅者的方法抛出错误不会影响其他订阅者。
 * 4. **零依赖**：纯 JS，可同时跑在 renderer / main / cli / 测试环境。
 *
 * 与 EventEmitter / Node 事件的区别
 * --------------------------------
 * - 事件名是类型化的（topic 接口的方法名），不是字符串。
 * - 一个订阅者可以一次性订阅一个 topic 下的所有事件。
 * - 不依赖 Node 的 events 模块。
 *
 * 用法
 * ----
 * ```ts
 * interface FileEvents {
 *   onCreated(path: string): void
 *   onChanged(path: string): void
 *   onDeleted(path: string): void
 * }
 * const FILE_TOPIC = createTopic<FileEvents>('files')
 *
 * const bus = new MessageBus()
 *
 * // 订阅
 * bus.subscribe(FILE_TOPIC, {
 *   onChanged(path) { console.log('changed', path) },
 *   // 不实现 onCreated / onDeleted 也没关系
 * })
 *
 * // 发布
 * bus.publisher(FILE_TOPIC).onChanged('/foo.ts')
 * ```
 */

import type { ServiceToken } from '../container/ServiceContainer.js';
import { createServiceToken } from '../container/ServiceContainer.js';

/**
 * 一个 Topic 的 listener 类型 —— 一个声明了若干事件方法的 object。
 *
 * 约束放到 `object` 而不是 `Record<string, fn>`，因为 TS 的 interface 没有隐式
 * 索引签名，无法满足 Record 约束。`object` 可以接受 interface / type / 字面量
 * 三种写法，是事件总线泛型约束的标准做法。
 *
 * 我们不在类型层强制"必须是方法的集合" — 这一层是类型化糖，运行时由 Proxy
 * 完成实际调度，调用一个不存在的方法会被静默跳过（见 publisher 实现）。
 */
export type TopicListener = object;

export interface Topic<L extends TopicListener> {
  readonly name: string;
  /** phantom type — 仅供编译期推导 */
  readonly __listenerType?: L;
}

/** 创建一个类型化 topic。约定 name 用 'category' 形式，例如 'files'、'editor.documents' */
export function createTopic<L extends TopicListener>(name: string): Topic<L> {
  return { name };
}

/** 取消订阅函数 */
export type Unsubscribe = () => void;

interface SubscriberSet {
  listeners: Set<object>;
}

export class MessageBus {
  private readonly subscribers = new Map<string, SubscriberSet>();

  /**
   * 订阅一个 topic。返回一个取消订阅的函数。
   * 同一个 listener 对象重复 subscribe 同一个 topic 是幂等的（Set 去重）。
   */
  subscribe<L extends TopicListener>(topic: Topic<L>, listener: Partial<L>): Unsubscribe {
    let entry = this.subscribers.get(topic.name);
    if (!entry) {
      entry = { listeners: new Set() };
      this.subscribers.set(topic.name, entry);
    }
    entry.listeners.add(listener);
    return () => {
      entry!.listeners.delete(listener);
      if (entry!.listeners.size === 0) {
        this.subscribers.delete(topic.name);
      }
    };
  }

  /**
   * 拿一个发布者代理 — 调任何方法都会广播给所有订阅者。
   *
   * - 如果某个订阅者没有实现该方法，会被自动跳过（不会抛 undefined is not a function）
   * - 一个订阅者抛出的错误不会影响其他订阅者，错误会被打到 console
   */
  publisher<L extends TopicListener>(topic: Topic<L>): L {
    const subscribers = this.subscribers;
    const proxy = new Proxy({} as L, {
      get(_target, method) {
        if (typeof method !== 'string') return undefined;
        return (...args: unknown[]): void => {
          const entry = subscribers.get(topic.name);
          if (!entry) return;
          // 复制一份避免 listener 在回调里修改集合时迭代异常
          const snapshot = [...entry.listeners];
          for (const listener of snapshot) {
            const fn = (listener as Record<string, unknown>)[method];
            if (typeof fn === 'function') {
              try {
                (fn as (...a: unknown[]) => void).apply(listener, args);
              } catch (err) {
                console.error(
                  `[MessageBus] subscriber of "${topic.name}.${method}" threw:`,
                  err,
                );
              }
            }
          }
        };
      },
    });
    return proxy;
  }

  /** 当前 topic 的订阅者数量（用于调试 / 测试） */
  subscriberCount<L extends TopicListener>(topic: Topic<L>): number {
    return this.subscribers.get(topic.name)?.listeners.size ?? 0;
  }

  /** 清空所有订阅 */
  clear(): void {
    this.subscribers.clear();
  }
}

/**
 * MessageBus 在 ServiceContainer 中的 token。
 * 作用域 = 'app'：整个应用共用一根总线 —— 跨 workspace 切换不应该丢事件
 * 订阅链路。VFS / Editor / Project View 等都注册到这同一根上，保证它们
 * 之间能互通。
 */
export const MESSAGE_BUS: ServiceToken<MessageBus> = createServiceToken<MessageBus>(
  'bus',
  'app',
);
