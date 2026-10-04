import { afterEach, describe, expect, it } from 'vitest';
import { callUserTool, setCallUserExecutor, type CallUserRequest } from '../callTools.js';

const run = (args: unknown) => (callUserTool.function as (a: unknown) => Promise<string>)(args).then((s) => JSON.parse(s));

describe('call_user', () => {
  afterEach(() => setCallUserExecutor(null));

  it('没有宿主 (CLI) 时如实说不可用, 并让模型改发消息', async () => {
    const r = await run({ reason: '周报', opening: '周报写完了', urgency: 'asked' });
    expect(r.success).toBe(false);
    expect(r.status).toBe('blocked');
    expect(r.next).toMatch(/message/i);
  });

  it('把理由 / 开场白 / 紧急度原样交给宿主, 接通算成功', async () => {
    let got: CallUserRequest | null = null;
    setCallUserExecutor(async (req) => { got = req; return { status: 'answered' }; });
    const r = await run({ reason: ' 部署失败 ', opening: '部署挂了, 我先回滚了', urgency: 'alert' });
    expect(got).toMatchObject({ reason: '部署失败', opening: '部署挂了, 我先回滚了', urgency: 'alert' });
    expect(r).toMatchObject({ success: true, status: 'answered' });
  });

  it('没接 / 拒接不算成功, 并提示别马上再打', async () => {
    setCallUserExecutor(async () => ({ status: 'missed' }));
    const missed = await run({ reason: 'x', opening: 'y', urgency: 'decision' });
    expect(missed).toMatchObject({ success: false, status: 'missed' });
    expect(missed.next).toMatch(/do not call again/i);
  });

  it('紧急度写错按 normal, 缺开场白直接拒', async () => {
    let urgency = '';
    setCallUserExecutor(async (req) => { urgency = req.urgency; return { status: 'busy', detail: 'quiet hours' }; });
    const r = await run({ reason: 'x', opening: 'y', urgency: 'whenever' });
    expect(urgency).toBe('normal');
    expect(r).toMatchObject({ status: 'busy', detail: 'quiet hours' });
    const bad = await run({ reason: 'x', urgency: 'asked' });
    expect(bad.success).toBe(false);
  });

  it('宿主抛错 = 没打出去', async () => {
    setCallUserExecutor(async () => { throw new Error('host call timeout: callUser'); });
    const r = await run({ reason: 'x', opening: 'y', urgency: 'asked' });
    expect(r).toMatchObject({ success: false, status: 'blocked' });
  });
});
