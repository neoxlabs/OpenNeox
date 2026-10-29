import { describe, it, expect } from 'vitest';
import { isBusEventMessage, detectSystemMessage, detectSystemMessages } from '../cells/systemMessageParsers';
import { humanCron, humanDuration } from '../cells/SystemNoticeCell';

describe('isBusEventMessage', () => {
  it.each([
    '<background-task-notification><pid>1</pid></background-task-notification>',
    '<agent-completion><agent-id>a</agent-id></agent-completion>',
    '<scheduled-wakeup><reason>r</reason></scheduled-wakeup>',
    '<scheduled-task-fired><prompt>p</prompt></scheduled-task-fired>',
    '<life-reminder-fired><title>t</title></life-reminder-fired>',
    '  <monitor-event><label>x</label></monitor-event>',
  ])('认得 %s', (text) => expect(isBusEventMessage(text)).toBe(true));

  it('用户自己写的 XML 样子的话不算', () => {
    expect(isBusEventMessage('帮我看看 <monitor-event> 这个标签')).toBe(false);
    expect(isBusEventMessage('<div>hi</div>')).toBe(false);
  });
});

describe('monitor-event 解析', () => {
  it('命中: 取 label 和命中的行', () => {
    const hit = detectSystemMessage(`<monitor-event>
<monitor-id>mon-1</monitor-id>
<label>盯服务报错</label>
<outcome>fired</outcome>
<watching>output of pid 3 matches /error/i</watching>
<fire>1/1 (ended)</fire>
<detail>Matched 1 line(s) in the output of pid 3:
TypeError: x is &lt;undefined&gt;</detail>
<prompt>修掉</prompt>
</monitor-event>`);
    expect(hit?.kind).toBe('monitor_event');
    expect(hit && hit.kind === 'monitor_event' && hit.data).toMatchObject({
      label: '盯服务报错', outcome: 'fired', detail: expect.stringContaining('TypeError: x is <undefined>'),
    });
  });
});

describe('定时任务 / 提醒 解析', () => {
  it('scheduled-task-fired', () => {
    const hit = detectSystemMessage('<scheduled-task-fired>\n<cron>0 9 * * 1-5</cron>\n<prompt>看下 PR</prompt>\n<late-by-minutes>3</late-by-minutes>\n</scheduled-task-fired>');
    expect(hit).toEqual({ kind: 'scheduled_task', data: { cron: '0 9 * * 1-5', prompt: '看下 PR', lateByMinutes: 3 } });
  });
  it('life-reminder-fired', () => {
    const hit = detectSystemMessage('<life-reminder-fired>\n<title>喝水</title>\n</life-reminder-fired>');
    expect(hit).toEqual({ kind: 'reminder', data: { title: '喝水', context: undefined, lateByMinutes: undefined } });
  });
});

describe('一条消息拼了几件事', () => {
  it('每一段都认出来, 按原顺序', () => {
    const hits = detectSystemMessages([
      '<background-task-notification><pid>7</pid><command>sleep 20; echo BUILD READY</command><status>completed</status><exit-code>0</exit-code><summary>ok</summary></background-task-notification>',
      '<monitor-event><label>等 READY</label><outcome>fired</outcome><watching>w</watching><fire>1/1 (ended)</fire><detail>Matched 1 line(s):\nBUILD READY</detail></monitor-event>',
    ].join('\n'));
    expect(hits.map((h) => h.kind)).toEqual(['background_shell', 'monitor_event']);
  });
  it('不是总线消息就一个都不认', () => {
    expect(detectSystemMessages('帮我看看 <monitor-event><label>x</label></monitor-event>')).toEqual([]);
  });
});

describe('humanCron / humanDuration', () => {
  it.each([
    ['* * * * *', '每分钟'],
    ['*/5 * * * *', '每 5 分钟'],
    ['0 9 * * *', '每天 09:00'],
    ['30 18 * * 1-5', '工作日 18:30'],
    ['0 10 * * 1', '每周一 10:00'],
    ['0 8 1 * *', '每月 1 日 08:00'],
    ['0 8 1,15 * *', '0 8 1,15 * *'],
  ])('%s → %s', (expr, want) => expect(humanCron(expr, true)).toBe(want));

  it('十分钟内带秒, 不把 90 秒说成 2 分钟', () => {
    expect(humanDuration(90, true)).toBe('1 分 30 秒');
    expect(humanDuration(120, true)).toBe('2 分钟');
    expect(humanDuration(45, true)).toBe('45 秒');
    expect(humanDuration(3900, true)).toBe('1 小时 5 分');
  });
});
