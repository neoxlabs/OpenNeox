import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PermissionManager } from '../PermissionManager.js';
import { ToolPermission, ToolCategory } from '../../../types/permissions.js';
import { __resetApprovalCacheForTest } from '../approvalCache.js';
import type { ApprovalMode } from '../../../types/configTypes.js';

vi.mock('../../kernelConfigBridge.js', () => ({
  getKernelConfig: () => ({ agentRuntime: { approvalCache: { enabled: true }, injectionGuard: true } }),
}));

const mkTool = (name: string, extra: Record<string, any> = {}) => ({
  name,
  description: '',
  parameters: { type: 'object', properties: {} },
  async function() { return 'ok'; },
  ...extra,
} as any);

const readTool = mkTool('readfile', { isReadOnly: true });
const writeTool = mkTool('write_file');
const shellTool = mkTool('execute_shell');
const sendTool = mkTool('send_imessage', { sideEffect: 'outbound' });

const approved = () => ({ approved: true });

const resolveMode = (modes: Record<string, ApprovalMode>) => (scope?: string) => scope ? modes[scope] : undefined;

beforeEach(() => {
  __resetApprovalCacheForTest();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PermissionManager — 非 ASK 分支', () => {
  it('显式 ALLOW 直接放行', async () => {
    const m = new PermissionManager();
    m.setToolPermission({ toolName: 'write_file', permission: ToolPermission.ALLOW });
    const d = await m.checkPermission(writeTool, { file_path: 'a', content: 'x' });
    expect(d).toMatchObject({ allowed: true, source: 'config' });
  });

  it('显式 DENY 直接拒，source=config', async () => {
    const m = new PermissionManager();
    m.setToolPermission({ toolName: 'write_file', permission: ToolPermission.DENY, reason: 'nope' });
    const d = await m.checkPermission(writeTool, {});
    expect(d).toMatchObject({ allowed: false, source: 'config', reason: 'nope', denyKind: 'denied_by_config' });
  });

  it('工具元数据 defaultPermission 生效', async () => {
    const tool = mkTool('readfile', { isReadOnly: true, permission: { category: ToolCategory.READ, defaultPermission: ToolPermission.ALLOW } });
    const d = await new PermissionManager().checkPermission(tool, {});
    expect(d.allowed).toBe(true);
  });

  it('config.defaultPermission 是最后的默认值', async () => {
    const d = await new PermissionManager({ defaultPermission: ToolPermission.ALLOW }).checkPermission(writeTool, {});
    expect(d.allowed).toBe(true);
  });

  it('isReadOnly 工具在 manual 档直接放行（即使默认 ASK）', async () => {
    const m = new PermissionManager({ scopeModeResolver: resolveMode({ s: 'manual' }) });
    expect((await m.checkPermission(readTool, {}, { scopeKey: 's' })).allowed).toBe(true);
  });
});

describe('PermissionManager — manual / auto / dangerous 三档', () => {
  it('manual：写工具 ASK，读工具 ALLOW', async () => {
    const handler = vi.fn(async () => approved());
    const m = new PermissionManager({ approvalHandler: handler, scopeModeResolver: resolveMode({ s: 'manual' }) });
    expect((await m.checkPermission(writeTool, { file_path: 'a' }, { scopeKey: 's' })).allowed).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect((await m.checkPermission(readTool, {}, { scopeKey: 's' })).needsApproval).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('auto：普通写操作直接放行，source=mode', async () => {
    const handler = vi.fn(async () => approved());
    const m = new PermissionManager({ approvalHandler: handler, scopeModeResolver: resolveMode({ s: 'auto' }) });
    const d = await m.checkPermission(writeTool, { file_path: 'a', content: 'x' }, { scopeKey: 's' });
    expect(d).toMatchObject({ allowed: true, source: 'mode' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('auto：high 风险（rm -rf 子目录）也直接放行', async () => {
    const handler = vi.fn(async () => approved());
    const m = new PermissionManager({ approvalHandler: handler, scopeModeResolver: resolveMode({ s: 'auto' }) });
    const d = await m.checkPermission(shellTool, { command: 'rm -rf ./dist' }, { scopeKey: 's' });
    expect(d.allowed).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('auto：critical（rm -rf /）要问', async () => {
    const handler = vi.fn(async () => approved());
    const m = new PermissionManager({ approvalHandler: handler, scopeModeResolver: resolveMode({ s: 'auto' }) });
    const d = await m.checkPermission(shellTool, { command: 'rm -rf /' }, { scopeKey: 's' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(d.allowed).toBe(true);
    expect(d.source).toBe('user');
  });

  it('auto：显式 DENY 仍然拒', async () => {
    const m = new PermissionManager({ scopeModeResolver: resolveMode({ s: 'auto' }) });
    m.setToolPermission({ toolName: 'write_file', permission: ToolPermission.DENY });
    expect((await m.checkPermission(writeTool, {}, { scopeKey: 's' })).allowed).toBe(false);
  });

  it('dangerous：critical 也不问、不弹审批', async () => {
    const handler = vi.fn(async () => approved());
    const m = new PermissionManager({ approvalHandler: handler, scopeModeResolver: resolveMode({ s: 'dangerous' }) });
    const d = await m.checkPermission(shellTool, { command: 'rm -rf /' }, { scopeKey: 's' });
    expect(d).toMatchObject({ allowed: true, source: 'mode' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('manual 档不认 Always Allow 记忆', async () => {
    const handler = vi.fn(async () => ({ approved: true, remember: true }));
    const m = new PermissionManager({ approvalHandler: handler, scopeModeResolver: resolveMode({ s: 'manual' }) });
    await m.checkPermission(writeTool, { file_path: 'a' }, { scopeKey: 's' });
    await m.checkPermission(writeTool, { file_path: 'a' }, { scopeKey: 's' });
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe('PermissionManager — fail-close 与审批异常', () => {
  it('没有 approval handler 时拒绝', async () => {
    const d = await new PermissionManager().checkPermission(writeTool, { file_path: 'a' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('fail-close');
  });

  it('无 handler + 高风险时 reason 带风险等级', async () => {
    const d = await new PermissionManager().checkPermission(shellTool, { command: 'rm -rf /' });
    expect(d.reason).toContain('CRITICAL');
  });

  it('handler 抛错 → 拒绝，denyKind=error', async () => {
    const m = new PermissionManager({ approvalHandler: async () => { throw new Error('ui crashed'); } });
    const d = await m.checkPermission(writeTool, { file_path: 'a' });
    expect(d.allowed).toBe(false);
    expect(d.denyKind).toBe('error');
    expect(d.reason).toContain('ui crashed');
  });

  it('用户拒绝 → denyKind=denied_by_user', async () => {
    const m = new PermissionManager({ approvalHandler: async () => ({ approved: false }) });
    const d = await m.checkPermission(writeTool, { file_path: 'a' });
    expect(d).toMatchObject({ allowed: false, source: 'user', denyKind: 'denied_by_user' });
  });
});

describe('PermissionManager — 粗粒度记忆', () => {
  it('勾选记住允许 → 下一次免问', async () => {
    const handler = vi.fn(async () => ({ approved: true, remember: true }));
    const m = new PermissionManager({ approvalHandler: handler });
    await m.checkPermission(writeTool, { file_path: 'a' }, {});
    m.setApprovalHandler(undefined);
    const d = await m.checkPermission(writeTool, { file_path: 'b' }, {});
    expect(d).toMatchObject({ allowed: true, source: 'remembered' });
  });

  it('勾选记住拒绝 → 下一次直接拒', async () => {
    const m = new PermissionManager({ approvalHandler: async () => ({ approved: false, remember: true }) });
    await m.checkPermission(writeTool, { file_path: 'a' });
    m.setApprovalHandler(vi.fn(async () => ({ approved: true })) as any);
    const d = await m.checkPermission(writeTool, { file_path: 'b' });
    expect(d).toMatchObject({ allowed: false, source: 'remembered', denyKind: 'denied_by_user' });
  });

  it('高风险工具不提供 remember（allowRemember=false）', async () => {
    let seen: any;
    const m = new PermissionManager({ approvalHandler: async (req) => { seen = req; return { approved: true, remember: true }; } });
    await m.checkPermission(shellTool, { command: 'rm -rf ./dist' });
    expect(seen.allowRemember).toBe(false);
  });

  it('记忆过期后重新询问', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const handler = vi.fn(async () => { calls++; return { approved: true, remember: true }; });
    const m = new PermissionManager({ approvalHandler: handler, memoryExpirationMs: 100 });
    await m.checkPermission(writeTool, { file_path: 'a' });
    vi.advanceTimersByTime(101);
    m.setApprovalHandler(handler);
    await m.checkPermission(writeTool, { file_path: 'b' });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(calls).toBe(2);
  });

  it('listAlwaysAllow 只列允许且未过期的，按时间倒序', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const m = new PermissionManager({ approvalHandler: async () => ({ approved: true, remember: true }) });
    await m.checkPermission(mkTool('tool_a'), {});
    vi.advanceTimersByTime(10);
    await m.checkPermission(mkTool('tool_b'), {});
    const list = m.listAlwaysAllow();
    expect(list.map(x => x.toolName)).toEqual(['tool_b', 'tool_a']);
  });

  it('revokeAlwaysAllow 后不再免问', async () => {
    const m = new PermissionManager({ approvalHandler: async () => ({ approved: true, remember: true }) });
    await m.checkPermission(writeTool, { file_path: 'a' });
    m.revokeAlwaysAllow('write_file');
    expect(m.listAlwaysAllow()).toEqual([]);
    m.setApprovalHandler(undefined);
    expect((await m.checkPermission(writeTool, { file_path: 'b' })).allowed).toBe(false);
  });

  it('clearMemory / clearMemoryForScope', async () => {
    const m = new PermissionManager({ approvalHandler: async () => ({ approved: true, remember: true }) });
    await m.checkPermission(writeTool, { file_path: 'a' });
    await m.checkPermission(mkTool('tool_b'), {});
    m.clearMemory('write_file');
    expect(m.listAlwaysAllow().map(x => x.toolName)).toEqual(['tool_b']);
    m.clearMemory();
    expect(m.listAlwaysAllow()).toEqual([]);
  });
});

describe('PermissionManager — 持久化', () => {
  it('记住决定时立即写盘，只写 always 桶', async () => {
    const save = vi.fn();
    const m = new PermissionManager({
      approvalHandler: async () => ({ approved: true, remember: true }),
      storage: { load: () => null, save },
    });
    await m.checkPermission(writeTool, { file_path: 'a' });
    expect(save).toHaveBeenCalled();
    const entries = save.mock.calls[save.mock.calls.length - 1][0];
    expect(entries['__always__::write_file']).toMatchObject({ toolName: 'write_file', decision: true });
  });

  it('启动时恢复 always allow，过期条目跳过', async () => {
    const storage = {
      load: () => ({
        '__always__::write_file': { toolName: 'write_file', decision: true, timestamp: 1 },
        '__always__::old_tool': { toolName: 'old_tool', decision: true, timestamp: 1, expiresAt: Date.now() - 1000 },
      }),
      save: vi.fn(),
    };
    const m = new PermissionManager({ storage });
    expect(m.listAlwaysAllow().map(x => x.toolName)).toEqual(['write_file']);
  });

  it('storage.load 抛错不影响构造', () => {
    const m = new PermissionManager({ storage: { load: () => { throw new Error('disk'); }, save: vi.fn() } });
    expect(m.listAlwaysAllow()).toEqual([]);
  });

  it('allowRemember=false 时忽略并清除历史永久授权', async () => {
    const m = new PermissionManager({
      storage: {
        load: () => ({ '__always__::call_tool': { toolName: 'call_tool', decision: true, timestamp: 1 } }),
        save: vi.fn(),
      },
    });
    m.setToolPermission({ toolName: 'call_tool', permission: ToolPermission.ASK, allowRemember: false });
    const d = await m.checkPermission(mkTool('call_tool'), { name: 'readfile', args: {} });
    expect(d.allowed).toBe(false);
    expect(m.listAlwaysAllow()).toEqual([]);
  });
});

describe('PermissionManager — 细粒度命令缓存', () => {
  it('同一条命令本 session 内只问一次', async () => {
    const handler = vi.fn(async () => approved());
    const m = new PermissionManager({ approvalHandler: handler });
    const args = { command: 'npm test', cwd: '/tmp/proj' };
    await m.checkPermission(shellTool, args);
    m.setApprovalHandler(undefined);
    const d = await m.checkPermission(shellTool, args);
    expect(d).toMatchObject({ allowed: true, source: 'remembered' });
  });

  it('不同命令不共享缓存', async () => {
    const handler = vi.fn(async () => approved());
    const m = new PermissionManager({ approvalHandler: handler });
    await m.checkPermission(shellTool, { command: 'npm test', cwd: '/tmp/proj' });
    m.setApprovalHandler(undefined);
    expect((await m.checkPermission(shellTool, { command: 'npm run build', cwd: '/tmp/proj' })).allowed).toBe(false);
  });

  it('拒绝也会缓存', async () => {
    const m = new PermissionManager({ approvalHandler: async () => ({ approved: false }) });
    const args = { command: 'npm test', cwd: '/tmp/proj' };
    await m.checkPermission(shellTool, args);
    m.setApprovalHandler(vi.fn(async () => approved()) as any);
    expect((await m.checkPermission(shellTool, args)).allowed).toBe(false);
  });

  it('critical 命令不缓存，每次都问', async () => {
    const handler = vi.fn(async () => approved());
    const m = new PermissionManager({ approvalHandler: handler });
    const args = { command: 'rm -rf /', cwd: '/tmp/proj' };
    await m.checkPermission(shellTool, args);
    await m.checkPermission(shellTool, args);
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe('PermissionManager — 来源闸（taint）', () => {
  const taint = {
    isTainted: () => true,
    describe: (effect: string, tool: string) => `读过外部内容，${tool} 要${effect}`,
    snapshot: () => ({ refs: ['https://evil.example'], suspectCount: 1, firstAt: Date.now() - 1000 }),
  } as any;

  it('manual 档 taint + 外发工具 → 问，并带上 provenance', async () => {
    let seen: any;
    const m = new PermissionManager({
      approvalHandler: async (req) => { seen = req; return approved(); },
      scopeModeResolver: resolveMode({ s: 'manual' }),
    });
    const d = await m.checkPermission(sendTool, { to: 'x', text: 'hi' }, { scopeKey: 's', taint });
    expect(d.allowed).toBe(true);
    expect(seen.provenance).toMatchObject({ sideEffect: 'outbound', suspectCount: 1 });
    expect(seen.reason).toContain('读过外部内容');
  });

  it('dangerous 档不挂来源闸', async () => {
    const handler = vi.fn(async () => approved());
    const m = new PermissionManager({ approvalHandler: handler, scopeModeResolver: resolveMode({ s: 'dangerous' }) });
    const d = await m.checkPermission(sendTool, {}, { scopeKey: 's', taint });
    expect(d.allowed).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('无 taint 时 auto 外发工具直接放行', async () => {
    const handler = vi.fn(async () => approved());
    const m = new PermissionManager({ approvalHandler: handler, scopeModeResolver: resolveMode({ s: 'auto' }) });
    expect((await m.checkPermission(sendTool, {}, { scopeKey: 's' })).allowed).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('auto 档 (默认) 染色后也不挂来源闸 —— 10-21 用户: 默认放开', async () => {
    const handler = vi.fn(async () => approved());
    const m = new PermissionManager({ approvalHandler: handler, scopeModeResolver: resolveMode({ s: 'auto' }) });
    expect((await m.checkPermission(sendTool, { to: 'x', text: 'hi' }, { scopeKey: 's', taint })).allowed).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('PermissionManager — scope 继承与查询辅助', () => {
  it('子 scope 继承父 scope 的档位', async () => {
    const m = new PermissionManager({ scopeModeResolver: (k) => (k === 'parent' ? 'dangerous' : undefined) });
    m.inheritScope('child', 'parent');
    expect(m.getScopeMode({ scopeKey: 'child' })).toBe('dangerous');
    expect(m.shouldForcePermissionCheck({ scopeKey: 'child' })).toBe(false);
  });

  it('多级继承（子 → 父 → 祖父）', () => {
    const m = new PermissionManager({ scopeModeResolver: (k) => (k === 'root' ? 'manual' : undefined) });
    m.inheritScope('child', 'parent');
    m.inheritScope('parent', 'root');
    expect(m.getScopeMode({ scopeKey: 'child' })).toBe('manual');
    expect(m.shouldForcePermissionCheck({ scopeKey: 'child' })).toBe(true);
  });

  it('空白 / 相同 scope 的 inherit 被忽略', () => {
    const m = new PermissionManager({ scopeModeResolver: () => undefined });
    m.inheritScope('', 'p');
    m.inheritScope('a', '');
    m.inheritScope('a', 'a');
    expect(m.getScopeMode({ scopeKey: 'a' })).toBeUndefined();
  });
});

describe('PermissionManager — 统计', () => {
  it('getStats 统计配置与记忆', async () => {
    const m = new PermissionManager({ approvalHandler: async () => ({ approved: true, remember: true }) });
    m.setToolPermissions([
      { toolName: 'a', permission: ToolPermission.ALLOW },
      { toolName: 'b', permission: ToolPermission.ASK },
      { toolName: 'c', permission: ToolPermission.DENY },
    ]);
    await m.checkPermission(writeTool, { file_path: 'x' });
    expect(m.getStats()).toMatchObject({
      totalConfigured: 3, allowCount: 1, askCount: 1, denyCount: 1, memorizedApproved: 1, memorizedDenied: 0,
    });
  });
});
