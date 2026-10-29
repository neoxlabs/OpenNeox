/**
 * Scope 平台层 —— 类型定义
 *
 * 灵感来源: IntelliJ Platform 的 `ComponentManager` + `Project` + `MessageBus`.
 *
 * 核心概念
 * --------
 * **Scope** —— 一个类似 IoC container 的对象. AppScope 是 parent (一次性, 主进程级),
 * ProjectScope 是 child (每个 BrowserWindow 一个, workspace 级). Scope 沿 parent
 * 链 fallback: project scope 找不到的 service 会向 app scope 查.
 *
 * **ServiceToken<T>** —— 类型安全的服务 ID. Token 本身是对象 (用 ref equality 在
 * WeakMap 做 hot-path cache), name 字段用于跨 bundle / hot-reload 的稳定持久化.
 *
 * **Holder<T>** —— 惰性实例化包装. IDEA `InstanceHolder` 等价物. 第一次 get 触发
 * factory, 之后直接返回缓存实例 (无锁, 读一个字段).
 *
 * **DisposableNode / onDispose** —— 每个 scope 维护一个 dispose 回调栈, scope 关闭时
 * 反向执行 (LIFO, 类似 IDEA ObjectTree bottom-up).
 *
 * 零环境依赖: 本文件不 import electron / react / node-fs. 可以跑在任何 runtime.
 */

/**
 * 服务 token —— 类型化的 service ID.
 *
 * 同一个 service class 对应一个单例 token, 约定在 `tokens.ts` 里声明.
 *
 * Token 对象**引用身份**就是它的 key —— WeakMap<Token, Holder> 用这个做 O(1) 查找,
 * 省去 string hashing. `name` 字段用于错误消息 + 跨 bundle 识别.
 */
export interface ServiceToken<T> {
  readonly name: string;
  /** phantom type — 只给 TypeScript 推导用, 运行时不存在 */
  readonly __type?: T;
}

/**
 * 创建一个服务 token.
 *
 * ```ts
 * export const AGENT_BRIDGE: ServiceToken<AgentBridge> = createServiceToken('AgentBridge');
 * ```
 */
export function createServiceToken<T>(name: string): ServiceToken<T> {
  return { name };
}

/**
 * Dispose 回调节点.
 *
 * 每个 scope 把所有 service 的 dispose 逻辑存到一个数组里, scope 关闭时反向遍历
 * (后注册的先关). 这是 IDEA ObjectTree 的简化 JS 版.
 */
export interface DisposableNode {
  /** 可以是 sync 或 async. scope.dispose() 里会 `await` 每一个. */
  fn: () => void | Promise<void>;
  /** 调试用: 标识这个 dispose 是谁注册的 (service name / location) */
  label?: string;
}
