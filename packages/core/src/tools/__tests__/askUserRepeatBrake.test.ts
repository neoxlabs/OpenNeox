/**
 * ask_user 的重复提问保护。
 * 连续 N 次没有有效回答（超时、中断或主动取消）后拒绝下一次提问；收到有效回答后
 * 清零计数，让后续问题重新获得额度。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const load = async () => {
  vi.resetModules();
  return import('../askUserTool.js');
};

describe('连续没人答 → 拒绝再问', () => {
  beforeEach(() => { vi.resetModules(); });

  it('第 3 次 (limit=2) 直接 refused, 不再弹 UI', async () => {
    const mod = await load();
    let uiCalls = 0;
    mod.setAskUserUICallback((id: string) => { uiCalls++; return 'sess-brake'; });
    /* 前两次: 弹 UI 后立刻按"用户主动取消"收尾 → 各记一次没答 */
    for (let i = 0; i < 2; i++) {
      const p = mod.askUserTool.function({ questions: [{ question: `Q${i}`, options: ['A', 'B'] }] } as any);
      mod.resolveUserQuestion('', { __dismiss__: 'x' } as any);
      const out = JSON.parse(await p as string);
      expect(out.status).toBe('dismissed');
    }
    expect(uiCalls).toBe(2);

    const third = JSON.parse(await mod.askUserTool.function({
      questions: [{ question: '再问一次', options: ['A', 'B'] }],
    } as any) as string);
    expect(third.status).toBe('refused');
    expect(third.reason).toBe('user_not_responding');
    expect(third.message).toContain('自己');
    expect(uiCalls, '被拒的这次不该再弹 UI').toBe(2);
  });

  it('用户真答过 → 额度清零, 还能继续问', async () => {
    const mod = await load();
    mod.setAskUserUICallback(() => 'sess-brake2');
    const p1 = mod.askUserTool.function({ questions: [{ question: 'Q1', options: ['A'] }] } as any);
    mod.resolveUserQuestion('', { __dismiss__: 'x' } as any);
    await p1;

    const p2 = mod.askUserTool.function({ questions: [{ question: 'Q2', options: ['A'] }] } as any);
    mod.resolveUserQuestion('', { Q2: 'A' } as any);   /* 真答复 */
    await p2;

    /* 清零后再连问两次仍应正常弹 UI (不是第 3 次就被拒) */
    const p3 = mod.askUserTool.function({ questions: [{ question: 'Q3', options: ['A'] }] } as any);
    mod.resolveUserQuestion('', { __dismiss__: 'x' } as any);
    const out3 = JSON.parse(await p3 as string);
    expect(out3.status).toBe('dismissed');
  });
});
