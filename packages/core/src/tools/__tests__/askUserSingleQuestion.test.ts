/**
 * ask_user 一次只问一个 (work:Q-04)
 *
 * 模型偶尔会把四个问题塞进一次调用 —— 用户面对四张选项卡, 不知道先答哪个,
 * 干脆关掉。这里锁住: 一次只把第一个问题交给 UI, 其余在 tool_result 里
 * 告诉模型「下一轮再问」, 不丢信息也不整包拒绕。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

const load = async () => {
  vi.resetModules();
  return import('../askUserTool.js');
};

describe('ask_user 单问题 (Q-04)', () => {
  beforeEach(() => { vi.resetModules(); });

  it('一次传 3 个问题 → UI 只收到第一个, 选项完整保留', async () => {
    const mod = await load();
    let seen: any[] = [];
    mod.setAskUserUICallback((_id: string, questions: any[]) => {
      seen = questions;
      return 'sess-q04';
    });

    const p = mod.askUserTool.function({
      questions: [
        { question: '先做哪个?', options: ['A 方案', 'B 方案'] },
        { question: '什么时候要?', options: ['今天', '本周'] },
        { question: '要通知谁?', options: ['老板', '客户'] },
      ],
    } as any);

    expect(seen).toHaveLength(1);
    expect(seen[0].question).toBe('先做哪个?');
    expect(seen[0].options.map((o: any) => o.label)).toEqual(['A 方案', 'B 方案']);

    mod.resolveUserQuestion('', { '先做哪个?': 'A 方案' } as any);
    const out = await p as string;
    expect(out).toContain('Q: 先做哪个?');
    expect(out).toContain('A: A 方案');
    /* 其余两个问题没丢 —— 明确告诉模型下一轮再问 */
    expect(out).toContain('2 more question(s) were not asked');
  });

  it('只传一个问题 → 行为不变, 不出现提示', async () => {
    const mod = await load();
    mod.setAskUserUICallback(() => 'sess-q04b');
    const p = mod.askUserTool.function({
      questions: [{ question: '用哪个?', options: ['A', 'B'] }],
    } as any);
    mod.resolveUserQuestion('', { '用哪个?': 'B' } as any);
    const out = await p as string;
    expect(out).toBe('Q: 用哪个?\nA: B');
  });

  it('扁平格式 {question, options} 仍然可用', async () => {
    const mod = await load();
    let seen: any[] = [];
    mod.setAskUserUICallback((_id: string, questions: any[]) => { seen = questions; return 'sess-q04c'; });
    const p = mod.askUserTool.function({ question: '继续吗?', options: ['继续', '停'] } as any);
    expect(seen).toHaveLength(1);
    expect(seen[0].question).toBe('继续吗?');
    mod.resolveUserQuestion('', { '继续吗?': '继续' } as any);
    await p;
  });
});
