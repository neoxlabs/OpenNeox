import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeGateway, type FakeGateway } from './infra/fakeGateway.js';
import { createCliWorkspace, type CliWorkspace } from './infra/workspace.js';
import { spawnPtyCli, type PtyCli } from './infra/ptyCli.js';
import { stripAnsi } from './infra/ansi.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 交互模式斜杠命令全表: 每个命令都能打开/执行、不崩、回到可输入状态.
 * 一个 PTY 会话顺序跑完 (启动一次 ~5s, 40 条命令 ~1.5s/条).
 *
 * 归位策略: 每条命令前先 ESC (关掉上一条留下的子菜单) + Ctrl+U (清空输入),
 * 命令后也 ESC. 这样某条命令留下 modal 不会污染下一条.
 */
describe.sequential('cli e2e · interactive slash commands', () => {
  let gw: FakeGateway;
  let ws: CliWorkspace;
  let cli: PtyCli;

  beforeAll(async () => {
    gw = await startFakeGateway({ defaultText: 'slash probe answer' });
    ws = await createCliWorkspace({ providers: [{ baseUrl: gw.baseUrl, model: 'mock-model' }] });
    cli = await spawnPtyCli(ws, { cols: 100, rows: 40, readyTimeoutMs: 90_000 });
  }, 120_000);

  afterAll(async () => {
    cli?.kill('SIGKILL');
    await ws?.cleanup();
    await gw?.stop();
  });

  async function resetInput(): Promise<void> {
    cli.send('\x1b');
    await sleep(300);
    cli.send('\x15');
    await sleep(200);
  }

  async function runSlash(command: string): Promise<string> {
    await resetInput();
    const mark = cli.mark();
    await cli.sendLine(command);
    await cli.waitQuiet({ quietMs: 900, timeoutMs: 12_000 });
    const output = cli.since(mark);
    cli.send('\x1b');
    await cli.waitQuiet({ quietMs: 300, timeoutMs: 5_000 });
    return stripAnsi(output).replace(/\r/g, '\n');
  }

  function expectSane(output: string): void {
    expect(cli.alive()).toBe(true);
    expect(output).not.toMatch(/TypeError|ReferenceError|Cannot read propert|UnhandledPromiseRejection|FATAL/);
  }

  function check(command: string, marker: RegExp) {
    return async () => {
      const output = await runSlash(command);
      expectSane(output);
      expect(output).toMatch(marker);
      expect(cli.output()).toBeTruthy();
    };
  }

  it('/help opens the help panel', check('/help', /Help · enter runs the command/));
  it('/clear clears conversation context', check('/clear', /Conversation context cleared/));
  it('/mode opens run settings', check('/mode', /Run settings/));
  it('/thinking reports the model thinking switch', check('/thinking', /Extended thinking[\s\S]*no thinking switch/));
  it('/approval opens approval mode', check('/approval', /Approval mode/));
  it('/sandbox opens sandbox mode', check('/sandbox', /Sandbox mode/));
  it('/theme opens color theme', check('/theme', /Color theme/));
  it('/provider lists providers', check('/provider', /Provider · pick one/));
  it('/model opens the BYOK model picker', check('/model', /Select BYOK model/));
  it('/effort opens reasoning effort', check('/effort', /Reasoning effort/));
  it('/output-style opens reply style', check('/output-style', /Reply style/));
  it('/diagnostics prints request diagnostics', check('/diagnostics', /Diagnostics · last 24h/));
  it('/resume opens the session picker', check('/resume', /Resume a session/));
  it('/session opens session actions', check('/session', /Export this session/));
  it('/rollback reports no checkpoints', check('/rollback', /No checkpoints yet/));
  it('/changes reports no file changes', check('/changes', /No file changes in this session/));
  it('/undo reports nothing to undo', check('/undo', /Nothing to undo/));
  it('/compact reports nothing to compact', check('/compact', /Nothing to compact/));
  it('/target prints target-mode usage', check('/target', /\/target <your goal>/));
  it('/ps reports no background commands', check('/ps', /Background commands\s+none running/));
  it('/skills opens the skills list', check('/skills', /Skills List/));
  it('/workspace opens the workspace picker', check('/workspace', /Workspace[\s\S]*current/));
  it('/websearch opens web search settings', check('/websearch', /Search backend/));
  it('/mcp opens MCP commands', check('/mcp', /MCP commands/));
  it('/context opens context settings', check('/context', /Compact at/));
  it('/memory opens memory settings', check('/memory', /Auto memory on\/off/));
  it('/language opens language settings', check('/language', /Language Settings/));
  it('/notify opens completion alerts', check('/notify', /Completion Alerts/));
  it('/attach without arguments prints usage', check('/attach', /\/attach <image path or URL>/));
  it('/rc without login reports the account requirement', check('/rc', /手机远程需要登录 Neox 账号/));
  it('/stats prints the current session summary', check('/stats', /Model\s+mock-model/));
  it('/statistic opens token usage', check('/statistic', /Token usage/));
  it('/pricing opens pricing configuration', check('/pricing', /Model Pricing Configuration/));
  it('/kill without arguments prints usage', check('/kill', /Usage: \/kill/));
  it('/tts opens voice read-aloud settings', check('/tts', /Voice read-aloud/));
  it('/experimental opens experimental features', check('/experimental', /Experimental features/));
  it('/checkpoint opens checkpoints', check('/checkpoint', /Checkpoints ·/));
  it('/attachments reports nothing attached', check('/attachments', /Nothing attached/));
  it('/setup opens provider setup', check('/setup', /Setup · Mock BYOK/));
  it('/remote opens remote access settings', check('/remote', /Remote access/));

  it('the session is still interactive after 40 slash commands', async () => {
    const output = await runSlash('/changes');
    expectSane(output);
    expect(output).toMatch(/No file changes in this session/);
  });
});
