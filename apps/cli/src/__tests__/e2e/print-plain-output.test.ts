import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { startFakeGateway, type FakeGateway } from './infra/fakeGateway.js';
import { createCliWorkspace, type CliWorkspace } from './infra/workspace.js';
import { runCli, type CliResult } from './infra/runCli.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

/**
 * CLI-11 · 非 TTY 下输出纯文本
 *
 * 管道 / 重定向 / CI 里 stdout 不是终端: 输出里不该有 ANSI 转义或 TUI 控件, 否则
 * `neox -p ... | jq` / 日志 / diff 全是乱码。
 *
 * 用例全部走 127.0.0.1 假网关 (不调真实模型), 且故意把 FORCE_COLOR 设成 1 ——
 * 有些 CI 镜像会这么干, 只靠 chalk 自己判断是不够的, 必须我们这层真的剥掉。
 */
const ESC = '\u001b';
const ANSI_TEXT = `${ESC}[31mred answer${ESC}[0m\n${ESC}[2J${ESC}[Hsecond line`;

describe('cli e2e · 非 TTY 纯文本输出 (CLI-11)', () => {
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
    runCli(ws, args, { timeoutMs: 60_000, env: { FORCE_COLOR: '1' }, ...opts });

  it('--output-format text 剥掉模型输出里的 ANSI 与光标控制', async () => {
    gw.push({ match: 'ansi text format', text: ANSI_TEXT });
    const result = await run(['-p', '--output-format', 'text', 'ansi text format']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(ESC);
    // 正文保留 (只去转义, 不吞内容)
    expect(result.stdout).toContain('red answer');
    expect(result.stdout).toContain('second line');
  });

  it('--output-format=text 这种等号写法同样生效', async () => {
    gw.push({ match: 'equals form', text: ANSI_TEXT });
    const result = await run(['-p', '--output-format=text', 'equals form']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(ESC);
    expect(result.stdout).toContain('red answer');
  });

  it('不给 --output-format 时, 管道里的默认输出也是纯文本', async () => {
    gw.push({ match: 'default piped', text: ANSI_TEXT });
    const result = await run(['-p', 'default piped']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(ESC);
    expect(result.stdout).toContain('red answer');
  });

  it('--output-format json 输出单个干净 JSON, 正文里也没有转义符', async () => {
    gw.push({ match: 'json format', text: ANSI_TEXT });
    const result = await run(['-p', '--output-format', 'json', 'json format']);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]);
    expect(payload.error).toBeNull();
    expect(payload.result).toContain('red answer');
    expect(payload.result).not.toContain(ESC);
    // stdout 整体 (含 JSON 的引号) 里也不该有转义序列
    expect(result.stdout).not.toContain(ESC);
  });

  it('positional prompt (不带 -p) 也认 --output-format text', async () => {
    gw.push({ match: 'positional plain', text: ANSI_TEXT });
    const result = await run(['--output-format', 'text', 'positional plain']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(ESC);
    expect(result.stdout).toContain('red answer');
  });

  it('不认识的 --output-format 值: 给警告但不炸, 输出仍然干净', async () => {
    gw.push({ match: 'bad format', text: ANSI_TEXT });
    const result = await run(['-p', '--output-format', 'yaml', 'bad format']);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('--output-format');
    expect(result.stdout).not.toContain(ESC);
  });

  it('CI 环境变量下 (stdout 是管道) 输出里没有 TUI 控件', async () => {
    gw.push({ match: 'ci run', text: 'ci ok' });
    const result: CliResult = await run(['-p', 'ci run'], { env: { FORCE_COLOR: '1', CI: 'true' } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('ci ok');
    // 备用屏切换 / 清屏 / 光标隐藏 这些 TUI 控件一个都不该出现
    expect(result.stdout).not.toContain(`${ESC}[?1049h`);
    expect(result.stdout).not.toContain(`${ESC}[2J`);
    expect(result.stdout).not.toContain(`${ESC}[?25l`);
  });
});
