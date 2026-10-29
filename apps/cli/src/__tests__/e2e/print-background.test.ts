import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeGateway, type FakeGateway } from './infra/fakeGateway.js';
import { createCliWorkspace, type CliWorkspace } from './infra/workspace.js';
import { runCli, type CliResult } from './infra/runCli.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });


describe('cli e2e · print mode waits for background work', () => {
  let ws: CliWorkspace;
  let gw: FakeGateway;

  beforeAll(async () => {
    gw = await startFakeGateway({ defaultText: 'mock default reply' });
    ws = await createCliWorkspace({ providers: [{ baseUrl: gw.baseUrl, model: 'mock-model' }] });
  }, 60_000);

  afterAll(async () => {
    await ws?.cleanup();
    await gw?.stop();
  });

  const run = (args: string[], opts: Parameters<typeof runCli>[2] = {}) =>
    runCli(ws, args, { timeoutMs: 60_000, ...opts });

  /** 最后一个 user 消息 —— 后台通知就是作为 user prompt 注入的 */
  function lastUserText(body: any): string {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const last = [...messages].reverse().find((m: any) => m?.role === 'user');
    if (!last) return '';
    if (typeof last.content === 'string') return last.content;
    if (Array.isArray(last.content)) {
      return last.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('');
    }
    return '';
  }

  /** 从注入的 <background-task-notification> 里取 pid, 给 bash_output 用 */
  function pidFromNotification(body: any): number {
    const match = /<pid>(\d+)<\/pid>/.exec(lastUserText(body));
    if (!match) throw new Error('通知里没有 <pid>');
    return Number(match[1]);
  }

  function expectSingleJson(result: CliResult): { result: string | null; error: string | null } {
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0]);
  }

  it('waits for a 2s background command, wakes the model with its output, then exits 0', async () => {
    gw.push({
      match: 'bg settle',
      text: '我把这条命令放到后台了。',
      toolCalls: [{
        name: 'execute_shell',
        arguments: JSON.stringify({ command: 'sleep 2 && echo BG-DONE', background: true }),
      }],
    });
    gw.push({ match: 'bg settle', text: '已在后台运行, 完成后会通知我。' });
    gw.push({
      match: 'background-task-notification',
      text: '读一下后台命令的输出。',
      toolCalls: [{ name: 'bash_output', arguments: (body) => JSON.stringify({ pid: pidFromNotification(body) }) }],
    });
    gw.push({ match: 'background-task-notification', text: '后台命令输出是 BG-DONE, 任务完成。' });

    const started = Date.now();
    const result = await run(['-p', '--yolo', 'bg settle']);

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('后台命令输出是 BG-DONE');
    /* 进程必须活过那 2 秒: 首轮立刻退出时这里是 0.x 秒 */
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);

    const chats = gw.chatRequests();
    expect(chats.length).toBeGreaterThanOrEqual(4);
    const last = chats.at(-1)!;
    /* 完成通知以同样的 XML 格式送回对话 */
    expect(lastUserText(last.body)).toContain('<background-task-notification>');
    expect(lastUserText(last.body)).toContain('<status>completed</status>');
    /* 第 2 轮确实拿到了命令输出 (bash_output 的 tool result 进了上下文) */
    expect(last.rawBody).toContain('BG-DONE');
  });

  it('--json prints exactly one object, with the final turn answer', async () => {
    gw.push({
      match: 'bg json',
      text: '放到后台。',
      toolCalls: [{
        name: 'execute_shell',
        arguments: JSON.stringify({ command: 'sleep 2 && echo BG-JSON-DONE', background: true }),
      }],
    });
    gw.push({ match: 'bg json', text: '已在后台运行。' });
    gw.push({ match: 'background-task-notification', text: '后台命令输出是 BG-JSON-DONE, 结束。' });

    const result = await run(['-p', '--json', '--yolo', 'bg json']);

    expect(result.exitCode).toBe(0);
    const payload = expectSingleJson(result);
    expect(payload).toEqual({ result: '后台命令输出是 BG-JSON-DONE, 结束。', error: null });
  });

  it('a failed background command still wakes the model so it can wrap up', async () => {
    gw.push({
      match: 'bg failure',
      text: '放到后台。',
      toolCalls: [{
        name: 'execute_shell',
        /* 活过收集窗口 (≥2s): 1 秒内就退出的命令结果会内联进工具结果, 不需要完成通知 ——
         * 总控裁决: 那是正确行为。要验「失败通知照样送回」, 必须让它跑过收集窗口。 */
        arguments: JSON.stringify({ command: 'sleep 3; exit 3', background: true }),
      }],
    });
    gw.push({ match: 'bg failure', text: '后台运行中, 完成了会通知我。' });
    gw.push({ match: 'background-task-notification', text: '后台任务失败了 (exit 3), 我确认一下原因。' });

    const started = Date.now();
    const result = await run(['-p', '--yolo', 'bg failure']);

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('后台任务失败了');
    expect(Date.now() - started).toBeGreaterThanOrEqual(3000);

    const last = gw.chatRequests().at(-1)!;
    expect(lastUserText(last.body)).toContain('<status>failed</status>');
    expect(lastUserText(last.body)).toContain('<exit-code>3</exit-code>');
  });
});
