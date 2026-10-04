/**
 * 「记住已批准的命令」开关
 * ═════════════════════════════════════════════════════════════════
 * 这个设置项在设置页存在很久, 但 PermissionManager 里**没有任何读点** —— 无条件缓存。
 * 用户把它关掉后仍然不会被重新询问, 而他关它的目的恰恰是"每次都问我"。
 * 安全方向上这是"以为收紧了、实际没有", 所以补 gate 并用真实 PermissionManager 钉住。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PermissionManager } from '../PermissionManager.js';
import { ToolPermission, ToolCategory } from '../../../types/permissions.js';
import { __resetApprovalCacheForTest } from '../approvalCache.js';
import { setKernelConfigProvider } from '../../kernelConfigBridge.js';

function makeShellTool() {
  return {
    name: 'execute_shell',
    description: 'run shell',
    category: ToolCategory.EXECUTE,
    parameters: { type: 'object', properties: { command: { type: 'string' } } },
    execute: async () => ({ content: 'ok' }),
  } as any;
}

function makePM(handler: any) {
  const pm = new PermissionManager({
    approvalHandler: handler,
    /* auto 而非 manual: manual 模式下 honorRemembered 恒假, 细粒度缓存本来就不读,
       用它测不出这个开关的差别。 */
    scopeModeResolver: () => 'auto',
  });
  pm.setToolPermission({ toolName: 'execute_shell', permission: ToolPermission.ASK, allowRemember: true });
  return pm;
}

/** The approval count for asking twice about the same command and directory.
 *
 * In auto mode, critical commands always require approval and are not cached;
 * the test verifies that the remember setting cannot change that behavior. */
async function askTwice(command = 'rm -rf ./dist'): Promise<number> {
  const handler = vi.fn(async () => ({ approved: true, remember: false }));
  const pm = makePM(handler);
  const args = { command, cwd: '/tmp/proj' };
  await pm.checkPermission(makeShellTool(), args, { scopeKey: 'session-x' });
  await pm.checkPermission(makeShellTool(), args, { scopeKey: 'session-x' });
  return handler.mock.calls.length;
}

beforeEach(() => __resetApprovalCacheForTest());
afterEach(() => setKernelConfigProvider(null));

describe('「记住已批准的命令」开关', () => {
  it.each([
    ['关掉', () => ({ agentRuntime: { approvalCache: { enabled: false } } })],
    ['开启', () => ({ agentRuntime: { approvalCache: { enabled: true } } })],
    ['没配过', () => ({})],
  ])('%s → auto 档的 high 命令一次都不问', async (_label, provider) => {
    setKernelConfigProvider(provider as never);
    expect(await askTwice()).toBe(0);
  });

  it('provider 未接上 (纯 kernel) → 不炸', async () => {
    setKernelConfigProvider(null);
    expect(await askTwice()).toBe(0);
  });

  it('critical 永远不进缓存 —— 开着开关也每次都问', async () => {
    setKernelConfigProvider(() => ({ agentRuntime: { approvalCache: { enabled: true } } }));
    const handler = vi.fn(async () => ({ approved: true, remember: false }));
    const pm = makePM(handler);
    const args = { command: 'rm -rf /', cwd: '/tmp/proj' };
    await pm.checkPermission(makeShellTool(), args, { scopeKey: 'session-c' });
    await pm.checkPermission(makeShellTool(), args, { scopeKey: 'session-c' });
    expect(handler.mock.calls.length).toBe(2);
  });

  it('auto 档的日常命令根本不进审批 —— 开关对它没有意义', async () => {
    setKernelConfigProvider(() => ({ agentRuntime: { approvalCache: { enabled: false } } }));
    const handler = vi.fn(async () => ({ approved: true, remember: false }));
    const pm = makePM(handler);
    const decision = await pm.checkPermission(
      makeShellTool(),
      { command: 'npm test', cwd: '/tmp/proj' },
      { scopeKey: 'session-l' },
    );
    expect(handler).not.toHaveBeenCalled();
    expect(decision.allowed).toBe(true);
  });
});
