/**
 * Verify that dialogs, failed requests, and newly visible text are included
 * in each browser action result.
 *
 * The fixtures cover a dialog result and a failed request with visible page feedback.
 * The tests pin event propagation and classification.
 */
import { describe, it, expect } from 'vitest';
import type { Tool } from '@neox/kernel';
import { runBrowserScript, diffAppeared } from '../browserRun.js';

interface FakeOpts {
  clickResult?: unknown;
  /** browser_eval 依次返回的 innerText (动作前 / 动作后 / 快照…) */
  texts?: string[];
  network?: unknown[];
  console?: unknown[];
}

function makeTools(o: FakeOpts = {}): Map<string, Tool> {
  let ti = 0;
  const t = (name: string, fn: (a: Record<string, unknown>) => unknown): [string, Tool] =>
    [name, { name, function: async (a: Record<string, unknown>) => JSON.stringify(fn(a)) } as unknown as Tool];
  return new Map<string, Tool>([
    t('browser_click', () => o.clickResult ?? { ok: true, url: 'http://x/', title: 'x' }),
    t('browser_eval', (a) => {
      const expr = String(a.expression ?? '');
      if (expr.includes('innerText') && !expr.includes('data-neox-ref')) {
        const texts = o.texts ?? [''];
        return { ok: true, result: texts[Math.min(ti++, texts.length - 1)] };
      }
      return { ok: true, result: {} };
    }),
    t('browser_get_network', () => ({ ok: true, requests: o.network ?? [], total: (o.network ?? []).length })),
    t('browser_get_console_logs', () => ({ ok: true, logs: o.console ?? [], total: (o.console ?? []).length })),
  ]);
}

const click = (args: Record<string, unknown> = { selector: 'button.assign' }) =>
  ({ action: 'click' as const, args });

describe('对话框', () => {
  it('弹了 prompt 而这一步没给答案 → 这一步判失败, 并告诉它怎么答', async () => {
    const tools = makeTools({
      clickResult: { ok: true, url: 'http://x/', dialog: { type: 'prompt', message: '分配给谁?', handled: 'dismissed' } },
    });
    const r = await runBrowserScript({ steps: [click()] }, tools);
    expect(r.ok).toBe(false);
    const s = r.steps[0]!;
    expect(s.dialog?.type).toBe('prompt');
    expect(s.dialog?.message).toBe('分配给谁?');
    expect(s.error).toMatch(/prompt/);
    expect(s.error).toMatch(/dialog: \{accept:true, text:/);
  });

  it('给了答案的 prompt 按它的意思算成功, 回执里仍然带 dialog', async () => {
    const tools = makeTools({
      clickResult: { ok: true, url: 'http://x/', dialog: { type: 'prompt', message: '分配给谁?', handled: 'accepted', text: '赵六' } },
    });
    const r = await runBrowserScript({ steps: [click({ selector: 'button.assign', dialog: { accept: true, text: '赵六' } })] }, tools);
    expect(r.ok).toBe(true);
    expect(r.steps[0]!.dialog).toMatchObject({ type: 'prompt', handled: 'accepted', text: '赵六' });
    expect(r.steps[0]!.dialog?.hint).toBeUndefined();
  });

  it('明确说 accept:false 的 confirm 不算失败 —— 取消就是它要的', async () => {
    const tools = makeTools({
      clickResult: { ok: true, dialog: { type: 'confirm', message: '确定删除?', handled: 'dismissed' } },
    });
    const r = await runBrowserScript({ steps: [click({ selector: 'a', dialog: { accept: false } })] }, tools);
    expect(r.ok).toBe(true);
  });

  it('alert 自动点掉, 不算失败', async () => {
    const tools = makeTools({
      clickResult: { ok: true, dialog: { type: 'alert', message: '保存成功', handled: 'accepted' } },
    });
    const r = await runBrowserScript({ steps: [click()] }, tools);
    expect(r.ok).toBe(true);
    expect(r.steps[0]!.dialog?.hint).toMatch(/alert/);
  });
});

describe('失败请求与控制台', () => {
  it('HTTP 409 随这一步回去, 浏览器自带的那条 "Failed to load resource" 不重复报', async () => {
    const tools = makeTools({
      network: [{ method: 'POST', url: 'http://127.0.0.1:8910/api/tickets/7/close', status: 409 }],
      console: [{ level: 'error', text: 'Failed to load resource: the server responded with a status of 409 (Conflict)' }],
    });
    const r = await runBrowserScript({ steps: [click()] }, tools);
    expect(r.ok).toBe(true);
    expect(r.steps[0]!.signals).toEqual(['HTTP 409 POST /api/tickets/7/close']);
  });

  it('页面自己的报错要报 (不是资源加载那种)', async () => {
    const tools = makeTools({ console: [{ level: 'error', text: '[pageerror] TypeError: x is undefined' }] });
    const r = await runBrowserScript({ steps: [click()] }, tools);
    expect(r.steps[0]!.signals).toEqual(['console.error: [pageerror] TypeError: x is undefined']);
  });

  it('什么都没发生就没有这些字段 —— 别给模型塞空数组', async () => {
    const r = await runBrowserScript({ steps: [click()] }, makeTools());
    const s = r.steps[0]!;
    expect(s.signals).toBeUndefined();
    expect(s.dialog).toBeUndefined();
    expect(s.appeared).toBeUndefined();
  });

  it('只读动作不取文字基线, 也不报 appeared', async () => {
    const tools = makeTools({ texts: ['a', 'a\nb'] });
    tools.set('browser_get_text', { name: 'browser_get_text', function: async () => JSON.stringify({ ok: true, text: 'x' }) } as unknown as Tool);
    const r = await runBrowserScript({ steps: [{ action: 'get_text', args: {} }] }, tools);
    expect(r.steps[0]!.appeared).toBeUndefined();
  });
});

describe('新出现的文字', () => {
  it('toast 出现在动作之后 → appeared', async () => {
    const tools = makeTools({
      texts: ['ID\t标题\n7\t通知重复推送两次 #7', 'ID\t标题\n7\t通知重复推送两次 #7\n关闭失败: 这条工单已锁定, 不能改'],
    });
    const r = await runBrowserScript({ steps: [click()] }, tools);
    expect(r.steps[0]!.appeared).toBe('关闭失败: 这条工单已锁定, 不能改');
  });

  it('diffAppeared: 只报新行, 重复行去重, 超长截断', () => {
    expect(diffAppeared('a\nb', 'a\nb')).toBeUndefined();
    expect(diffAppeared('a', 'a\nx\nx\ny')).toBe('x | y');
    expect(diffAppeared('', 'z'.repeat(300), 20)).toHaveLength(20);
  });
});

/* ───  Flash 基准第二批 ──────────────────────────────────────────── */

describe('expectChange 早停', () => {
  /** eval 返回: 签名请求 → 固定不变; innerText 请求 → 动作后多了一行 */
  function stallTools(o: { appeared?: string; network?: unknown[] }) {
    const t = (name: string, fn: (a: Record<string, unknown>) => unknown): [string, Tool] =>
      [name, { name, function: async (a: Record<string, unknown>) => JSON.stringify(fn(a)) } as unknown as Tool];
    let textCalls = 0;
    return new Map<string, Tool>([
      t('browser_click', () => ({ ok: true })),
      t('browser_eval', (a) => {
        const expr = String(a.expression ?? '');
        if (expr.includes('innerText') && !expr.includes('data-neox-ref') && !expr.includes('querySelectorAll(')) {
          textCalls++;
          return { ok: true, result: textCalls === 1 ? 'row' : `row\n${o.appeared ?? ''}`.trimEnd() };
        }
        return { ok: true, result: '3:abc:row' };   /* 签名: 永远不变 */
      }),
      t('browser_get_network', () => ({ ok: true, requests: o.network ?? [], total: 0 })),
      t('browser_get_console_logs', () => ({ ok: true, logs: [], total: 0 })),
    ]);
  }
  const step = { action: 'click' as const, args: { selector: '.close' }, expectChange: { watch: { selector: 'tbody tr' }, timeoutMs: 8000 } };

  it('请求被拒 → 立刻停, 不等满 8 秒, 原因里有状态码', async () => {
    const t0 = Date.now();
    const r = await runBrowserScript({ steps: [step] }, stallTools({ network: [{ method: 'POST', url: 'http://x/api/close', status: 409 }] }));
    expect(r.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.steps[0]!.error).toMatch(/HTTP 409/);
  });

  it('页面冒出确认框 → 连续两拍仍没变就停, 原因里带那段文字', async () => {
    const t0 = Date.now();
    const r = await runBrowserScript({ steps: [step] }, stallTools({ appeared: '确认关闭工单 #3? | 取消 | 确认' }));
    expect(r.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3500);
    expect(r.steps[0]!.error).toMatch(/确认关闭工单 #3/);
  });

  it('只读动作上的 expectChange 直接跳过 —— wait_for 成功本身就是条件满足', async () => {
    const tools = stallTools({});
    tools.set('browser_wait_for', { name: 'browser_wait_for', function: async () => JSON.stringify({ ok: true, elapsed: 5 }) } as unknown as Tool);
    const t0 = Date.now();
    const r = await runBrowserScript({ steps: [{ action: 'wait_for', args: { selector: 'tbody tr' }, expectChange: { watch: { selector: 'tbody tr' } } }] }, tools);
    expect(r.ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('参数写法宽容', () => {
  it('repeat 的 untilGone/do 塞在 args 里也认', async () => {
    let clicks = 0; let q = 0;
    const t = (name: string, fn: () => unknown): [string, Tool] =>
      [name, { name, function: async () => JSON.stringify(fn()) } as unknown as Tool];
    const tools = new Map<string, Tool>([
      t('browser_query', () => ({ ok: true, count: [2, 1, 0][Math.min(q++, 2)] })),
      t('browser_click', () => { clicks++; return { ok: true }; }),
      t('browser_eval', () => ({ ok: true, result: '' })),
    ]);
    const r = await runBrowserScript({ steps: [{ action: 'repeat', args: { untilGone: 'tr', do: [{ action: 'click', args: { selector: 'tr .x' } }] } } as never] }, tools);
    expect(r.ok).toBe(true);
    expect(clicks).toBe(2);
  });
});

/* ───  往返分析 (第七刀) ─────────────────────────────────────────── */

describe('少一次往返', () => {
  const t = (name: string, fn: (a: Record<string, unknown>) => unknown): [string, Tool] =>
    [name, { name, function: async (a: Record<string, unknown>) => JSON.stringify(fn(a)) } as unknown as Tool];

  it('expectChange 少写 watch 一层 ({selector}) 也认, 不再报 "in operator"', async () => {
    let sigCalls = 0;
    const tools = new Map<string, Tool>([
      t('browser_click', () => ({ ok: true })),
      t('browser_eval', (a) => {
        const expr = String(a.expression ?? '');
        if (expr.includes('querySelectorAll(')) { sigCalls++; return { ok: true, result: sigCalls === 1 ? '3:a:x' : '2:b:y' }; }
        return { ok: true, result: '' };
      }),
    ]);
    const r = await runBrowserScript({ steps: [{ action: 'click', args: { selector: '#yes' }, expectChange: { selector: 'tbody tr', timeoutMs: 2000 } as never }] }, tools);
    expect(r.ok).toBe(true);
    expect(r.steps[0]!.error).toBeUndefined();
  });

  it('快照前等页面稳: 文字还在变就多等, 稳了立刻拍', async () => {
    let n = 0;
    const tools = new Map<string, Tool>([
      t('browser_get_text', () => ({ ok: true, text: 'x' })),
      t('browser_eval', (a) => {
        const expr = String(a.expression ?? '');
        if (expr.includes('textContent')) { n++; return { ok: true, result: n < 3 ? `${n}:h${n}` : '3:h3' }; }
        return { ok: true, result: {} };
      }),
    ]);
    const t0 = Date.now();
    await runBrowserScript({ steps: [{ action: 'get_text', args: {} }] }, tools);
    const spent = Date.now() - t0;
    expect(n).toBeGreaterThanOrEqual(4);          /* 变了两次, 第四次跟第三次一样才算稳 */
    expect(spent).toBeGreaterThanOrEqual(300);
    expect(spent).toBeLessThan(1500);
  });

  it('repeat 一轮之后目标要等异步重绘, 不是立刻数到旧的就判"没少"', async () => {
    let q = 0; let clicks = 0;
    const tools = new Map<string, Tool>([
      /* 第 1 次 3; 一轮做完立刻数还是 3 (旧 DOM); 200ms 后变 2; 再一轮后 0 */
      t('browser_query', () => ({ ok: true, count: [3, 3, 3, 2, 0][Math.min(q++, 4)] })),
      t('browser_click', () => { clicks++; return { ok: true }; }),
      t('browser_eval', () => ({ ok: true, result: '' })),
    ]);
    const r = await runBrowserScript({ steps: [{ action: 'repeat', untilGone: 'tr', do: [{ action: 'click', args: { selector: 'tr .x' } }] }] }, tools);
    expect(r.ok).toBe(true);
    expect(clicks).toBe(2);
  });
});
