import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
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
const { inferRemoteMcpTransport, discoverExternalMcpServers, toMcpServerConfig } = await import('../../migrate/discoverMcp.js');

let httpServer: http.Server;
let url = '';

beforeAll(async () => {
  httpServer = http.createServer(async (req, res) => {
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    /* stateless: 每个请求一对 server/transport (SDK 文档的写法) */
    const mcp = new Server({ name: 'http-fixture', version: '0.0.1' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }],
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void mcp.close(); });
    await mcp.connect(transport);
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { void transport.handleRequest(req, res, body ? JSON.parse(body) : undefined); });
  });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((r) => httpServer.close(() => r()));
});

describe('transport: http', () => {
  it('连上 Streamable HTTP server, 列工具, 调工具', async () => {
    servers = [{ id: 'remote', scope: 'user', transport: 'http', url, enabled: true }];
    const manager = new MCPClientManager({ workDir: process.cwd() });
    try {
      const r = await manager.testServer('remote');
      expect(r.tools).toEqual(['ping']);
      const tools = await manager.getTools({ refresh: true });
      expect(await tools[0].function({})).toBe('pong');
    } finally {
      await manager.disconnectAll();
    }
  }, 20_000);

  it('配置里写了不认识的 transport → 报协议名, 不是 "missing command"', async () => {
    servers = [{ id: 'weird', scope: 'user', transport: 'websocket' as any, url, enabled: true }];
    const manager = new MCPClientManager({ workDir: process.cwd() });
    await expect(manager.connect('weird')).rejects.toThrow(/unsupported transport "websocket"/);
  });
});

describe('inferRemoteMcpTransport', () => {
  it('显式 type 优先', () => {
    expect(inferRemoteMcpTransport('http', 'https://x.dev/sse')).toBe('http');
    expect(inferRemoteMcpTransport('streamable-http', 'https://x.dev/mcp')).toBe('http');
    expect(inferRemoteMcpTransport('sse', 'https://x.dev/mcp')).toBe('sse');
  });
  it('无 type: /sse 结尾 → sse, 其它 → http', () => {
    expect(inferRemoteMcpTransport(undefined, 'https://x.dev/sse')).toBe('sse');
    expect(inferRemoteMcpTransport(undefined, 'https://x.dev/sse/')).toBe('sse');
    expect(inferRemoteMcpTransport(undefined, 'https://mcp.context7.com/mcp')).toBe('http');
  });
});

describe('从 Claude Code 导入', () => {
  it('type:"http" 的 server 导进来是 http, 不是 sse', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-discover-'));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      mcpServers: {
        deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' },
        legacy: { type: 'sse', url: 'https://example.com/sse' },
      },
    }));
    const found = discoverExternalMcpServers([], home);
    const byId = Object.fromEntries(found.map((c) => [c.id, toMcpServerConfig(c).transport]));
    expect(byId).toEqual({ deepwiki: 'http', legacy: 'sse' });
  });
});
