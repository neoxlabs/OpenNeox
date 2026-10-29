import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../../types/index.js';
import {
  BATCH_REMINDER, batchingReminder, injectIterationAdvisories, languageDriftReminder, setMidRunCheck, silentToolCallStreak, SILENT_TOOL_CALLS_NUDGE,
} from '../runnerAdvisoryUtils.js';

const call = (name: string) => ({ id: name + Math.random(), type: 'function' as const, function: { name, arguments: '{"path":"a.ts"}' } });
const silent = (n: number): Message[] => Array.from({ length: n }, () => [
  { role: 'assistant', content: '', tool_calls: [call('readfile')] } as Message,
  { role: 'tool', tool_call_id: 'x', content: 'ok' } as Message,
]).flat();

function memoryOf(messages: Message[]) {
  const reminders: string[] = [];
  return { reminders, appendReminder: (t: string) => { reminders.push(t); }, getAll: () => messages };
}
const noAdvisor = { analyze: () => null };

describe('silentToolCallStreak', () => {
  it('从用户最后一条算起, 只调工具不写字的助手消息条数; 写了字就断', () => {
    expect(silentToolCallStreak([{ role: 'user', content: 'go' }, ...silent(3)])).toBe(3);
    expect(silentToolCallStreak([
      { role: 'user', content: 'go' }, ...silent(2),
      { role: 'assistant', content: 'Reading the config next.', tool_calls: [call('readfile')] }, ...silent(1),
    ])).toBe(1);
  });
});

describe('languageDriftReminder', () => {
  const zhUser = { role: 'user', content: '把 ledger 改成多账户\n\n<reply-language>本轮所有给用户看的话都用中文。</reply-language>' } as Message;
  const say = (content: string) => ({ role: 'assistant', content, tool_calls: [call('edit')] } as Message);
  const tool = (content: string) => ({ role: 'tool', content, tool_call_id: 'x' } as Message);

  it('中文任务里最近一句进度说明是英文 → 提醒; 中文 → 不提醒', () => {
    expect(languageDriftReminder([zhUser, say('Starting with the data layer: a new accounts module and the migration logic.')])).toMatch(/中文/);
    expect(languageDriftReminder([zhUser, say('先改数据层: 新建 accounts 模块, 再写 store 的迁移逻辑。')])).toBeNull();
  });

  it('工具图片注入 (没有标记的 user) 不打断回溯; 每轮最多两次', () => {
    const img = { role: 'user', content: [{ type: 'text', text: '[系统注入] 图片' }] } as unknown as Message;
    const en = say('All 33 tests pass. Now an end-to-end smoke test of the real CLI.');
    expect(languageDriftReminder([zhUser, img, en])).toMatch(/中文/);
    const r = languageDriftReminder([zhUser, en])!;
    expect(languageDriftReminder([zhUser, en, tool('ok' + r), en, tool('ok' + r), en])).toBeNull();
  });
});

describe('batchingReminder', () => {
  const user = { role: 'user', content: '修三个 bug\n\n<reply-language>中文</reply-language>' } as Message;
  const round = (...calls: Array<[string, string?]>) => ({
    role: 'assistant', content: '',
    tool_calls: calls.map(([name, file]) => ({ id: name + Math.random(), type: 'function' as const, function: { name, arguments: JSON.stringify(file ? { file_path: file } : { command: 'ls' }) } })),
  } as Message);
  const tool = (content = 'ok') => ({ role: 'tool', content, tool_call_id: 'x' } as Message);

  it('探索两轮还没写 → 提醒一次; 只读任务不提醒', () => {
    const msgs = [user, round(['readfile', 'a.js']), tool(), round(['execute_shell']), tool()];
    expect(batchingReminder(msgs, true)).toBe(BATCH_REMINDER);
    expect(batchingReminder(msgs, false)).toBeNull();
    expect(batchingReminder([user, round(['readfile', 'a.js']), tool()], true)).toBeNull();
    expect(batchingReminder([...msgs.slice(0, -1), tool('ok' + BATCH_REMINDER)], true)).toBeNull();
  });

  it('写起来后连着两轮各写一个不同文件 → 再提醒; 一轮写多个就不提醒', () => {
    const base = [user, round(['readfile', 'a.js']), tool('r' + BATCH_REMINDER), round(['execute_shell']), tool()];
    expect(batchingReminder([...base, round(['write_file', 't1.js']), tool(), round(['edit', 't2.js']), tool()], true)).toBe(BATCH_REMINDER);
    expect(batchingReminder([...base, round(['write_file', 't1.js'], ['edit', 't2.js']), tool(), tool()], true)).toBeNull();
    expect(batchingReminder([...base, round(['edit', 't1.js']), tool(), round(['edit', 't1.js']), tool()], true)).toBeNull();
  });
});

describe('injectIterationAdvisories', () => {
  it('沉默恰好到阈值时提醒一次, 之后不再重复', async () => {
    const at = memoryOf([{ role: 'user', content: 'go' }, ...silent(SILENT_TOOL_CALLS_NUDGE)]);
    await injectIterationAdvisories({ iteration: 3, toolMetricsHistory: [], memory: at, toolUsageAdvisor: noAdvisor });
    expect(at.reminders.join()).toMatch(/has not seen a message from you/);

    const after = memoryOf([{ role: 'user', content: 'go' }, ...silent(SILENT_TOOL_CALLS_NUDGE + 1)]);
    /* 只看沉默提醒: 只读任务, 批量写提醒不参与 */
    await injectIterationAdvisories({ iteration: 3, toolMetricsHistory: [], memory: after, toolUsageAdvisor: noAdvisor, requireMutation: false });
    expect(after.reminders).toHaveLength(0);
  });

  it('跑偏检查只在第 10、20… 轮问, 返回的提醒插进去; 检查抛错不影响这一轮', async () => {
    const check = vi.fn(async () => 'back to the request');
    setMidRunCheck('s1', check);
    const mem = memoryOf([{ role: 'user', content: 'fix the login bug' }, ...silent(2)]);
    await injectIterationAdvisories({ iteration: 7, toolMetricsHistory: [], memory: mem, toolUsageAdvisor: noAdvisor, sessionId: 's1', task: 'fix the login bug' });
    expect(check).not.toHaveBeenCalled();
    await injectIterationAdvisories({ iteration: 10, toolMetricsHistory: [], memory: mem, toolUsageAdvisor: noAdvisor, sessionId: 's1', task: 'fix the login bug' });
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ task: 'fix the login bug', iteration: 10, recent: expect.stringContaining('readfile') }));
    expect(mem.reminders).toContain('back to the request');

    setMidRunCheck('s1', async () => { throw new Error('boom'); });
    await expect(injectIterationAdvisories({ iteration: 20, toolMetricsHistory: [], memory: mem, toolUsageAdvisor: noAdvisor, sessionId: 's1', task: 't' })).resolves.toBeUndefined();
    setMidRunCheck('s1', null);
  });
});
