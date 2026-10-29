import { describe, expect, it } from 'vitest';
import { dropIncompleteTurnTail } from '../incompleteTurnDiscard.js';

const THINKING = 'The user wants the build fixed. Let me call the shell tool.\n<｜DSML｜invoke name="bash">';

describe('dropIncompleteTurnTail (残缺 DSML 重来)', () => {
  it('撤掉这一轮末尾的正文, 前面几轮的回答留着', () => {
    const acc: [string, string, string] = [`前面那轮的回答。\n\n${THINKING}`, THINKING, `第一轮。\n\n${THINKING}`];
    const [fullResponse, lastAssistantMessage, currentTurnText] = dropIncompleteTurnTail(acc, { discardedText: THINKING });
    expect(fullResponse.trimEnd()).toBe('前面那轮的回答。');
    expect(lastAssistantMessage).toBe('');
    expect(currentTurnText.trimEnd()).toBe('第一轮。');
  });

  it('没带正文 (老 kernel / 云端没透传) → 原样不动', () => {
    const acc: [string, string, string] = ['a', 'b', 'c'];
    expect(dropIncompleteTurnTail(acc, {})).toBe(acc);
    expect(dropIncompleteTurnTail(acc, undefined)).toBe(acc);
    expect(dropIncompleteTurnTail(acc, { discardedText: 42 })).toBe(acc);
  });

  it('对不上 (已经被别的路径改过) → 原样不动, 不猜', () => {
    const acc: [string, string, string] = ['别的内容', '别的内容', '别的内容'];
    expect(dropIncompleteTurnTail(acc, { discardedText: THINKING })).toEqual(acc);
  });
});
