import { describe, expect, it } from 'vitest';
import { getLastUserTask, isControlPrompt } from '../agentRuntimeHostHelpers.js';

const RESUME = '[NEOX_RESUME] 服务已重启, 请基于已有对话历史继续.';

describe('isControlPrompt', () => {
  it('认出续跑 / 自动续推的控制消息', () => {
    expect(isControlPrompt(RESUME)).toBe(true);
    expect(isControlPrompt('[NEOX_TARGET_CONTINUE] 目标还没完成')).toBe(true);
  });

  it('前面垫着 system-reminder 也认得出', () => {
    expect(isControlPrompt(`<system-reminder>\nplan mode off\n</system-reminder>\n\n${RESUME}`)).toBe(true);
  });

  it('数组形态的消息内容也看', () => {
    expect(isControlPrompt([{ type: 'text', text: RESUME }])).toBe(true);
  });

  it('用户的话 → false, 哪怕正文里提到了这个标记', () => {
    expect(isControlPrompt('为什么会出现 [NEOX_RESUME] 这条消息?')).toBe(false);
    expect(isControlPrompt('Plan a 5-day Kyoto trip')).toBe(false);
  });
});

describe('getLastUserTask', () => {
  it('跳过控制消息, 取用户真正说的最后一句', () => {
    const history = [
      { role: 'user', content: '把重复 code 的 500 改成 409' },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: RESUME },
    ];
    expect(getLastUserTask(history)).toBe('把重复 code 的 500 改成 409');
  });
});
