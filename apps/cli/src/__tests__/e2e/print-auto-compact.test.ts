import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeGateway, type FakeGateway } from './infra/fakeGateway.js';
import { createCliWorkspace, type CliWorkspace } from './infra/workspace.js';
import { runCli, type CliResult } from './infra/runCli.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });


/* 摘要要能被认出来, 也要够长 (cached-prefix 摘要要求 ≥200 token 才可用) */
const SUMMARY_MARKER = '【压缩工作记录】这一段是摘要, 不是最终回答';
const SUMMARY_TEXT = `${SUMMARY_MARKER}\n`
  + '用户目标: 读大文件并给出结论; 下一步: 读完大文件后写结论。\n'.repeat(200);

const FINAL_ANSWER = '读完了: 所有大文件都看过了, 结论写在这里。';

/* 每次 readfile 大约带回 ~10KB, 读几个文件就能把上下文顶过压缩线 */
const FILE_COUNT = 8;
const BIG_FILE_LINES = 4_000;

describe('cli e2e · print mode 自动压缩之后继续干活', () => {
  let ws: CliWorkspace;
  let gw: FakeGateway;

  beforeAll(async () => {
    gw = await startFakeGateway({ defaultText: 'mock default reply' });
    ws = await createCliWorkspace({
      providers: [{ baseUrl: gw.baseUrl, model: 'mock-model' }],
      /* 小窗口 + 早触发: 读几个大文件就过线 */
      env: { NEOX_CONTEXT_WINDOW: '20000', NEOX_AUTOCOMPACT_PCT: '30' },
    });
    const body = Array.from({ length: BIG_FILE_LINES }, (_, i) => `line ${i} ` + 'x'.repeat(80)).join('\n');
    await Promise.all(
      Array.from({ length: FILE_COUNT }, (_, i) => writeFile(join(ws.cwd, `big-${i}.txt`), body)),
    );
  }, 60_000);

  afterAll(async () => {
    await ws?.cleanup();
    await gw?.stop();
  });

  const run = (args: string[], opts: Parameters<typeof runCli>[2] = {}) =>
    runCli(ws, args, { timeoutMs: 120_000, ...opts });

  function summaryRequests(): number {
    return gw.chatRequests().filter((r) => r.rawBody.includes('请先暂停手头的工作')).length;
  }

  it('压缩之后循环继续, 最终输出不是压缩摘要', async () => {
    /* 1. 连续读多个大文件 → 上下文过线 */
    for (let i = 0; i < FILE_COUNT; i++) {
      gw.push({
        match: 'read the big files',
        text: '',
        toolCalls: [{ name: 'readfile', arguments: JSON.stringify({ file_path: join(ws.cwd, `big-${i}.txt`) }) }],
      });
    }
    /* 2. 压缩请求 (cached-prefix 摘要, 最后一条 user 就是那段提示词) */
    gw.push({ match: '请先暂停手头的工作', text: SUMMARY_TEXT });
    /* 3. 压缩之后的下一轮 → 模型真正收尾 */
    gw.push({ text: FINAL_ANSWER });

    const result: CliResult = await run(['-p', 'read the big files and report']);

    expect(result.exitCode, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);

    const diag = JSON.stringify({
      stdout: result.stdout.slice(-400),
      stderr: result.stderr.slice(-1500),
      stall: (() => {
        try { return readFileSync(join(ws.neoxHome, 'logs', 'stall.log'), 'utf8').slice(-3000); } catch { return '(no stall.log)'; }
      })(),
      requests: gw.chatRequests().map((r) => ({
        len: r.rawBody.length,
        summaryPrompt: r.rawBody.includes('请先暂停手头的工作'),
        record: r.rawBody.includes('[Compressed Work Record'),
        msgs: (r.body?.messages ?? []).map(
          (m: any) => `${m?.role}:${String(typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content)).length}`,
        ),
      })),
    });

    /* 前提: 压缩真的发生了 —— 否则这条用例什么也没验证 */
    expect(summaryRequests(), diag).toBe(1);

    /* (a) 压缩之后还有对话请求 (循环继续) */
    const requests = gw.chatRequests();
    const summaryIndex = requests.findIndex((r) => r.rawBody.includes('请先暂停手头的工作'));
    expect(summaryIndex, diag).toBeGreaterThanOrEqual(0);
    expect(requests.length, diag).toBeGreaterThan(summaryIndex + 1);

    /* 压缩后的请求带着工作记录 (摘要进了上下文, 不是被丢掉) */
    expect(requests.at(-1)?.rawBody).toContain('[Compressed Work Record');

    /* (b) 最终输出是模型的话, 不是摘要 */
    expect(result.stdout).toContain(FINAL_ANSWER);
    expect(result.stdout).not.toContain(SUMMARY_MARKER);
  });
});
