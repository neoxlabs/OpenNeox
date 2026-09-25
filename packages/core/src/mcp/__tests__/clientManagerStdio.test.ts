import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MCPServerEntry } from '../configStore.js';

vi.mock('@neoxlabs/kernel/platform/cliLogger.js', () => ({
  cliLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let servers: MCPServerEntry[] = [];
vi.mock('../configStore.js', async (orig) => ({
  ...(await orig<typeof import('../configStore.js')>()),
  listMcpServers: () => servers,
}));

const { MCPClientManager } = await import('../clientManager.js');
const { IMAGE_RESULT_PREFIX, parseImageResultImages } = await import('../../tools/image/imageProcessor.js');

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stdioFixtureServer.mjs');
const PROVIDER_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

function fixtureServer(id: string, mode = 'normal'): MCPServerEntry {
  return {
    id,
    scope: 'user',
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    env: { FIXTURE_MODE: mode },
    enabled: true,
  };
}

let manager: InstanceType<typeof MCPClientManager> | null = null;
afterEach(async () => {
  await manager?.disconnectAll();
  manager = null;
  servers = [];
});

async function connectedTools(ids: string[]) {
  servers = ids.map((id) => fixtureServer(id));
  manager = new MCPClientManager({ workDir: process.cwd() });
  for (const id of ids) await manager.connect(id);
  return manager.getTools({ refresh: true });
}

describe('工具名满足 provider 规则', () => {
  it('带点/空格/超长的 MCP 工具名 → 全部落进 ^[a-zA-Z0-9_-]{1,64}$', async () => {
    const tools = await connectedTools(['my server.v2']);
    expect(tools.length).toBe(7);
    for (const t of tools) expect(t.name).toMatch(PROVIDER_TOOL_NAME);
  }, 20_000);

  it('改过名的工具仍然调到 server 上的原名', async () => {
    const tools = await connectedTools(['fx']);
    const shot = tools.find((t) => t.description.includes('returns an image'))!;
    const long = tools.find((t) => t.description.includes('very long name'))!;
    const spaced = tools.find((t) => t.description.includes('returns embedded resource'))!;
    expect(await long.function({})).toBe('long-name-ok');
    expect(typeof (await shot.function({}))).toBe('string');
    expect(await spaced.function({})).toContain('resource body');
  }, 20_000);

  it('两台 server 截断后撞名 → 名字仍唯一', async () => {
    const a = 'a'.repeat(40);
    const tools = await connectedTools([`${a}-one`, `${a}-two`]);
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(PROVIDER_TOOL_NAME);
  }, 20_000);
});

describe('调用结果的内容形状', () => {
  it('图片内容 → IMAGE_RESULT_PREFIX 载荷, 文本部分跟着走', async () => {
    const tools = await connectedTools(['fx']);
    const shot = tools.find((t) => t.description.includes('returns an image'))!;
    const out = await shot.function({});
    expect(out.startsWith(IMAGE_RESULT_PREFIX)).toBe(true);
    const images = parseImageResultImages(out)!;
    expect(images).toHaveLength(1);
    expect(images[0].mediaType).toBe('image/png');
    const parsed = JSON.parse(out.slice(IMAGE_RESULT_PREFIX.length));
    expect(parsed.text).toContain('here is the screenshot');
  }, 20_000);

  it('isError → 抛出的错误带 server 原话', async () => {
    const tools = await connectedTools(['fx']);
    const failing = tools.find((t) => t.description.includes('isError result'))!;
    await expect(failing.function({})).rejects.toThrow(/429 Too Many Requests/);
  }, 20_000);

  it('isError 且只有图片 → 错误里不塞 base64', async () => {
    const tools = await connectedTools(['fx']);
    const failing = tools.find((t) => t.description.includes('isError with non-text'))!;
    const err: Error = await failing.function({}).then(() => { throw new Error('should reject'); }, (e: Error) => e);
    expect(err.message).not.toContain('iVBORw0KGgo');
    expect(err.message.length).toBeLessThan(300);
  }, 20_000);

  it('只有 structuredContent → 返回结构化 JSON 本身', async () => {
    const tools = await connectedTools(['fx']);
    const t = tools.find((x) => x.description.includes('structuredContent only'))!;
    const out = await t.function({});
    expect(JSON.parse(out)).toEqual({ temperature: 21.5, unit: 'C' });
  }, 20_000);
});

describe('启动时自动连接 (autoConnect)', () => {
  it('只连 autoConnect 且启用的; 失败的逐台报原因; 连上的工具进表', async () => {
    servers = [
      { ...fixtureServer('auto-ok'), autoConnect: true },
      { ...fixtureServer('auto-dies', 'exit'), autoConnect: true },
      { ...fixtureServer('manual'), autoConnect: false },
      { ...fixtureServer('auto-disabled'), autoConnect: true, enabled: false },
    ];
    manager = new MCPClientManager({ workDir: process.cwd() });
    const result = await manager.connectAutoConnectServers();
    expect(result.connected).toEqual(['auto-ok']);
    expect(result.failed.map((f) => f.id)).toEqual(['auto-dies']);
    expect(result.failed[0].error).toMatch(/missing API_KEY/);
    const tools = await manager.getTools();
    expect(tools.length).toBe(7);
    expect(tools.every((t) => t.name.startsWith('mcp__auto-ok__'))).toBe(true);
  }, 20_000);

  it('MCP 总开关关着 → 一台都不连', async () => {
    servers = [{ ...fixtureServer('auto-ok'), autoConnect: true }];
    manager = new MCPClientManager({ workDir: process.cwd() });
    manager.setEnabled(false);
    expect(await manager.connectAutoConnectServers()).toEqual({ connected: [], failed: [] });
  }, 20_000);
});

describe('坏 server', () => {
  it('进程一启动就退出 → connect 报错 (不是挂起到超时)', async () => {
    servers = [fixtureServer('dies', 'exit')];
    manager = new MCPClientManager({ workDir: process.cwd() });
    const started = Date.now();
    /* 报错里要有 server 自己说的原因, 而不只是 "Connection closed" */
    await expect(manager.connect('dies')).rejects.toThrow(/missing API_KEY/);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it('进程抛未捕获异常 → 报错里是那句 Error, 不是一串栈帧', async () => {
    servers = [fixtureServer('crashes', 'crash')];
    manager = new MCPClientManager({ workDir: process.cwd() });
    const err: Error = await manager.connect('crashes').then(() => { throw new Error('should reject'); }, (e: Error) => e);
    expect(err.message).toMatch(/GITHUB_TOKEN is not set/);
    expect(err.message).not.toMatch(/^\s*at\s/m);
  }, 20_000);

  it('不声明 tools 能力的 server → 连接成功, 0 个工具 (不是连接失败)', async () => {
    servers = [fixtureServer('resources-only', 'nolist')];
    manager = new MCPClientManager({ workDir: process.cwd() });
    const result = await manager.testServer('resources-only');
    expect(result.toolCount).toBe(0);
  }, 20_000);

  it('连上但 listTools 失败 → 报错带 server 名和原因', async () => {
    servers = [fixtureServer('listfail', 'listfail')];
    manager = new MCPClientManager({ workDir: process.cwd() });
    await expect(manager.connect('listfail')).rejects.toThrow(/"listfail".*tool registry not ready/);
  }, 20_000);

  it('连上但 listTools 失败 → 子进程被收掉, 不留孤儿', async () => {
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-fixture-')), 'pid');
    const entry = fixtureServer('listfail', 'listfail');
    entry.env = { ...entry.env, FIXTURE_PID_FILE: pidFile };
    servers = [entry];
    manager = new MCPClientManager({ workDir: process.cwd() });
    await expect(manager.connect('listfail')).rejects.toThrow();
    const pid = Number(fs.readFileSync(pidFile, 'utf-8'));
    expect(pid).toBeGreaterThan(0);
    let alive = true;
    for (let i = 0; i < 30 && alive; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { process.kill(pid, 0); } catch { alive = false; }
    }
    if (alive) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    expect(alive, `MCP child ${pid} survived a failed connect`).toBe(false);
  }, 20_000);
});
