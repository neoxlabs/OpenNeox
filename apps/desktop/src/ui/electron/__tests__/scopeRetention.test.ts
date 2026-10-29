import { describe, expect, it } from 'vitest';
import { shouldParkOnSwitch, canReviveParked, shouldReapParked } from '../context/scopeRetention.js';

describe('切走时: 保活还是拆', () => {
  it('还有会话在跑 → 保活, 绝不拆', () => {
    expect(shouldParkOnSwitch({ hasRunningSessions: true })).toBe(true);
  });

  it('真空闲了 → 可以拆', () => {
    expect(shouldParkOnSwitch({ hasRunningSessions: false })).toBe(false);
  });
});

describe('切回来: 能不能复用保活的那个', () => {
  it('同一个窗口 + 没被拆 → 复用', () => {
    expect(canReviveParked({ windowId: 7, disposed: false }, 7)).toBe(true);
  });

  it('压根没有保活的 → 只能新建', () => {
    expect(canReviveParked(undefined, 7)).toBe(false);
  });

  it('已经被拆掉的复活不了', () => {
    expect(canReviveParked({ windowId: 7, disposed: true }, 7)).toBe(false);
  });

  /* 多窗口: 别的窗口的 scope 拿过来用, 事件会发到另一个窗口去 */
  it('是别的窗口的 scope → 不许拿来用', () => {
    expect(canReviveParked({ windowId: 8, disposed: false }, 7)).toBe(false);
  });
});

describe('保活的什么时候回收', () => {
  it('活还没干完 → 继续留着', () => {
    expect(shouldReapParked({ hasRunningSessions: true, disposed: false })).toBe(false);
  });

  it('干完了 → 回收', () => {
    expect(shouldReapParked({ hasRunningSessions: false, disposed: false })).toBe(true);
  });

  /* 窗口关闭等路径会把 scope 拆掉, 那时它还挂在 parked 里, 必须能被清出去,
   * 否则 Map 里会留一个永远不会被回收的死引用。 */
  it('已经被别的路径拆了 → 即使标着"在跑"也要清出去', () => {
    expect(shouldReapParked({ hasRunningSessions: true, disposed: true })).toBe(true);
  });
});
