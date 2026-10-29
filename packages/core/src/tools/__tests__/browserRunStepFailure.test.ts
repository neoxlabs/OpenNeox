import { describe, it, expect } from 'vitest';
import { runBrowserScript } from '../../runtime/browser/browserRun';
import type { Tool } from '@neox/kernel';

/**
 *  agent 自己在运行报告里点出来的:
 * 「wait_for kind=function 在本环境里会立刻返回成功、不做真正轮询」。
 *
 * 真因不在 wait_for, 在 browser_run 的成败判据: 它只认**字符串**形态的失败
 * (`/^(Error|error:||Failed)/`), 而所有浏览器工具返回的都是 JSON 化的**对象信封**
 * `{"ok":false,"error":"..."}` —— 前缀是 `{`, 一条都不匹配, 于是工具级失败全被判成成功。
 * 少传 predicate 时工具立刻返 `{ok:false,error:'predicate required'}`, 表现就是"秒过"。
 */
function fakeTool(name: string, payload: unknown): [string, Tool] {
  return [name, { name, function: async () => JSON.stringify(payload) } as unknown as Tool];
}

describe('browser_run 步骤成败判据', () => {
  it('工具返回 {ok:false} 必须判失败 —— 不能秒过', async () => {
    const tools = new Map<string, Tool>([
      fakeTool('browser_wait_for', { ok: false, error: 'predicate required' }),
    ]);
    const r = await runBrowserScript(
      { steps: [{ action: 'wait_for', args: { kind: 'function' } }] },
      tools,
    );
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe(0);
    expect(r.steps[0]!.ok).toBe(false);
    expect(r.steps[0]!.error).toContain('predicate required');
  });

  it('等待超时同样是失败', async () => {
    const tools = new Map<string, Tool>([
      fakeTool('browser_wait_for', { ok: false, error: 'timeout after 8000ms', elapsed: 8000 }),
    ]);
    const r = await runBrowserScript(
      { steps: [{ action: 'wait_for', args: { kind: 'selector', selector: '#nope' } }] },
      tools,
    );
    expect(r.ok).toBe(false);
    expect(r.steps[0]!.error).toContain('timeout');
  });

  it('{ok:true} 正常放行', async () => {
    const tools = new Map<string, Tool>([
      fakeTool('browser_click', { ok: true, clicked: '#go' }),
    ]);
    const r = await runBrowserScript(
      { steps: [{ action: 'click', args: { selector: '#go' } }] },
      tools,
    );
    expect(r.ok).toBe(true);
    expect(r.steps[0]!.ok).toBe(true);
  });

  it('optional 的步骤失败了继续往下走', async () => {
    const tools = new Map<string, Tool>([
      fakeTool('browser_wait_for', { ok: false, error: 'timeout' }),
      fakeTool('browser_click', { ok: true }),
    ]);
    const r = await runBrowserScript(
      {
        steps: [
          { action: 'wait_for', args: { kind: 'selector', selector: '#x' }, optional: true },
          { action: 'click', args: { selector: '#go' } },
        ],
      },
      tools,
    );
    expect(r.ok).toBe(true);
    expect(r.steps[0]!.ok).toBe(false);
    expect(r.steps[1]!.ok).toBe(true);
  });
});
