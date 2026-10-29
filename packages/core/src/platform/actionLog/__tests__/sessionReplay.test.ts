import { describe, it, expect } from 'vitest';
import { buildReplay, renderReplayMarkdown } from '../sessionReplay.js';
import type { ActionLogEvent } from '@neoxlabs/platform/platform/actionLog/types.js';

let seq = 0;
function ev(type: string, data: Record<string, unknown>, extra: Partial<ActionLogEvent> = {}): ActionLogEvent {
  return {
    schemaVersion: 1, id: `e${++seq}`, seq, ts: 1_700_000_000_000 + seq * 1000,
    workspaceId: 'w', workspacePath: '/repo',
    sessionId: 's1', runId: 'r1', type: type as ActionLogEvent['type'], data,
    ...extra,
  } as ActionLogEvent;
}

describe('buildReplay', () => {
  it('一轮的提问 / 模型 / 工具 / 结果全拼得回来', () => {
    const [s] = buildReplay([
      ev('run_start', { prompt: '把测试跑一遍' }),
      ev('run_attempt', { model: 'deepseek-v4-flash' }),
      ev('tool_call_start', { name: 'execute_shell', toolId: 't1', argsPreview: '{"command":"npm test"}' }),
      ev('tool_call_end', { name: 'execute_shell', toolId: 't1', success: true, summary: '$ npm test → 全绿' }),
      ev('run_result', { failed: false, durationMs: 1253 }),
    ]);
    expect(s.runs).toHaveLength(1);
    const run = s.runs[0]!;
    expect(run.prompt).toBe('把测试跑一遍');
    expect(run.model).toBe('deepseek-v4-flash');
    expect(run.outcome).toBe('ok');
    expect(run.tools[0]).toMatchObject({ name: 'execute_shell', ok: true, result: '$ npm test → 全绿' });
  });

  it('**有 run_result 不等于成功** —— failed:true 要算失败', () => {
    const [s] = buildReplay([
      ev('run_start', { prompt: 'x' }),
      ev('run_result', { failed: true, outputPreview: '编译没过' }),
    ]);
    expect(s.runs[0]!.outcome).toBe('error');
    expect(s.runs[0]!.error).toContain('编译没过');
  });

  it('没有收尾记录的轮次是 unfinished, 不能当成功', () => {
    const [s] = buildReplay([ev('run_start', { prompt: 'x' }), ev('tool_call_start', { name: 'read_file', toolId: 'a' })]);
    expect(s.runs[0]!.outcome).toBe('unfinished');
    expect(renderReplayMarkdown(s)).toContain('这一轮没有收尾记录');
  });

  it('**并发的同名工具靠 toolId 配对** —— 按名字配会把耗时和成败张冠李戴', () => {
    const [s] = buildReplay([
      ev('run_start', { prompt: 'x' }),
      ev('tool_call_start', { name: 'read_file', toolId: 'a', argsPreview: '{"path":"a.ts"}' }),
      ev('tool_call_start', { name: 'read_file', toolId: 'b', argsPreview: '{"path":"b.ts"}' }),
      /* 后开的先收 —— 并发时很常见 */
      ev('tool_call_end', { name: 'read_file', toolId: 'b', success: false, error: '没有这个文件' }),
      ev('tool_call_end', { name: 'read_file', toolId: 'a', success: true }),
      ev('run_result', { failed: false }),
    ]);
    const [a, b] = s.runs[0]!.tools;
    expect(a!.args).toContain('a.ts');
    expect(a!.ok).toBe(true);
    expect(b!.args).toContain('b.ts');
    expect(b!.ok).toBe(false);
    expect(b!.error).toBe('没有这个文件');
  });

  it('run_error 带上真正的原因', () => {
    const [s] = buildReplay([
      ev('run_start', { prompt: 'x' }),
      ev('run_error', { code: 'PROXY_503' }, { summary: 'Error PROXY_503: 上游没通道' }),
    ]);
    expect(s.runs[0]!.outcome).toBe('error');
    expect(s.runs[0]!.error).toContain('PROXY_503');
  });

  it('改过的文件从 file_change 和 files 两处都收得到, 且去重', () => {
    const [s] = buildReplay([
      ev('run_start', { prompt: 'x' }),
      ev('file_change', { filePath: 'a.ts' }),
      ev('file_change', { filePath: 'a.ts' }),
      ev('file_change', {}, { files: ['b.ts'] }),
      ev('run_result', { failed: false }),
    ]);
    expect(s.files.sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('多轮 / 多会话各归各的', () => {
    const sessions = buildReplay([
      ev('run_start', { prompt: '一' }),
      ev('run_result', { failed: false }),
      ev('run_start', { prompt: '二' }, { runId: 'r2' }),
      ev('run_result', { failed: false }, { runId: 'r2' }),
      ev('run_start', { prompt: '别的会话' }, { sessionId: 's2', runId: 'r9' }),
    ]);
    expect(sessions.map((s) => s.sessionId)).toEqual(['s1', 's2']);
    expect(sessions[0]!.runs.map((r) => r.prompt)).toEqual(['一', '二']);
  });

  it('只有收尾没有开头时如实记一条 —— 不能凭空补一个开头把"被截断"装成"完整"', () => {
    const [s] = buildReplay([
      ev('tool_call_end', { name: 'grep', toolId: 'zz', success: true }),
      ev('run_result', { failed: false }),
    ]);
    expect(s.runs[0]!.tools).toHaveLength(1);
    expect(s.runs[0]!.tools[0]).toMatchObject({ name: 'grep', ok: true });
  });
});
