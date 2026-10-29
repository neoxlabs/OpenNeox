import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeGateway, type FakeGateway } from './infra/fakeGateway.js';
import { createCliWorkspace, type CliWorkspace } from './infra/workspace.js';
import { runCli, type CliResult } from './infra/runCli.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

/**
 * 非交互输出格式 / 本地假网关行为:
 *   --json 结构、流式纯文本、provider/model 解析、上游错误、--timeout、--yolo 权限、--workdir.
 * 全部走 127.0.0.1 假网关, 不调真实模型.
 */
describe('cli e2e · print mode output & fake gateway', () => {
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

  function parseJson(result: CliResult): { result: string | null; error: string | null } {
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    return JSON.parse(result.stdout.trim());
  }

  it('--json returns exactly one JSON object with result and null error', async () => {
    gw.push({ match: 'json success', text: 'hello from mock' });
    const result = await run(['-p', '--json', 'json success']);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const payload = parseJson(result);
    expect(payload).toEqual({ result: 'hello from mock', error: null });
  });

  it('plain print mode streams only the answer text', async () => {
    gw.push({ match: 'plain success', text: 'plain mock answer' });
    const result = await run(['-p', 'plain success']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('plain mock answer');
    expect(() => JSON.parse(result.stdout)).toThrow();
    expect(result.stderr).toBe('');
  });

  it('--provider and -m select the configured BYOK provider', async () => {
    gw.push({ match: 'explicit provider', text: 'explicit ok' });
    const result = await run(['-p', '--json', '--provider', 'mock-byok', '-m', 'mock-model', 'explicit provider']);
    expect(result.exitCode).toBe(0);
    expect(parseJson(result).result).toBe('explicit ok');
    expect(gw.chatRequests().at(-1)?.body.model).toBe('mock-model');
  });

  it('-m alone resolves the provider that owns the model', async () => {
    gw.push({ match: 'model only', text: 'model only ok' });
    const result = await run(['-p', '--json', '-m', 'mock-model', 'model only']);
    expect(result.exitCode).toBe(0);
    expect(parseJson(result).result).toBe('model only ok');
    expect(gw.chatRequests().at(-1)?.body.model).toBe('mock-model');
  });

  it('a positional prompt works without -p when stdin is not a TTY', async () => {
    gw.push({ match: 'positional prompt', text: 'positional ok' });
    const result = await run(['--json', 'positional prompt']);
    expect(result.exitCode).toBe(0);
    expect(parseJson(result).result).toBe('positional ok');
  });

  it('piped stdin is used as the prompt when -p is given', async () => {
    gw.push({ match: 'piped prompt', text: 'piped ok' });
    /* 注意: 不带 -p 时 (文档里的 `echo ... | neox`) 配了 provider 会进交互 TUI 并挂住,
     * 见 README「已知问题」; 这里只验证 print mode 的 stdin 读取. */
    const result = await run(['-p', '--json'], { stdin: 'piped prompt' });
    expect(result.exitCode).toBe(0);
    expect(parseJson(result).result).toBe('piped ok');
    expect(gw.chatRequests().at(-1)?.rawBody).toContain('piped prompt');
  });

  it('multiple SSE chunks are concatenated in order', async () => {
    gw.push({ match: 'chunked reply', chunks: ['alpha', ' beta', ' gamma'], text: undefined });
    const result = await run(['-p', '--json', 'chunked reply']);
    expect(result.exitCode).toBe(0);
    expect(parseJson(result).result).toBe('alpha beta gamma');
  });

  it('unicode and newlines survive --json encoding', async () => {
    gw.push({ match: 'unicode reply', text: 'line1\nline2 中文 "quoted"' });
    const result = await run(['-p', '--json', 'unicode reply']);
    expect(result.exitCode).toBe(0);
    expect(parseJson(result).result).toBe('line1\nline2 中文 "quoted"');
  });

  it('an upstream 400 surfaces the provider message and exits 1', async () => {
    gw.push({
      match: 'upstream 400',
      httpStatus: 400,
      errorBody: { error: { message: 'bad request boom', type: 'invalid_request_error' } },
    });
    const result = await run(['-p', '--json', 'upstream 400']);
    expect(result.exitCode).toBe(1);
    const payload = parseJson(result);
    expect(payload.error).toContain('bad request boom');
    expect(payload.result).toBeNull();
    expect(result.stderr).toMatch(/Error: .*bad request boom/);
  });

  it('--timeout aborts a hanging request and exits 1', async () => {
    gw.push({ match: 'hang for timeout', hang: true });
    const started = Date.now();
    const result = await run(['-p', '--timeout', '1', 'hang for timeout'], { timeoutMs: 30_000 });
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toMatch(/timed out after 1s/);
    expect(Date.now() - started).toBeLessThan(25_000);
  });

  it('--json with a timeout prints no JSON', async () => {
    gw.push({ match: 'json hang', hang: true });
    const result = await run(['-p', '--json', '--timeout', '1', 'json hang'], { timeoutMs: 30_000 });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.trim()).toBe('');
    expect(result.stderr).toMatch(/timed out after 1s/);
  });

  it('--yolo lets a tool write a file', async () => {
    const target = join(ws.cwd, 'yolo.txt');
    gw.push({
      match: 'write with yolo',
      text: '',
      toolCalls: [{ name: 'write_file', arguments: JSON.stringify({ file_path: target, content: 'yolo-ok' }) }],
    });
    gw.push({ match: 'write with yolo', text: 'done writing' });
    const result = await run(['-p', '--yolo', 'write with yolo'], { timeoutMs: 90_000 });
    expect(result.exitCode).toBe(0);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('yolo-ok');
  });

  it('without --yolo print mode is read-only and denies the write', async () => {
    const target = join(ws.cwd, 'noyolo.txt');
    gw.push({
      match: 'write without yolo',
      text: '',
      toolCalls: [{ name: 'write_file', arguments: JSON.stringify({ file_path: target, content: 'nope' }) }],
    });
    gw.push({ match: 'write without yolo', text: 'could not write' });
    const result = await run(['-p', 'write without yolo'], { timeoutMs: 90_000 });
    expect(result.exitCode).toBe(0);
    expect(existsSync(target)).toBe(false);
    expect(result.stderr).toMatch(/Tool approval denied/);
    expect(result.stderr).toMatch(/Pass --yolo/);
  });

  it('--workdir makes relative tool paths resolve inside that directory', async () => {
    const project = join(ws.cwd, 'project');
    await mkdir(project, { recursive: true });
    gw.push({
      match: 'write in workdir',
      text: '',
      toolCalls: [{ name: 'write_file', arguments: JSON.stringify({ file_path: 'relative.txt', content: 'from workdir' }) }],
    });
    gw.push({ match: 'write in workdir', text: 'workdir done' });
    const result = await run(['-p', '--yolo', '--workdir', project, 'write in workdir'], { timeoutMs: 90_000 });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(project, 'relative.txt'))).toBe(true);
  });

  it('--no-session still completes a print-mode turn', async () => {
    gw.push({ match: 'no session turn', text: 'no session ok' });
    const result = await run(['-p', '--json', '--no-session', 'no session turn']);
    expect(result.exitCode).toBe(0);
    expect(parseJson(result).result).toBe('no session ok');
  });
});
