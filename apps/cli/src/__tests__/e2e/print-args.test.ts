import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCliWorkspace, type CliWorkspace } from './infra/workspace.js';
import { runCli, type CliResult } from './infra/runCli.js';

/* 每次用例都冷启动一次 CLI (tsx ~1.5-3s); 并行跑仓里其它测试时要留足余量. */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * 非交互 (-p / --json) 参数解析 / 报错文案 / 退出码.
 * 这一组不配置 provider, 所有用例都在 "报错前" 结束 —— 不触网、不调模型.
 */
describe('cli e2e · print mode args & exit codes', () => {
  let ws: CliWorkspace;

  beforeAll(async () => {
    ws = await createCliWorkspace();
  }, 30_000);

  afterAll(async () => {
    await ws?.cleanup();
  });

  const run = (args: string[], opts: Parameters<typeof runCli>[2] = {}) =>
    runCli(ws, args, { timeoutMs: 40_000, ...opts });

  function expectError(result: CliResult, exitCode: number, pattern: RegExp): void {
    expect({ exit: result.exitCode, timedOut: result.timedOut }).toEqual({ exit: exitCode, timedOut: false });
    expect(result.stderr).toMatch(pattern);
  }

  it('--version prints a single version line and exits 0', async () => {
    const result = await run(['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^Neox CLI v\d+\.\d+\.\d+/);
    expect(result.stderr).toBe('');
  });

  it('-v is an alias for --version', async () => {
    const result = await run(['-v']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^Neox CLI v\d+\.\d+\.\d+/);
  });

  it('--help documents print mode flags', async () => {
    const result = await run(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Usage: neox/);
    expect(result.stdout).toMatch(/-p, --print/);
    expect(result.stdout).toMatch(/--provider/);
    expect(result.stdout).toMatch(/--json/);
    expect(result.stdout).toMatch(/--yolo/);
    expect(result.stdout).toMatch(/--timeout/);
    expect(result.stdout).toMatch(/-m, --model/);
  });

  it('-h is an alias for --help', async () => {
    const result = await run(['-h']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Usage: neox/);
  });

  it('rejects an unknown top-level flag with a clear message', async () => {
    const result = await run(['--definitely-not-a-flag']);
    expectError(result, 1, /unsupported arguments: --definitely-not-a-flag/);
    expect(result.stderr).toMatch(/neox --help/);
  });

  it('-p without a prompt fails with exit 1', async () => {
    const result = await run(['-p']);
    expectError(result, 1, /No prompt provided\. Usage: neox -p "your question"/);
  });

  it('-p with an empty prompt fails with exit 1', async () => {
    const result = await run(['-p', '']);
    expectError(result, 1, /No prompt provided/);
  });

  it('--json without a prompt fails with exit 1 and prints no JSON', async () => {
    const result = await run(['-p', '--json']);
    expectError(result, 1, /No prompt provided/);
    expect(result.stdout.trim()).toBe('');
  });

  it('-p -c is rejected because print mode is stateless', async () => {
    const result = await run(['-p', '-c', 'hello']);
    expectError(result, 2, /does not support session continuation "-c"/);
  });

  it('-p --continue is rejected with exit 2', async () => {
    const result = await run(['-p', '--continue', 'hello']);
    expectError(result, 2, /does not support session continuation "--continue"/);
  });

  it('-p -r <id> is rejected with exit 2', async () => {
    const result = await run(['-p', '-r', 'session_123', 'hello']);
    expectError(result, 2, /does not support session continuation "-r"/);
  });

  it('-p --resume is rejected with exit 2', async () => {
    const result = await run(['-p', '--resume', 'session_123', 'hello']);
    expectError(result, 2, /does not support session continuation "--resume"/);
  });

  it('--json -p -c prints the continuation error without JSON output', async () => {
    const result = await run(['--json', '-p', '-c', 'hello']);
    expectError(result, 2, /does not support session continuation/);
    expect(result.stdout.trim()).toBe('');
  });

  it('unknown provider id reports the provider and exits 1', async () => {
    const result = await run(['-p', '--provider', 'bogus', '-m', 'whatever', 'hello']);
    expectError(result, 1, /Provider "bogus" not found or unusable/);
  });

  it('unknown provider id in --json mode becomes a JSON error object', async () => {
    const result = await run(['-p', '--json', '--provider', 'bogus', '-m', 'whatever', 'hello']);
    expectError(result, 1, /Provider "bogus" not found or unusable/);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.result).toBeNull();
    expect(payload.error).toMatch(/Provider "bogus" not found or unusable/);
  });

  it('neox-cloud without a configured account is reported as unusable', async () => {
    const result = await run(['-p', '--provider', 'neox-cloud', '-m', 'deepseek-v4.1-flash-1017', 'hello']);
    expectError(result, 1, /Provider "neox-cloud" not found or unusable/);
  });

  it('no default model fails with the actionable model error', async () => {
    const result = await run(['-p', 'hello']);
    expectError(result, 1, /No default model configured\. Use --model <name> or run `neox` to set a default\./);
  });

  it('--json with no default model keeps stdout empty', async () => {
    const result = await run(['-p', '--json', 'hello']);
    expectError(result, 1, /No default model configured/);
    expect(result.stdout.trim()).toBe('');
  });

  it('-m without a provider reports the provider error', async () => {
    const result = await run(['-p', '-m', 'mock-model', 'hello']);
    expectError(result, 1, /No default provider configured\. Use --provider <id>/);
  });

  it('--json -m without a provider keeps stdout empty', async () => {
    const result = await run(['-p', '--json', '-m', 'mock-model', 'hello']);
    expectError(result, 1, /No default provider configured/);
    expect(result.stdout.trim()).toBe('');
  });

  it('--timeout with a non-numeric value is ignored instead of crashing', async () => {
    const result = await run(['-p', '--timeout', 'abc', 'hello']);
    expectError(result, 1, /No default model configured/);
    expect(result.stderr).not.toMatch(/TypeError|ReferenceError/);
  });

  it('--timeout 0 is ignored (falls back to default) and does not crash', async () => {
    const result = await run(['-p', '--timeout', '0', 'hello']);
    expectError(result, 1, /No default model configured/);
  });

  it('--timeout -5 is ignored and does not swallow the prompt', async () => {
    const result = await run(['-p', '--timeout', '-5', 'hello']);
    expectError(result, 1, /No default model configured/);
  });

  it('unknown print-mode flag warns on stderr but keeps the prompt', async () => {
    const result = await run(['-p', '--json', '--jsno', 'hello']);
    expectError(result, 1, /Warning: unknown print-mode flag "--jsno" ignored/);
    expect(result.stderr).toMatch(/No default model configured/);
  });

  it('a dangling -m is reported as an unknown flag, not silently ignored', async () => {
    const result = await run(['-p', '-m']);
    expectError(result, 1, /Warning: unknown print-mode flag "-m" ignored/);
    expect(result.stderr).toMatch(/No prompt provided/);
  });

  it('a dangling --provider is reported as an unknown flag', async () => {
    const result = await run(['-p', '--provider']);
    expectError(result, 1, /Warning: unknown print-mode flag "--provider" ignored/);
    expect(result.stderr).toMatch(/No prompt provided/);
  });

  it('--yolo / --dangerously-skip-permissions / --lean / --no-session are accepted', async () => {
    const result = await run([
      '-p', '--yolo', '--dangerously-skip-permissions', '--lean', '--no-session', 'hello',
    ]);
    expectError(result, 1, /No default model configured/);
  });

  it('--stream is accepted in print mode', async () => {
    const result = await run(['-p', '--stream', 'hello']);
    expectError(result, 1, /No default model configured/);
  });

  it('--workdir with an existing directory is accepted', async () => {
    const result = await run(['-p', '--workdir', ws.cwd, 'hello']);
    expectError(result, 1, /No default model configured/);
  });

  it('--workdir with a missing directory does not fail before provider resolution', async () => {
    const result = await run(['-p', '--workdir', '/nonexistent-neox-e2e', 'hello']);
    expectError(result, 1, /No default model configured/);
  });

  it('a positional prompt (no -p) is treated as print mode when stdin is closed', async () => {
    const result = await run(['hello']);
    expectError(result, 1, /No default model configured/);
  });

  it('positional prompt + --json is treated as print mode', async () => {
    const result = await run(['--json', 'hello']);
    expectError(result, 1, /No default model configured/);
  });

  it('piped stdin without a prompt asks for provider setup and exits 1', async () => {
    const result = await run([], { stdin: 'hello from a pipe' });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/No AI provider set up/i);
  });

  it('shared flags do not leak between invocations (same prompt, same error)', async () => {
    const first = await run(['-p', 'hello']);
    const second = await run(['-p', 'hello']);
    expect(first.exitCode).toBe(1);
    expect(second.exitCode).toBe(1);
    expect(first.stderr).toMatch(/No default model configured/);
    expect(second.stderr).toMatch(/No default model configured/);
  });
});
