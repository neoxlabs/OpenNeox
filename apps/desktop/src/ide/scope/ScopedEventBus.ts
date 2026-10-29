/**
 * ScopedEventBus —— 带 parent 链的事件总线
 *
 * IDEA `MessageBus` 的 JS 等价物, 跟现有 `src/ide/bus/MessageBus.ts` 是互补关系:
 *   - `MessageBus` 是 "单一根总线", app 级 + workspace 级订阅者都往一个 bus 上挂
 *   - `ScopedEventBus` 是 "按 scope 分层", 每个 ProjectScope 有自己的 bus, parent 链
 *     指向 AppScope 的 bus; 项目级 topic 只在对应 ProjectScope bus 上发布, 不会
 *     跨 project 串
 *
 * 为什么要新的一套, 不直接扩展老的 MessageBus
 * ---------------------------------------
 * 1. 老 MessageBus 被 FILES_TOPIC / EDITOR_TOPIC / RUN_MANAGER_TOPIC 等广泛使用,
 *    换签名影响面太大.
 * 2. 新的这套要支持 topic.level 强制校验 —— project 级 topic 不能在 app scope 订阅.
 * 3. 老 bus 留给 renderer 侧 (单窗口内的组件通信, 不涉及多 project 隔离).
 *    新 bus 用在 main 进程 + 跨 scope 事件路由.
 *
 * Topic level
 * -----------
 * - `'app'`: 全局事件 (theme 变更 / 插件加载 / 更新可用). 只能在 AppScope 订阅.
 * - `'project'`: 项目级事件 (run process 启动 / agent stream / terminal 输出).
 *   必须在 ProjectScope 订阅. 发布时只有同 project 的订阅者收到.
 *
 * 错误放置 level (比如在 app scope 订阅 project topic) → throw at subscribe time.
 */

/** 类型化的 listener —— interface 集合, 一个 topic 可以有多个事件方法 */
export type TopicListener = object;

/** 带 level 标签的 topic */
export interface ScopedTopic<L extends TopicListener> {
  readonly name: string;
  readonly level: 'app' | 'project';
  /** phantom type */
  readonly __listenerType?: L;
}

export function createAppTopic<L extends TopicListener>(name: string): ScopedTopic<L> {
  return { name, level: 'app' };
}
export function createProjectTopic<L extends TopicListener>(name: string): ScopedTopic<L> {
  return { name, level: 'project' };
}

export type Unsubscribe = () => void;

interface SubscriberSet {
  listeners: Set<object>;
}

export class ScopedEventBus {
  private readonly subscribers = new Map<string, SubscriberSet>();
  /**
   * scope level 标识 —— 'app' 表示这个 bus 是 AppScope 的, 'project' 表示 ProjectScope 的.
   * 用于 subscribe 时校验 topic.level 是否匹配 scope.
   */
  private readonly scopeLevel: 'app' | 'project';
  private readonly parent: ScopedEventBus | null;
  private disposed = false;

  constructor(scopeLevel: 'app' | 'project', parent: ScopedEventBus | null) {
    this.scopeLevel = scopeLevel;
    this.parent = parent;
  }

  /**
   * 订阅一个 topic.
   *
   * 校验规则:
   *   - `topic.level === 'app'` 只能在 app scope 订阅; 在 project scope 订阅会**自动转发**
   *     到 parent bus (app scope 的 bus)
   *   - `topic.level === 'project'` 只能在 project scope 订阅; 在 app scope 订阅抛错
   */
  subscribe<L extends TopicListener>(
    topic: ScopedTopic<L>,
    listener: Partial<L>,
  ): Unsubscribe {
    if (this.disposed) {
      throw new Error(`ScopedEventBus: cannot subscribe on disposed ${this.scopeLevel} bus`);
    }

    // app topic 在 project scope 订阅 → 转发到 parent (app)
    if (topic.level === 'app' && this.scopeLevel === 'project') {
      if (!this.parent) {
        throw new Error(`ScopedEventBus: app topic "${topic.name}" requires parent bus`);
      }
      return this.parent.subscribe(topic, listener);
    }

    // project topic 在 app scope 订阅 → 错误
    if (topic.level === 'project' && this.scopeLevel === 'app') {
      throw new Error(
        `ScopedEventBus: project-level topic "${topic.name}" cannot be subscribed on app scope`,
      );
    }

    // 正常订阅
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
   * 拿一个 publisher 代理. 调用 listener 任何方法都会广播给订阅者.
   *
   * 发布规则:
   *   - project topic 只在本 bus 广播 (不向 parent 上溯, 避免跨 project 串)
   *   - app topic 只在 app bus 广播
   *   - 在 project scope 上 publisher(app topic) 会自动走 parent
   */
  publisher<L extends TopicListener>(topic: ScopedTopic<L>): L {
    if (topic.level === 'app' && this.scopeLevel === 'project') {
      if (!this.parent) {
        throw new Error(`ScopedEventBus: app topic "${topic.name}" requires parent bus`);
      }
      return this.parent.publisher(topic);
    }
    if (topic.level === 'project' && this.scopeLevel === 'app') {
      throw new Error(
        `ScopedEventBus: project-level topic "${topic.name}" cannot be published on app scope`,
      );
    }

    const subscribers = this.subscribers;
    const proxy = new Proxy({} as L, {
      get(_target, method) {
        if (typeof method !== 'string') return undefined;
        return (...args: unknown[]): void => {
          const entry = subscribers.get(topic.name);
          if (!entry) return;
          // snapshot 防止 listener 里修改集合
          const snapshot = [...entry.listeners];
          for (const listener of snapshot) {
            const fn = (listener as Record<string, unknown>)[method];
            if (typeof fn === 'function') {
              try {
                (fn as (...a: unknown[]) => void).apply(listener, args);
              } catch (err) {
                console.error(
                  `[ScopedEventBus] subscriber of "${topic.name}.${method}" threw:`,
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

  subscriberCount<L extends TopicListener>(topic: ScopedTopic<L>): number {
    return this.subscribers.get(topic.name)?.listeners.size ?? 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscribers.clear();
  }
}
