import { describe, it, expect, vi, beforeEach } from 'vitest';

const sim = { version: 0, dumpedAt: 0, dead: false, web: false, ops: [] as string[] };

function elements() {
  const els: any[] = [];
  for (let i = 1; i <= 20; i++) els.push({ id: i, role: 'AXButton', label: `b${i}`, x: 0, y: i * 20, w: 80, h: 20, actionable: true, actions: ['AXPress'], enabled: true, focused: false });
  /* 角色不认识但能按 —— dump 算可交互, 签名的白名单不排除它 */
  els.push({ id: 30, role: 'AXGroup', label: '会话', x: 0, y: 600, w: 200, h: 40, actionable: true, actions: ['AXPress'], enabled: true, focused: false });
  els.push({ id: 40, role: 'AXStaticText', label: `正文 v${sim.version}`, x: 300, y: 0, w: 300, h: 16, actionable: false, actions: [], enabled: true, focused: false });
  els.push({ id: 50, role: 'AXButton', label: sim.version >= 1 ? '发送' : '取消', x: 900, y: 900, w: 60, h: 30, actionable: true, actions: ['AXPress'], enabled: true, focused: false });
  for (let k = 0; k < sim.version; k++) els.push({ id: 60 + k, role: 'AXRow', label: `行${k}`, x: 300, y: 800 + k * 20, w: 300, h: 20, actionable: true, actions: ['AXPress'], enabled: true, focused: false });
  if (sim.web) els.push({ id: 99, role: 'AXWebArea', label: 'web', x: 0, y: 0, w: 1000, h: 800, actionable: false, actions: [], enabled: true, focused: false });
  return els;
}

const request = vi.fn(async (req: any) => {
  sim.ops.push(req.op);
  switch (req.op) {
    case 'dump':
      sim.dumpedAt = sim.version;
      return { ok: true, app: 'QQ', pid: 1, epoch: 1, ms: 1, visited: 50, elements: elements(), axBlind: false };
    case 'signature': {
      const els = elements();
      const counts: Record<string, number> = {};
      for (const e of els) counts[e.role] = (counts[e.role] ?? 0) + 1;
      return { ok: true, texts: els.filter((e) => !['AXButton', 'AXRow'].includes(e.role)).map((e) => e.label),
        labels: els.map((e) => e.label), counts };
    }
    case 'act':
      if (sim.dead && sim.dumpedAt < sim.version) return { ok: true };   /* 死句柄: 报成功, 什么也不发生 */
      sim.version++;
      return { ok: true };
    case 'screenshot': return { ok: false, code: 'test' };
    default: return { ok: true };
  }
});
vi.mock('../osBridgeClient.js', () => ({ getOsBridge: () => ({ request }) }));
vi.mock('@neoxlabs/platform/shared/computerPointerBus.js', () => ({ publishComputerPointer: () => {} }));

const { runComputerScript, resetComputerPerceptionCache } = await import('../computerRun.js');

beforeEach(() => {
  Object.assign(sim, { version: 0, dumpedAt: 0, dead: false, web: false, ops: [] });
  resetComputerPerceptionCache();
});

describe('断言口径', () => {
  it('{count} 点了没反应 → 判失败 (不是基线和轮询数法不同造成的"变了")', async () => {
    const orig = request.getMockImplementation()!;
    request.mockImplementation(async (req: any) => (req.op === 'act' ? { ok: true } : orig(req)));
    const r = await runComputerScript({ app: 'QQ', steps: [
      { action: 'click', target: 5, expectChange: { watch: { count: 'AXRow' }, timeoutMs: 400 } },
    ] });
    request.mockImplementation(orig);
    expect(r.ok).toBe(false);
  });

  it('{label} 等的是按钮上的字 → 看得见, 判通过', async () => {
    const r = await runComputerScript({ app: 'QQ', steps: [
      { action: 'click', target: 5, expectChange: { watch: { label: '发送' }, timeoutMs: 1500 } },
    ] });
    expect(r.ok).toBe(true);
  });
});

describe('先点后验', () => {
  const twoClicks = { app: 'QQ', steps: [
    { action: 'click' as const, target: 5, expectChange: { watch: { count: 'AXRow' }, timeoutMs: 1500 } },
    { action: 'click' as const, target: 6, expectChange: { watch: { count: 'AXRow' }, timeoutMs: 1500 } },
  ] };

  it('原生 App: 第二次点击前不重扫 (只有开头和收尾两次 dump)', async () => {
    const r = await runComputerScript(twoClicks);
    expect(r.ok).toBe(true);
    expect(sim.ops.filter((o) => o === 'dump').length).toBe(2);
  });

  it('Electron 系 (AXWebArea): 界面变过之后先重扫再点', async () => {
    sim.web = true; sim.dead = true;
    const r = await runComputerScript(twoClicks);
    expect(r.ok).toBe(true);
    expect(sim.ops.filter((o) => o === 'dump').length).toBe(3);
    expect(r.steps[1]!.hint).toBeUndefined();   /* 一次就点中, 没走"重做" */
  });

  it('句柄会死但认不出来的 App: 第一次靠重做救回, 之后学会先重扫', async () => {
    sim.dead = true;
    const r = await runComputerScript({ app: 'QQ', steps: [
      ...twoClicks.steps,
      { action: 'click' as const, target: 7, expectChange: { watch: { count: 'AXRow' }, timeoutMs: 1500 } },
    ] });
    expect(r.ok).toBe(true);
    expect(r.steps[1]!.hint).toMatch(/重做/);
    expect(r.steps[2]!.hint).toBeUndefined();
  });
});
