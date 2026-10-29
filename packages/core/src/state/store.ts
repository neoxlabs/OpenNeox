/**
 * 通用状态容器：通过不可变更新管理任意状态形状，并集中触发变更副作用。
 *
 * Store 使用 Object.is 跳过无变化通知，使用 Set 管理订阅者，并通过 batch
 * 将一组更新合并为一次副作用和订阅通知。
 */

type Listener = () => void;
type OnChange<T> = (args: { newState: T; oldState: T }) => void;

export interface Store<T> {
  /** 获取当前状态（只读快照） */
  getState: () => T;
  /** 不可变更新 — 传入 (prev) => next 更新函数 */
  setState: (updater: (prev: T) => T) => void;
  /** 订阅状态变化，返回取消订阅函数 */
  subscribe: (listener: Listener) => () => void;
  /** 批量更新 — 多次 setState 合并为一次通知 */
  batch: (fn: () => void) => void;
  /** 获取订阅者数量（调试用） */
  getListenerCount: () => number;
}

/**
 * 创建 Store 实例
 * @param initialState 初始状态
 * @param onChange 每次状态变化时的回调（用于集中处理副作用）
 */
export function createStore<T>(
  initialState: T,
  onChange?: OnChange<T>,
): Store<T> {
  let state = initialState;
  const listeners = new Set<Listener>();
  let batchDepth = 0;
  let batchDirty = false;
  let batchOldState: T | null = null;

  function getState(): T {
    return state;
  }

  function setState(updater: (prev: T) => T): void {
    const oldState = state;
    const newState = updater(oldState);

    // 相同状态不触发通知，避免无效渲染和副作用。
    if (Object.is(newState, oldState)) return;

    state = newState;

    if (batchDepth > 0) {
      // 批量模式只记录首个旧状态，直到外层 batch 结束再通知。
      if (!batchDirty) {
        batchOldState = oldState;
        batchDirty = true;
      }
      return;
    }

    // 先执行集中处理的副作用。
    onChange?.({ newState, oldState });

    // 再通知当前订阅者。
    listeners.forEach(listener => listener());
  }

  function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  function batch(fn: () => void): void {
    batchDepth++;
    try {
      fn();
    } finally {
      batchDepth--;
      if (batchDepth === 0 && batchDirty) {
        batchDirty = false;
        const old = batchOldState!;
        batchOldState = null;
        onChange?.({ newState: state, oldState: old });
        listeners.forEach(listener => listener());
      }
    }
  }

  function getListenerCount(): number {
    return listeners.size;
  }

  return { getState, setState, subscribe, batch, getListenerCount };
}

// ─── 工具类型 ───

/** 深度只读 — 防止意外 mutation */
export type DeepReadonly<T> =
  T extends Map<infer K, infer V> ? ReadonlyMap<K, DeepReadonly<V>> :
  T extends Set<infer U> ? ReadonlySet<DeepReadonly<U>> :
  T extends Array<infer U> ? ReadonlyArray<DeepReadonly<U>> :
  T extends Function ? T :
  T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } :
  T;

/**
 * 创建 selector：缓存派生计算，仅在 Store 状态引用变化时重新计算。
 */
export function createSelector<T, R>(
  store: Store<T>,
  selector: (state: T) => R,
): { getValue: () => R; subscribe: (listener: Listener) => () => void } {
  let cachedInput: T | undefined;
  let cachedResult: R;

  function getValue(): R {
    const current = store.getState();
    if (cachedInput !== undefined && Object.is(cachedInput, current)) {
      return cachedResult;
    }
    cachedInput = current;
    cachedResult = selector(current);
    return cachedResult;
  }

  function subscribe(listener: Listener): () => void {
    let lastResult = getValue();
    return store.subscribe(() => {
      const newResult = getValue();
      if (!Object.is(newResult, lastResult)) {
        lastResult = newResult;
        listener();
      }
    });
  }

  return { getValue, subscribe };
}
