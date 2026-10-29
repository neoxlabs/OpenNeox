
import type { Message } from '@neoxlabs/kernel/types/index.js';

/**
 * system 消息也原样带上 (顺序不变): 主会话内存里的系统提示跟 parentRenderedPrompt 并不逐字相同
 * (运行时还会追加署名等打标段), 用那份重拼 = 前缀对不上, 缓存全冷。
 */
export function buildForkMessages(parent: Message[]): Message[] {
  const msgs = parent;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
    const answered = new Set(msgs.slice(i + 1).filter((x) => x.role === 'tool').map((x) => x.tool_call_id));
    const pending = m.tool_calls.some((c) => !answered.has(c.id));
    return pending ? msgs.slice(0, i) : msgs;
  }
  return msgs;
}

/** fork 的任务消息: 身份放在这里而不是系统提示 —— 系统提示要跟主会话字节一致才吃得到缓存 */
export function buildForkPrompt(task: string): string {
  return [
    '<fork>',
    'You are a forked worker, not the main conversation. The messages above are shared context: every file read and tool result there is visible to you, so do not look them up again.',
    'The main conversation is still handling the user\'s request above, including the step that dispatched you. Do not redo or continue any of it.',
    'Your only job is the task below. Do not call the agent or explore tools.',
    'When done, report in one short block: the conclusion, the files you changed (paths), and anything left undone. The main conversation sees only this report.',
    '</fork>',
    '',
    task,
  ].join('\n');
}
