/** worker 通过宿主反向调用能力，并确保成功、失败和异常路径都返回响应。 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  setHostCapabilities,
  getHostCapability,
  resetHostCapabilities,
  HOST_CAPABILITY_UNAVAILABLE,
} from '../hostCapabilities.js';

/** 复刻 WorkerRuntimeAdapter.handleHostCall 的行为契约 —— 它是私有方法, 这里按同一份
 *  逻辑建一个最小实现来验"任何情况都回消息"。真实实现改了这里会一起改。 */
function makeHost(postMessage: (m: unknown) => void) {
  return async function handleHostCall(msg: { reqId: number; capability: any; args?: unknown[] }) {
    const reply = (r: Record<string, unknown>) => {
      try { postMessage({ type: 'host-result', reqId: msg.reqId, ...r }); } catch { /* worker 已退 */ }
    };
    const fn = getHostCapability(msg.capability);
    if (typeof fn !== 'function') {
      reply({ ok: false, error: `${HOST_CAPABILITY_UNAVAILABLE}: ${msg.capability}` });
      return;
    }
    try {
      const value = await (fn as (...a: unknown[]) => Promise<unknown>)(...(msg.args ?? []));
      reply({ ok: true, value });
    } catch (err: any) {
      reply({ ok: false, error: String(err?.message ?? err) });
    }
  };
}

beforeEach(() => resetHostCapabilities());

describe('宿主能力注册表', () => {
  it('注册后能取到; 没注册的取不到 (不抛)', () => {
    expect(getHostCapability('diagnostics')).toBeUndefined();
    const fn = vi.fn(async () => []);
    setHostCapabilities({ diagnostics: fn });
    expect(getHostCapability('diagnostics')).toBe(fn);
    expect(getHostCapability('terminal')).toBeUndefined();
  });

  it('多次注册是合并不是覆盖 —— 桌面端分两处注册也不会互相打掉', () => {
    const a = vi.fn(async () => 1); const b = vi.fn(async () => 2);
    setHostCapabilities({ diagnostics: a });
    setHostCapabilities({ terminal: b });
    expect(getHostCapability('diagnostics')).toBe(a);
    expect(getHostCapability('terminal')).toBe(b);
  });
});

describe('⚠️ 任何情况都必须回消息 (不回 = worker 永久挂起)', () => {
  it('能力可用: 回 ok:true 和返回值', async () => {
    const sent: any[] = [];
    setHostCapabilities({ diagnostics: async (o) => ({ echo: o }) });
    await makeHost((m) => sent.push(m))({ reqId: 7, capability: 'diagnostics', args: [{ limit: 5 }] });
    expect(sent).toEqual([{ type: 'host-result', reqId: 7, ok: true, value: { echo: { limit: 5 } } }]);
  });

  it('能力没注册 (CLI 宿主): 回 ok:false + unavailable, 不是沉默', async () => {
    const sent: any[] = [];
    await makeHost((m) => sent.push(m))({ reqId: 8, capability: 'diagnostics', args: [] });
    expect(sent).toHaveLength(1);
    expect(sent[0].ok).toBe(false);
    expect(sent[0].error).toContain(HOST_CAPABILITY_UNAVAILABLE);
    expect(sent[0].reqId).toBe(8);
  });

  it('能力本身抛错: 也要回 ok:false, 把原话带上', async () => {
    const sent: any[] = [];
    setHostCapabilities({ diagnostics: async () => { throw new Error('Diagnostics request timeout after 8s'); } });
    await makeHost((m) => sent.push(m))({ reqId: 9, capability: 'diagnostics', args: [] });
    expect(sent[0]).toMatchObject({ ok: false, reqId: 9 });
    expect(sent[0].error).toContain('timeout after 8s');
  });

  it('回消息本身失败 (worker 已退) 不许把宿主也带崩', async () => {
    setHostCapabilities({ diagnostics: async () => 'x' });
    const boom = () => { throw new Error('worker gone'); };
    await expect(makeHost(boom)({ reqId: 10, capability: 'diagnostics', args: [] })).resolves.toBeUndefined();
  });

  it('reqId 原样带回 —— 并发调用靠它对号入座', async () => {
    const sent: any[] = [];
    setHostCapabilities({ diagnostics: async (o: any) => o.n });
    const host = makeHost((m) => sent.push(m));
    await Promise.all([1, 2, 3].map((n) => host({ reqId: n, capability: 'diagnostics', args: [{ n }] })));
    expect(sent.map((m) => [m.reqId, m.value]).sort()).toEqual([[1, 1], [2, 2], [3, 3]]);
  });
});
