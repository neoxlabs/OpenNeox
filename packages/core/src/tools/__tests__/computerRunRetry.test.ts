import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 点击操作在状态未改变时允许自动重试；type、set_value 和 key 等可能产生重复副作用的
 * 操作不重试，避免重复输入或发送消息。
 */
const bridgeCalls: Array<Record<string, any>> = [];
let screenState = 'A';
let flipOnAct = false;
let dumpAxBlind = false;
let dumpTreeSource: string | undefined;
let growTreeAfterAct = false;
let setValueUnsupported = false;

function fakeEl(partial: Record<string, any>) {
  return {
    x: 0, y: 0, w: 10, h: 10, actionable: true, actions: ['AXPress'], enabled: true, focused: false,
    ...partial,
  };
}

vi.mock('../../runtime/computer/osBridgeClient.js', () => ({
  getOsBridge: () => ({
    request: async (req: Record<string, any>) => {
      bridgeCalls.push(req);
      if (req.op === 'dump') {
        const extra = growTreeAfterAct
          ? Array.from({ length: 20 }, (_, i) => fakeEl({
            id: 20 + i, role: 'ListItem', label: `微笑${i}`, y: 80 + i, w: 48, h: 28,
          }))
          : [];
        return {
          ok: true, app: 'FakeApp', pid: 1, epoch: 1, ms: 1, visited: 3,           axBlind: dumpAxBlind,
          treeSource: dumpTreeSource,
          elements: dumpAxBlind ? [] : [
            fakeEl({ id: 1, role: 'AXButton', label: '按钮' }),
            fakeEl({ id: 2, role: 'AXStaticText', label: `内容-${screenState}`, actionable: false, actions: [], y: 20 }),
            fakeEl({ id: 3, role: 'AXStaticText', label: `骨架-${screenState}`, actionable: false, actions: [], y: 40 }),
            fakeEl({ id: 4, role: 'Button', label: '发送', x: 200, y: 400, w: 64, h: 28 }),
            fakeEl({ id: 5, role: 'Button', label: '', x: 268, y: 400, w: 16, h: 28 }),
            fakeEl({ id: 6, role: 'Text', label: '机器人群 · 没不理你', actionable: false, actions: [], x: 20, y: 120, w: 220, h: 36 }),
            ...extra,
          ],
        };
      }
      /* 变化断言的轮询走**轻量签名** (op:'signature'), 不走完整 dump ——
       * 那是为了省时间: OS 这边一次完整 dump 0.6~3 秒, 而断言只要文本。
       * mock 不实现它的话, 所有断言都会"永远等不到变化"。 */
      if (req.op === 'signature') {
        return {
          ok: true, ms: 1,
          texts: [`内容-${screenState}`, `骨架-${screenState}`],
          counts: { AXButton: 1, AXStaticText: 2 },
        };
      }
      if (req.op === 'act' && req.action === 'setValue' && setValueUnsupported) {
        return { ok: false, code: 'unsupported_action', error: 'no setValue' };
      }
      /* 动作生效 = 界面从 A 变 B。测"没生效"的用例把 screenState 钉死在 A。 */
      if (req.op === 'act' && flipOnAct) screenState = 'B';
      if (req.op === 'act') growTreeAfterAct = true;
      if (req.op === 'click_at' || req.op === 'hover' || req.op === 'double_click' || req.op === 'drag' || req.op === 'scroll' || req.op === 'show_menu' || req.op === 'type') return { ok: true, ms: 1 };
      if (req.op === 'screenshot') return { ok: true, path: 'fake.jpg' };
      return { ok: true, ms: 1 };
    },
  }),
}));

const { runComputerScript, resetComputerPerceptionCache } = await import('../../runtime/computer/computerRun.js');

beforeEach(() => {
  bridgeCalls.length = 0;
  screenState = 'A';
  flipOnAct = false;
  dumpAxBlind = false;
  dumpTreeSource = undefined;
  growTreeAfterAct = false;
  setValueUnsupported = false;
  resetComputerPerceptionCache();
});

const actCount = () => bridgeCalls.filter((c) => c.op === 'act' || c.op === 'type' || c.op === 'key').length;

describe('computer_run 的自动重做', () => {
  it('点击没生效 → 重做一次 (动作发了两遍)', async () => {
    const r = await runComputerScript({
      app: 'FakeApp',
      steps: [{ action: 'click', target: 1, expectChange: { watch: { label: '永远不会出现的东西' }, timeoutMs: 300 } }],
    });
    expect(r.ok).toBe(false);
    expect(actCount(), '点击类应该被重做一次').toBe(2);
    expect(r.steps[0]!.hint ?? '').toContain('重做');
  });

  it('打字没生效 → **不重做** (重做就是打两遍字)', async () => {
    const r = await runComputerScript({
      app: 'FakeApp',
      steps: [{ action: 'type', target: 1, text: '一条会真的发出去的消息', expectChange: { watch: { label: '永远不会出现的东西' }, timeoutMs: 300 } }],
    });
    expect(r.ok).toBe(false);
    expect(actCount(), 'type 被重做了 —— 那会打两遍字').toBe(1);
  });

  it('按键没生效 → 不重做', async () => {
    const r = await runComputerScript({
      app: 'FakeApp',
      steps: [{ action: 'key', key: 'return', expectChange: { watch: { label: '永远不会出现的东西' }, timeoutMs: 300 } }],
    });
    expect(r.ok).toBe(false);
    expect(actCount()).toBe(1);
  });

  it('一次就成的不重做', async () => {
    /* 让这一次的动作真的改变界面 —— 断言比的是"变了没有", 不是"存在与否" */
    flipOnAct = true;
    const r = await runComputerScript({
      app: 'FakeApp',
      steps: [{
        action: 'click', target: 1,
        expectChange: { watch: { label: '内容-B' }, timeoutMs: 1000 },
      }],
    });
    expect(r.ok, `失败原因: ${r.steps[0]?.error}`).toBe(true);
    expect(actCount()).toBe(1);
    expect(r.screen?.screenshot).toBe('fake.jpg');
  });
});

describe('computer_run 断言别空转', () => {
  it('expectChange.watch 缺失 → 明确报错, 不抛 "count in undefined"', async () => {
    const r = await runComputerScript({
      app: 'FakeApp',
      steps: [{ action: 'click', target: 1, expectChange: { timeoutMs: 300 } as any }],
    });
    expect(r.ok).toBe(false);
    expect(r.steps[0]!.error ?? '').toMatch(/watch/);
    expect(actCount()).toBe(0);
  });

  it('axBlind 时不空等 expectChange', async () => {
    dumpAxBlind = true;
    const t0 = Date.now();
    const r = await runComputerScript({
      app: 'FakeApp',
      steps: [{ action: 'click_at', dx: 0.5, dy: 0.5, expectChange: { watch: 'screen', timeoutMs: 4000 } }],
    });
    expect(r.ok).toBe(true);
    expect(r.steps[0]!.hint ?? '').toMatch(/跳过/);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('hover 也不空等 expectChange', async () => {
    dumpAxBlind = true;
    const t0 = Date.now();
    const r = await runComputerScript({
      app: 'FakeApp',
      steps: [{ action: 'hover', dx: 0.2, dy: 0.1, expectChange: { watch: 'screen', timeoutMs: 4000 } }],
    });
    expect(r.ok).toBe(true);
    expect(r.steps[0]!.hint ?? '').toMatch(/跳过/);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(bridgeCalls.some((c) => c.op === 'hover')).toBe(true);
  });

  it('点表情后等到树里多出面板再继续', async () => {
    const r = await runComputerScript({
      app: 'FakeApp',
      steps: [
        { action: 'click', target: 1, label: '表情' },
        { action: 'snapshot' },
      ],
    });
    expect(r.ok).toBe(true);
    expect(bridgeCalls.filter((c) => c.op === 'dump').length).toBeGreaterThan(2);
    expect(r.screen?.actionable?.some((s) => s.includes('微笑'))).toBe(true);
  });

  it('会话 Text 行也出现在可点清单', async () => {
    const r = await runComputerScript({
      app: 'FakeApp',
      steps: [{ action: 'snapshot' }],
    });
    expect(r.ok).toBe(true);
    expect(r.screen?.actionable?.some((s) => s.includes('机器人群'))).toBe(true);
    expect(r.screen?.actionable?.some((s) => s.includes('发送菜单'))).toBe(true);
  });

  it('表情面板还开着时点发送会先 ESC', async () => {
    const r = await runComputerScript({
      app: 'FakeApp',
      steps: [
        { action: 'click', target: 1, label: '表情' },
        { action: 'click', target: 4, label: '发送' },
      ],
    });
    expect(r.ok).toBe(true);
    const ops = bridgeCalls.map((c) => c.op);
    const esc = ops.lastIndexOf('key');
    const send = ops.lastIndexOf('act');
    expect(bridgeCalls.some((c) => c.op === 'key' && c.key === 'escape')).toBe(true);
    expect(esc).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(esc);
    expect(r.steps[1]?.hint ?? '').toMatch(/ESC/);
  });

  it('scroll 按比例落点会发到桥, 且不空等 expectChange', async () => {
    dumpAxBlind = true;
    const t0 = Date.now();
    const r = await runComputerScript({
      app: 'FakeApp',
      steps: [{ action: 'scroll', dx: 0.5, dy: 0.7, expectChange: { watch: 'screen', timeoutMs: 4000 } }],
    });
    expect(r.ok).toBe(true);
    expect(r.steps[0]!.hint ?? '').toMatch(/跳过/);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(bridgeCalls.some((c) => c.op === 'scroll' && c.dx === 0.5 && c.dy === 0.7)).toBe(true);
  });

  it('show_menu 按比例落点会发到桥, 且不空等 expectChange', async () => {
    dumpAxBlind = true;
    const t0 = Date.now();
    const r = await runComputerScript({
      app: 'FakeApp',
      steps: [{ action: 'show_menu', dx: 0.4, dy: 0.5, expectChange: { watch: 'screen', timeoutMs: 4000 } }],
    });
    expect(r.ok).toBe(true);
    expect(r.steps[0]!.hint ?? '').toMatch(/跳过/);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(bridgeCalls.some((c) => c.op === 'show_menu' && c.dx === 0.4 && c.dy === 0.5)).toBe(true);
  });

  it('type 按比例落点会发到桥, 且不空等 expectChange', async () => {
    dumpAxBlind = true;
    const t0 = Date.now();
    const r = await runComputerScript({
      app: 'FakeApp',
      steps: [{ action: 'type', dx: 0.45, dy: 0.82, text: '你好', expectChange: { watch: 'screen', timeoutMs: 4000 } }],
    });
    expect(r.ok).toBe(true);
    expect(r.steps[0]!.hint ?? '').toMatch(/跳过/);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(bridgeCalls.some((c) => c.op === 'type' && c.dx === 0.45 && c.dy === 0.82 && c.text === '你好')).toBe(true);
  });

  it('set_value 不支持时退到 type, 脚本继续', async () => {
    setValueUnsupported = true;
    const r = await runComputerScript({
      app: 'FakeApp',
      steps: [{ action: 'set_value', target: 1, text: '你好' }],
    });
    expect(r.ok).toBe(true);
    expect(bridgeCalls.some((c) => c.op === 'act' && c.action === 'setValue')).toBe(true);
    expect(bridgeCalls.some((c) => c.op === 'type' && c.text === '你好' && c.target === 1)).toBe(true);
  });

  it('double_click / drag 会发到桥', async () => {
    const r = await runComputerScript({
      app: 'FakeApp',
      steps: [
        { action: 'double_click', dx: 0.5, dy: 0.5 },
        { action: 'drag', dx: 0.2, dy: 0.2, dx2: 0.8, dy2: 0.8 },
      ],
    });
    expect(r.ok).toBe(true);
    expect(bridgeCalls.some((c) => c.op === 'double_click')).toBe(true);
    expect(bridgeCalls.some((c) => c.op === 'drag' && c.dx2 === 0.8)).toBe(true);
  });

  it('收场先发 unlock, 而且每次 run 都会开锁 (退出路径也是)', async () => {
    await runComputerScript({
      app: 'FakeApp',
      steps: [{ action: 'snapshot' }],
    });
    const ops = bridgeCalls.map((c) => c.op);
    expect(ops).toContain('lock_user_input');
    expect(ops).toContain('unlock_user_input');
    expect(ops.indexOf('lock_user_input')).toBeLessThan(ops.indexOf('unlock_user_input'));
    expect(bridgeCalls.find((c) => c.op === 'lock_user_input')?.app).toBe('FakeApp');
  });

  it('Java 树下 key 不空等 expectChange', async () => {
    dumpTreeSource = 'jab';
    const t0 = Date.now();
    const r = await runComputerScript({
      app: 'FakeApp',
      steps: [{ action: 'key', key: 'alt+insert', expectChange: { watch: 'screen', timeoutMs: 4000 } }],
    });
    expect(r.ok).toBe(true);
    expect(r.steps[0]!.hint ?? '').toMatch(/跳过/);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(bridgeCalls.filter((c) => c.op === 'signature')).toHaveLength(0);
    expect(bridgeCalls.filter((c) => c.op === 'dump').length).toBeGreaterThanOrEqual(2);
  });

  it('key 和弦拆进 modifiers', async () => {
    dumpTreeSource = 'jab';
    await runComputerScript({
      app: 'FakeApp',
      steps: [{ action: 'key', key: 'alt+insert' }],
    });
    const keyReq = bridgeCalls.find((c) => c.op === 'key');
    expect(keyReq?.key).toBe('insert');
    expect(keyReq?.modifiers).toContain('alt');
  });

  it('click_at 之后收尾必须重新感知 (不能把点之前的截图当结果)', async () => {
    dumpAxBlind = true;
    await runComputerScript({
      app: 'FakeApp',
      steps: [{ action: 'click_at', dx: 0.5, dy: 0.5 }],
    });
    expect(bridgeCalls.filter((c) => c.op === 'dump').length).toBe(2);
  });

  it('axBlind 连续两次 computer_run 复用上一轮收尾 dump', async () => {
    dumpAxBlind = true;
    await runComputerScript({
      app: 'FakeApp',
      steps: [{ action: 'click_at', dx: 0.5, dy: 0.5 }],
    });
    const afterFirst = bridgeCalls.filter((c) => c.op === 'dump').length;
    await runComputerScript({
      app: 'FakeApp',
      steps: [{ action: 'click_at', dx: 0.4, dy: 0.4 }],
    });
    expect(bridgeCalls.filter((c) => c.op === 'dump').length).toBe(afterFirst + 1);
  });
});
