import { describe, it, expect, beforeEach } from 'vitest';
import { setLanguage } from '../../i18n/index.js';
import {
  cancelRemoteAskUserFlow,
  formatRemoteAnswerReceipt,
  handleRemoteAskUserEventFlow,
} from '../remoteInteractionFlows.js';
import { replyRemoteAskUserInMain } from '../remoteAskUserMainBridge.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeEvent(questions: string[]) {
  return {
    requestId: 'req-1',
    questions: questions.map((question) => ({ question, options: [{ label: '保留' }] })),
  };
}

describe('ask_user 撤销 (手机先答)', () => {
  beforeEach(() => {
    setLanguage('zh');
  });

  it('回执文案: 单题只给答案, 多题带上问题', () => {
    expect(formatRemoteAnswerReceipt({ 要不要保留兼容: '保留' })).toBe('已在手机上回答: 保留');
    expect(formatRemoteAnswerReceipt({ q1: 'a', q2: 'b' })).toBe('已在手机上回答: q1: a；q2: b');
    /* 空答案不拼出 「…: 」 这种半行 */
    expect(formatRemoteAnswerReceipt({})).toBe('已在手机上回答');
    expect(formatRemoteAnswerReceipt({ q: '  ' })).toBe('已在手机上回答');
  });

  it('撤销后收起选择框、不再弹下一题、终端不再回一个空答案', async () => {
    const replies: Array<{ id: string; answers: Record<string, string> }> = [];
    const answered: Array<{ id: string; answers: Record<string, string> }> = [];
    const questionAsked: string[] = [];
    let cancelActivePrompt = 0;
    let releasePrompt!: (value: string | null) => void;

    const flow = handleRemoteAskUserEventFlow({
      event: makeEvent(['要不要保留兼容', '要不要迁移数据']),
      sdkClient: {
        replyAskUser: async (id, answers) => {
          replies.push({ id, answers });
        },
      },
      promptSelection: async ({ questionText }) => {
        questionAsked.push(questionText);
        return new Promise<string | null>((resolve) => {
          releasePrompt = resolve;
        });
      },
      logInfo: () => {},
      cancelActivePrompt: () => {
        cancelActivePrompt++;
        releasePrompt?.(null);
      },
      onAnswered: (id, answers) => {
        answered.push({ id, answers });
      },
    });

    await tick();
    expect(questionAsked).toEqual(['要不要保留兼容']);

    expect(cancelRemoteAskUserFlow('req-1')).toBe(true);
    await flow;

    expect(cancelActivePrompt).toBe(1);
    /* 第二题没弹 —— 手机答完后台已经在跑了 */
    expect(questionAsked).toEqual(['要不要保留兼容']);
    /* 手机自己走 replyAskUser, 终端再回一次会把答案覆盖成空 */
    expect(replies).toEqual([]);
    expect(answered).toEqual([]);
    /* 流程收尾后撤销口要清掉 */
    expect(cancelRemoteAskUserFlow('req-1')).toBe(false);
  });

  it('终端先答: 照常回复并通知手机翻成已答', async () => {
    const replies: Array<{ id: string; answers: Record<string, string> }> = [];
    const answered: Array<{ id: string; answers: Record<string, string> }> = [];
    const userMessages: string[] = [];

    await handleRemoteAskUserEventFlow({
      event: makeEvent(['要不要保留兼容']),
      sdkClient: {
        replyAskUser: async (id, answers) => {
          replies.push({ id, answers });
        },
      },
      promptSelection: async () => '保留',
      addUserMessage: (message) => userMessages.push(message),
      logInfo: () => {},
      cancelActivePrompt: () => {},
      onAnswered: (id, answers) => {
        answered.push({ id, answers });
      },
    });

    expect(replies).toEqual([{ id: 'req-1', answers: { 要不要保留兼容: '保留' } }]);
    expect(answered).toEqual([{ id: 'req-1', answers: { 要不要保留兼容: '保留' } }]);
    expect(userMessages).toEqual(['Q: 要不要保留兼容\nA: 保留']);
    expect(cancelRemoteAskUserFlow('req-1')).toBe(false);
  });

  it('答晚了 (问题已超时作废): 问答当新消息发出去, 不重复回显、不通知已答', async () => {
    const late: string[] = [];
    const answered: string[] = [];
    const userMessages: string[] = [];

    await handleRemoteAskUserEventFlow({
      event: makeEvent(['按这个顺序动手吗']),
      sdkClient: { replyAskUser: async () => ({ status: 'orphan' as const }) },
      promptSelection: async () => '算了',
      addUserMessage: (message) => userMessages.push(message),
      logInfo: () => {},
      onAnswered: (id) => { answered.push(id); },
      submitLateAnswer: (text) => { late.push(text); },
    });

    expect(late).toEqual(['Q: 按这个顺序动手吗\nA: 算了']);
    expect(userMessages).toEqual([]);
    expect(answered).toEqual([]);
  });

  it('撤销一个不存在的请求是无操作', () => {
    expect(cancelRemoteAskUserFlow('nope')).toBe(false);
  });

  it('手机答复接线: 收框 + 留回执 + 把答案转给 runtime', async () => {
    const userMessages: string[] = [];
    const replies: Array<{ id: string; answers: Record<string, string> }> = [];
    let releasePrompt!: (value: string | null) => void;

    const flow = handleRemoteAskUserEventFlow({
      event: makeEvent(['要不要保留兼容']),
      sdkClient: { replyAskUser: async () => {} },
      promptSelection: async () =>
        new Promise<string | null>((resolve) => {
          releasePrompt = resolve;
        }),
      logInfo: () => {},
      cancelActivePrompt: () => releasePrompt?.(null),
    });
    await tick();

    const closed = replyRemoteAskUserInMain({
      requestId: 'req-1',
      answers: { 要不要保留兼容: '保留' },
      uiController: { addUserMessage: (message) => userMessages.push(message) },
      reply: (id, answers) => replies.push({ id, answers }),
    });
    await flow;

    expect(closed).toBe(true);
    expect(userMessages).toEqual(['已在手机上回答: 保留']);
    expect(replies).toEqual([{ id: 'req-1', answers: { 要不要保留兼容: '保留' } }]);
  });

  it('终端没在等 (已答/已过期) 时不打回执, 但答案照样转给 runtime', () => {
    const userMessages: string[] = [];
    const replies: Array<{ id: string; answers: Record<string, string> }> = [];

    const closed = replyRemoteAskUserInMain({
      requestId: 'gone',
      answers: { q: 'a' },
      uiController: { addUserMessage: (message) => userMessages.push(message) },
      reply: (id, answers) => replies.push({ id, answers }),
    });

    expect(closed).toBe(false);
    expect(userMessages).toEqual([]);
    expect(replies).toEqual([{ id: 'gone', answers: { q: 'a' } }]);
  });
});
