import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCliWorkspace, type CliWorkspace } from './infra/workspace.js';
import { runCli } from './infra/runCli.js';

/**
 * 真调模型的冒烟 (≤5 个). 默认跳过; 只有显式 NEOX_E2E_LIVE=1 才跑.
 *
 *   NEOX_E2E_LIVE=1 npx vitest run apps/cli/src/__tests__/e2e/live-smoke.test.ts
 *
 * 用调用者真实的 ~/.neox 账号配置 (neox-cloud), 但:
 *   · HOME / NEOX_HOME_DIRNAME 显式指向真实 home, 不受本仓 worktree 的 NEOX_HOME_DIRNAME 影响;
 *   · --no-session, 不在会话列表留垃圾;
 *   · 只读调用, 不写配置.
 */
const LIVE = process.env.NEOX_E2E_LIVE === '1';
const MODEL = 'deepseek-v4.1-flash-1017';
const LIVE_HOME = process.env.NEOX_E2E_LIVE_HOME || process.env.HOME || '';
const LIVE_HOME_DIRNAME = process.env.NEOX_E2E_LIVE_HOME_DIRNAME || '.neox';

describe.skipIf(!LIVE)('cli e2e · live model smoke', () => {
  let ws: CliWorkspace;

  beforeAll(async () => {
    ws = await createCliWorkspace();
  }, 30_000);

  afterAll(async () => {
    await ws?.cleanup();
  });

  const run = (args: string[]) =>
    runCli(ws, args, {
      timeoutMs: 180_000,
      env: {
        HOME: LIVE_HOME,
        NEOX_HOME_DIRNAME: LIVE_HOME_DIRNAME,
        NEOX_USE_DAEMON: '0',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
    });

  const cloudArgs = ['--provider', 'neox-cloud', '-m', MODEL, '--no-session'];

  it('returns a JSON answer from neox-cloud', async () => {
    const result = await run(['-p', '--json', ...cloudArgs, 'Reply with the single word OK.']);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.error).toBeNull();
    expect(String(payload.result).toUpperCase()).toContain('OK');
  });

  it('answers a simple arithmetic question', async () => {
    const result = await run(['-p', ...cloudArgs, 'What is 2+2? Reply with only the number.']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('4');
  });

  it('knows a one-word fact', async () => {
    const result = await run(['-p', '--json', ...cloudArgs, 'Name the capital of France in one word.']);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(String(payload.result)).toMatch(/Paris/i);
  });

  it('honours an explicit output instruction', async () => {
    const result = await run(['-p', '--json', ...cloudArgs, 'Reply with the single word PONG and nothing else.']);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(String(payload.result).toUpperCase()).toContain('PONG');
    /* 标题生成等侧路请求会让请求数 > 1, 但主回答只该有一份 */
    expect(payload.result.length).toBeLessThan(400);
  });
});
