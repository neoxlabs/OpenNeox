import { describe, it, expect, vi } from 'vitest';
import { createStore, createSelector } from '../store.js';

describe('createStore', () => {
  it('getState returns initial state', () => {
    const store = createStore({ count: 0 });
    expect(store.getState()).toEqual({ count: 0 });
  });

  it('setState updates state via updater', () => {
    const store = createStore({ count: 0 });
    store.setState(prev => ({ count: prev.count + 1 }));
    expect(store.getState().count).toBe(1);
  });

  it('skips update when Object.is returns true', () => {
    const listener = vi.fn();
    const initial = { count: 0 };
    const store = createStore(initial);
    store.subscribe(listener);

    // Return same reference → no notification
    store.setState(prev => prev);
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies listeners on state change', () => {
    const listener = vi.fn();
    const store = createStore({ count: 0 });
    store.subscribe(listener);

    store.setState(prev => ({ count: prev.count + 1 }));
    expect(listener).toHaveBeenCalledTimes(1);

    store.setState(prev => ({ count: prev.count + 1 }));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('unsubscribe stops notifications', () => {
    const listener = vi.fn();
    const store = createStore({ count: 0 });
    const unsub = store.subscribe(listener);

    store.setState(prev => ({ count: 1 }));
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    store.setState(prev => ({ count: 2 }));
    expect(listener).toHaveBeenCalledTimes(1); // no new calls
  });

  it('onChange receives old and new state', () => {
    const onChange = vi.fn();
    const store = createStore({ count: 0 }, onChange);

    store.setState(prev => ({ count: 5 }));
    expect(onChange).toHaveBeenCalledWith({
      newState: { count: 5 },
      oldState: { count: 0 },
    });
  });

  it('onChange is not called when state unchanged', () => {
    const onChange = vi.fn();
    const store = createStore({ count: 0 }, onChange);
    store.setState(prev => prev);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('batch merges multiple updates into one notification', () => {
    const listener = vi.fn();
    const onChange = vi.fn();
    const store = createStore({ a: 0, b: 0 }, onChange);
    store.subscribe(listener);

    store.batch(() => {
      store.setState(prev => ({ ...prev, a: 1 }));
      store.setState(prev => ({ ...prev, b: 2 }));
    });

    // listener called once (not twice)
    expect(listener).toHaveBeenCalledTimes(1);
    // onChange called once with original old state
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      newState: { a: 1, b: 2 },
      oldState: { a: 0, b: 0 },
    });
  });

  it('batch does not notify if no changes', () => {
    const listener = vi.fn();
    const store = createStore({ x: 1 });
    store.subscribe(listener);

    store.batch(() => {
      // no setState calls
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it('getListenerCount tracks subscribers', () => {
    const store = createStore({ x: 0 });
    expect(store.getListenerCount()).toBe(0);

    const unsub1 = store.subscribe(() => {});
    const unsub2 = store.subscribe(() => {});
    expect(store.getListenerCount()).toBe(2);

    unsub1();
    expect(store.getListenerCount()).toBe(1);
  });
});

describe('createSelector', () => {
  it('derives value from store', () => {
    const store = createStore({ a: 1, b: 2 });
    const selector = createSelector(store, s => s.a + s.b);
    expect(selector.getValue()).toBe(3);
  });

  it('caches value when state unchanged', () => {
    const compute = vi.fn((s: { x: number }) => s.x * 2);
    const store = createStore({ x: 5 });
    const selector = createSelector(store, compute);

    selector.getValue();
    selector.getValue();
    selector.getValue();
    // Only computed once (cached)
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('recomputes on state change', () => {
    const store = createStore({ x: 1 });
    const selector = createSelector(store, s => s.x * 10);

    expect(selector.getValue()).toBe(10);
    store.setState(prev => ({ x: 3 }));
    expect(selector.getValue()).toBe(30);
  });

  it('selector subscribe only fires when derived value changes', () => {
    const listener = vi.fn();
    const store = createStore({ a: 1, b: 'hello' });
    const selector = createSelector(store, s => s.a);
    selector.subscribe(listener);

    // Change b (irrelevant to selector) → no notification
    store.setState(prev => ({ ...prev, b: 'world' }));
    expect(listener).not.toHaveBeenCalled();

    // Change a → notification
    store.setState(prev => ({ ...prev, a: 99 }));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
