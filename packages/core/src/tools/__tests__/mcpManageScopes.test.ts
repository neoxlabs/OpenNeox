import { describe, expect, it, vi, beforeEach } from 'vitest';

let userServers: any[] = [];
let workspaceServers: any[] = [];
let mcpEnabled: boolean | undefined;
let workspaceRoot: string | undefined = '/ws';

vi.mock('@neoxlabs/platform/utils/config.js', () => ({
  CONFIG_FILE: '/tmp/config.json',
  loadConfig: () => ({ mcp: { enabled: mcpEnabled, servers: userServers } }),
  saveConfig: (c: any) => { userServers = c.mcp.servers; },
  /* askUserTool 在模块加载时就订阅它, 不 mock 会在 import 阶段炸 */
  onUserIdChange: () => { /* noop */ },
  getCurrentUserId: () => 'test-user',
}));
vi.mock('../../mcp/configStore.js', () => ({
  listMcpServers: () => [
    ...userServers.map((s) => ({ ...s, scope: 'user' })),
    ...workspaceServers.map((s) => ({ ...s, scope: 'workspace' })),
  ],
}));
vi.mock('@neoxlabs/kernel/tools/workspaceContext.js', () => ({
  getWorkspaceRootFromContext: () => workspaceRoot,
}));

const WS_SERVER = { id: 'ws-echo', name: 'ws-echo', transport: 'stdio', command: 'node', enabled: true };
const USER_SERVER = { id: 'user-fs', name: 'user-fs', transport: 'stdio', command: 'npx', enabled: true };

let mcpTool: any;
beforeEach(async () => {
  userServers = [];
  workspaceServers = [];
  mcpEnabled = undefined;
  workspaceRoot = '/ws';
  vi.resetModules();
  const mod = await import('../neoxConfigTool.js');
  const tools = (mod as any).createNeoxConfigTools?.() ?? (mod as any).neoxConfigTools ?? [];
  mcpTool = (Array.isArray(tools) ? tools : Object.values(tools)).find((t: any) => t?.name === 'neox_mcp_manage');
  expect(mcpTool, 'neox_mcp_manage 必须能取到').toBeTruthy();
});

const list = () => mcpTool.function({ action: 'list' });

describe('list 必须看到工作区级配置 —— 这就是实拍那个 bug', () => {
  it('只有工作区配置时, 不许回答"没有配置"', async () => {
    workspaceServers = [WS_SERVER];
    const out = await list();
    expect(out).not.toContain('当前没有配置');
    expect(out).toContain('ws-echo');
  });

  it('标出 scope, 让模型知道这条改不动', async () => {
    workspaceServers = [WS_SERVER];
    expect(await list()).toContain('[工作区]');
  });

  it('两个 scope 都有时一起列出来', async () => {
    userServers = [USER_SERVER];
    workspaceServers = [WS_SERVER];
    const out = await list();
    expect(out).toContain('user-fs');
    expect(out).toContain('ws-echo');
    expect(out).toContain('MCP Servers (2)');
  });

  it('真的一个都没有时仍然说"没有配置"', async () => {
    expect(await list()).toContain('当前没有配置');
  });

  it('拿不到工作区上下文时退回用户级, 不炸也不瞎猜目录', async () => {
    workspaceRoot = undefined;
    userServers = [USER_SERVER];
    const out = await list();
    expect(out).toContain('user-fs');
  });
});

describe('总开关关着必须明说 —— 否则模型以为是自己名字写错了', () => {
  it('enabled=false 时给出警告和打开方法', async () => {
    mcpEnabled = false;
    workspaceServers = [WS_SERVER];
    const out = await list();
    expect(out).toContain('总开关');
    expect(out).toContain('不会注册');
  });

  it('开关没关时不啰嗦', async () => {
    mcpEnabled = true;
    workspaceServers = [WS_SERVER];
    expect(await list()).not.toContain('总开关');
  });

  it('未设置 (undefined) 视为没关', async () => {
    workspaceServers = [WS_SERVER];
    expect(await list()).not.toContain('总开关');
  });
});

describe('add / remove / toggle 跨 scope 时不许含糊', () => {
  it('add 撞上工作区同 id 时要拦住并说清是哪个 scope', async () => {
    workspaceServers = [WS_SERVER];
    const out = await mcpTool.function({ action: 'add', id: 'ws-echo', command: 'node' });
    expect(out).toContain('已存在');
    expect(out).toContain('工作区级');
    expect(userServers).toHaveLength(0);
  });

  it('remove 一个工作区条目时说"改不了", 不许说"不存在"', async () => {
    workspaceServers = [WS_SERVER];
    const out = await mcpTool.function({ action: 'remove', id: 'ws-echo' });
    expect(out).toContain('工作区级');
    expect(out).not.toMatch(/^❌ Server "ws-echo" 不存在/);
  });

  it('toggle 同理', async () => {
    workspaceServers = [WS_SERVER];
    expect(await mcpTool.function({ action: 'toggle', id: 'ws-echo' })).toContain('工作区级');
  });

  it('两个 scope 都没有才说"不存在"', async () => {
    expect(await mcpTool.function({ action: 'remove', id: 'ghost' })).toContain('不存在');
  });

  it('用户级条目照常能删', async () => {
    userServers = [{ ...USER_SERVER }];
    const out = await mcpTool.function({ action: 'remove', id: 'user-fs' });
    expect(out).toContain('已删除');
    expect(userServers).toHaveLength(0);
  });
});
