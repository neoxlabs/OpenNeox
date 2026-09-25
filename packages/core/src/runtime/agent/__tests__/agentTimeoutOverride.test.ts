/**
 * NEOX_AGENT_HARD_TIMEOUT_MS 逃生开关必须真的生效
 * ═══════════════════════════════════════════════════════════════════════════
 * 有效超时原来算的是 `agentType.config.maxRuntimeMs || AGENT_HARD_TIMEOUT_MS`，
 * 而每种 agent 类型都带非零的 maxRuntimeMs (code 5min / plan 3min / research 6min …)，
 * 于是 `||` 永远短路在前半段 —— 环境变量设了等于没设。想给长任务多点余量的人调它
 * 毫无反应，只能改代码；超时路径也因此没法在测试里触发。
 *
 * 另外它跟 backgroundAgent 是**同一个 env 名字、相反的默认**: 那边默认 0(关闭) 并写明
 * 「长任务不该被时长判死」，前台却仍按墙钟硬砍 3~8 分钟。显式设置必须能压过类型默认。
 *
 *  第二轮: 默认值也统一了 —— 墙钟闸默认关 (0 = 不限时)，判死交给停滞看门狗。
 * 前台/后台两条路从此同 env 同默认同判据。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL = process.env.NEOX_AGENT_HARD_TIMEOUT_MS;

/** env 在模块加载时读取, 所以每次都要重新 import 一份干净的模块。 */
async function loadResolver(envValue: string | undefined) {
  if (envValue === undefined) delete process.env.NEOX_AGENT_HARD_TIMEOUT_MS;
  else process.env.NEOX_AGENT_HARD_TIMEOUT_MS = envValue;
  vi.resetModules();
  const mod = await import('../agentTool.js');
  return mod.resolveAgentTimeoutMs;
}

beforeEach(() => { vi.resetModules(); });
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEOX_AGENT_HARD_TIMEOUT_MS;
  else process.env.NEOX_AGENT_HARD_TIMEOUT_MS = ORIGINAL;
});

describe('没设 env 时', () => {
  it('内置类型一律不限时 (maxRuntimeMs=0) —— 判死交给停滞看门狗', async () => {
    const resolve = await loadResolver(undefined);
    expect(resolve(0)).toBe(0);
    expect(resolve(undefined)).toBe(0);
  });

  it('类型自己写了非零上限就照它的来 (自定义 agent 仍可自限)', async () => {
    const resolve = await loadResolver(undefined);
    expect(resolve(5 * 60 * 1000)).toBe(300_000);
    expect(resolve(3 * 60 * 1000)).toBe(180_000);
  });

  it('内置 agent 类型全部是 0 —— 别再有人把墙钟偷偷加回去', async () => {
    const { getAvailableAgentTypes } = await import('../agentTypes.js');
    for (const t of getAvailableAgentTypes()) {
      expect([t.id, t.config.maxRuntimeMs]).toEqual([t.id, 0]);
    }
  });
});

describe('显式设了 env 时 —— 必须压过类型默认 (修复前做不到)', () => {
  it('调大: 给长任务更多余量', async () => {
    const resolve = await loadResolver('1800000'); // 30min
    expect(resolve(5 * 60 * 1000)).toBe(1_800_000);
    expect(resolve(3 * 60 * 1000)).toBe(1_800_000);
  });

  it('调小: eval / CI 想要确定性的短上界', async () => {
    const resolve = await loadResolver('15000');
    expect(resolve(5 * 60 * 1000)).toBe(15_000);
  });

  it('对每种类型一视同仁 —— 不是只对没写上限的那些生效', async () => {
    const resolve = await loadResolver('45000');
    for (const typeDefault of [180_000, 300_000, 360_000, 480_000, undefined]) {
      expect(resolve(typeDefault)).toBe(45_000);
    }
  });
});

describe('脏值不许把超时搞成 NaN', () => {
  it('空串当没设', async () => {
    const resolve = await loadResolver('');
    expect(resolve(300_000)).toBe(300_000);
  });

  it('非数字当没设, 退回类型默认', async () => {
    const resolve = await loadResolver('abc');
    expect(resolve(300_000)).toBe(300_000);
    expect(Number.isFinite(resolve(300_000))).toBe(true);
  });
});
