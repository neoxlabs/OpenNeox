import { describe, expect, it, beforeEach, vi } from 'vitest';

interface FakeEnv {
  cores: number;
  stored: Record<string, string>;
}

function installEnv({ cores, stored }: FakeEnv): void {
  const localStorage = {
    getItem: (k: string) => (k in stored ? stored[k] : null),
    setItem: (k: string, v: string) => { stored[k] = v; },
    removeItem: (k: string) => { delete stored[k]; },
  };
  (globalThis as any).window = { localStorage };
  (globalThis as any).localStorage = localStorage;
  /* node 的 navigator 是只读 getter, 直接赋值会抛 —— 必须 defineProperty 覆盖。 */
  Object.defineProperty(globalThis, 'navigator', {
    value: { hardwareConcurrency: cores },
    configurable: true,
    writable: true,
  });
}

/** 每次重新 import —— 模块里有 weakVerdictCache, 跨用例必须重置。 */
async function load() {
  vi.resetModules();
  return import('../motionPreferences');
}

describe('动效档位默认值', () => {
  beforeEach(() => { vi.resetModules(); });

  it('强机器 + 没存过偏好 → silk (全特效)', async () => {
    installEnv({ cores: 10, stored: {} });
    const m = await load();
    expect(m.getMotionPreference()).toBe('silk');
  });

  it('低配机 + 没存过偏好 → standard (降一档, 但不是 off)', async () => {
    installEnv({ cores: 4, stored: {} });
    const m = await load();
    expect(m.getMotionPreference()).toBe('standard');
  });

  it('低配机但用户手选过 silk → 尊重用户, 仍是 silk', async () => {
    installEnv({ cores: 4, stored: { 'neox.ui.motion': 'silk' } });
    const m = await load();
    expect(m.getMotionPreference()).toBe('silk');
  });

  it('强机器但用户手选过 off → 尊重用户, 仍是 off', async () => {
    installEnv({ cores: 10, stored: { 'neox.ui.motion': 'off' } });
    const m = await load();
    expect(m.getMotionPreference()).toBe('off');
  });

  it('存了非法值 → 回落到默认档, 不是崩', async () => {
    installEnv({ cores: 10, stored: { 'neox.ui.motion': 'turbo' } });
    const m = await load();
    expect(m.getMotionPreference()).toBe('silk');
  });
});

describe('detectWeakMachine', () => {
  beforeEach(() => { vi.resetModules(); });

  it('4 核及以下判为低配', async () => {
    installEnv({ cores: 4, stored: {} });
    const m = await load();
    const v = m.detectWeakMachine();
    expect(v.weak).toBe(true);
    expect(v.reason).toContain('4');
  });

  it('5 核以上不判低配 (宁可漏判, 不误伤强机器)', async () => {
    installEnv({ cores: 5, stored: {} });
    const m = await load();
    expect(m.detectWeakMachine().weak).toBe(false);
  });

  it('拿不到核数 (0) 时不降档', async () => {
    installEnv({ cores: 0, stored: {} });
    const m = await load();
    expect(m.detectWeakMachine().weak).toBe(false);
  });
});

describe('isMotionAutoDowngraded (设置页据此显示说明)', () => {
  beforeEach(() => { vi.resetModules(); });

  it('低配 + 没存过 → true (设置页要说出"已自动降档")', async () => {
    installEnv({ cores: 4, stored: {} });
    const m = await load();
    expect(m.isMotionAutoDowngraded()).toBe(true);
  });

  it('低配但用户手选过 → false (那是用户自己的选择, 不该说成自动)', async () => {
    installEnv({ cores: 4, stored: { 'neox.ui.motion': 'standard' } });
    const m = await load();
    expect(m.isMotionAutoDowngraded()).toBe(false);
  });

  it('强机器 → false', async () => {
    installEnv({ cores: 10, stored: {} });
    const m = await load();
    expect(m.isMotionAutoDowngraded()).toBe(false);
  });
});
