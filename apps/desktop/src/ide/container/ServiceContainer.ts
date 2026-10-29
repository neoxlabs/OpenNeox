/**
 * ServiceContainer — 类型化服务容器
 *
 * 灵感来源：IntelliJ Platform 的 PicoContainer / Light Service。
 *
 * 设计目标
 * --------
 * 1. **解耦取代 props drilling**：组件 / 服务之间通过 token 取依赖，
 *    不再把所有状态顶在 WorkspacePage 头上一层层往下传。
 * 2. **两层作用域**：
 *      - 'app'       全局单例（应用启动到关闭）
 *      - 'workspace' 跟随当前 workspace（切换 workspace 时整层重建）
 * 3. **lazy 实例化**：服务在第一次 get 时才创建，启动开销可控。
 * 4. **父子链查找**：workspace 层取不到时，回退查 app 层。
 * 5. **零依赖**：本文件没有 React / Electron / Node API，
 *    可以同时跑在 renderer / main / cli / 测试环境。
 *
 * 与 IDEA 的差异
 * --------------
 * - 不做反射 DI（JS 不需要）；factory 函数显式拿到 container 自己解析依赖。
 * - 没有 Disposable 树，但 register 时可以传 disposer，dispose() 会调用。
 *
 * 用法
 * ----
 * ```ts
 * const APP = new ServiceContainer()
 * APP.register(LOGGER, () => new ConsoleLogger())
 *
 * const WORKSPACE = APP.createChild()
 * WORKSPACE.register(EDITOR, c => new EditorService(c.get(LOGGER)))
 *
 * const editor = WORKSPACE.get(EDITOR) // 同时拿到 LOGGER
 * await WORKSPACE.dispose() // 只 dispose workspace 层，APP 不受影响
 * ```
 */

/** 服务作用域 */
export type ServiceScope = 'app' | 'workspace';

/**
 * 类型化的服务 token。
 * `__type` 字段只用于 TS 推导，运行时不存在。
 */
export interface ServiceToken<T> {
  readonly id: string;
  readonly scope: ServiceScope;
  /** phantom type — 仅供编译期推导 */
  readonly __type?: T;
}

/**
 * 创建一个类型化的 service token。
 * 约定：id 用 'category.name' 形式，例如 'editor.documents'。
 */
export function createServiceToken<T>(
  id: string,
  scope: ServiceScope = 'workspace',
): ServiceToken<T> {
  return { id, scope };
}

export type ServiceFactory<T> = (container: ServiceContainer) => T;

/** 单个服务的释放函数 — register 时按需提供 */
export type ServiceDisposer<T> = (instance: T) => void | Promise<void>;

interface ServiceEntry {
  factory: ServiceFactory<unknown>;
  instance?: unknown;
  hasInstance: boolean;
  disposer?: ServiceDisposer<unknown>;
  scope: ServiceScope;
}

export class ServiceContainer {
  private readonly entries = new Map<string, ServiceEntry>();
  private readonly parent?: ServiceContainer;
  private disposed = false;

  constructor(parent?: ServiceContainer) {
    this.parent = parent;
  }

  /**
   * 注册一个服务工厂。
   *
   * 服务在第一次 `get` 时才被实例化（lazy）。
   * 同一个 token 在同一个容器只能注册一次（重复注册抛错，避免静默覆盖）。
   *
   * 如果传入 disposer，dispose() 时会被调用（仅当服务已被实例化时）。
   */
  register<T>(
    token: ServiceToken<T>,
    factory: ServiceFactory<T>,
    disposer?: ServiceDisposer<T>,
  ): void {
    this.assertNotDisposed();
    if (this.entries.has(token.id)) {
      throw new Error(`Service "${token.id}" already registered in this container`);
    }
    this.entries.set(token.id, {
      factory: factory as ServiceFactory<unknown>,
      hasInstance: false,
      scope: token.scope,
      disposer: disposer as ServiceDisposer<unknown> | undefined,
    });
  }

  /**
   * 取服务。如果当前容器没有，会沿 parent 链查找。
   * 都找不到时抛错（不返回 undefined，避免静默 bug）。
   */
  get<T>(token: ServiceToken<T>): T {
    this.assertNotDisposed();
    const entry = this.entries.get(token.id);
    if (entry) {
      if (!entry.hasInstance) {
        entry.instance = entry.factory(this);
        entry.hasInstance = true;
      }
      return entry.instance as T;
    }
    if (this.parent) return this.parent.get(token);
    throw new Error(`Service "${token.id}" not registered`);
  }

  /**
   * 安全版本：服务不存在时返回 undefined。
   * 仅在你真的可以处理"服务不存在"的情况时使用。
   */
  tryGet<T>(token: ServiceToken<T>): T | undefined {
    if (this.disposed) return undefined;
    const entry = this.entries.get(token.id);
    if (entry) {
      if (!entry.hasInstance) {
        entry.instance = entry.factory(this);
        entry.hasInstance = true;
      }
      return entry.instance as T;
    }
    return this.parent?.tryGet(token);
  }

  /** 仅检查注册（不会触发实例化） */
  has<T>(token: ServiceToken<T>): boolean {
    if (this.entries.has(token.id)) return true;
    return this.parent?.has(token) ?? false;
  }

  /**
   * 创建子容器（典型用法：为 workspace 创建一个继承自 app 的子容器）。
   * 子容器可以注册新服务，也可以"覆盖"父容器同 id 的服务（但不修改父容器）。
   */
  createChild(): ServiceContainer {
    this.assertNotDisposed();
    return new ServiceContainer(this);
  }

  /**
   * 释放本容器拥有的所有已实例化的服务（不影响 parent）。
   * 反向 dispose（后注册的先释放），任何 disposer 抛出的错误会被收集，
   * 全部 dispose 完成后一起抛出 — 保证一个错的服务不会卡住其他服务。
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const errors: unknown[] = [];
    const reversed = [...this.entries.values()].reverse();
    for (const entry of reversed) {
      if (entry.hasInstance && entry.disposer) {
        try {
          await entry.disposer(entry.instance);
        } catch (err) {
          errors.push(err);
        }
      }
    }
    this.entries.clear();
    if (errors.length > 0) {
      const messages = errors.map((e) => (e instanceof Error ? e.message : String(e)));
      throw new Error(`ServiceContainer dispose errors:\n  - ${messages.join('\n  - ')}`);
    }
  }

  /** 当前容器（不含 parent）已注册的 service id 列表，主要用于调试 */
  listLocalIds(): string[] {
    return [...this.entries.keys()];
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('ServiceContainer has been disposed');
  }
}
