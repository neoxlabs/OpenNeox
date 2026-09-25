import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApprovalModeResolver } from '../approvalModeResolver.js';

/* DB / 审批缓存都是副作用, 这里只关心 resolver 的最终状态 */
vi.mock('@neoxlabs/platform/platform/database.js', () => ({
  getDatabase: () => ({ setSessionApprovalMode: () => {} }),
}));
vi.mock('@neoxlabs/kernel/core/permissions/approvalCache.js', () => ({
  getApprovalCache: () => ({ clear: () => {}, clearScope: () => 0 }),
}));

const { setApprovalMode } = await import('../approvalModeSetter.js');

const makeResolver = () =>
  new ApprovalModeResolver({ agentApprovalMode: 'dangerous' } as any);

describe('setApprovalMode 的 scope 语义', () => {
  beforeEach(() => {
    delete process.env.NEOX_FORCE_APPROVAL_MODE;
  });

  it("scope='agent' 只改这个会话, 全局纹丝不动", () => {
    const resolver = makeResolver();
    setApprovalMode({
      mode: 'manual',
      scope: 'agent',
      scopeKey: 'print-123',
      approvalModeResolver: resolver,
      singleRuntime: null,
    });
    expect(resolver.resolveByScope('print-123')).toBe('manual');
    /* 关键: 别的会话 + 全局都还是 dangerous —— 这正是两次回归里坏掉的地方 */
    expect(resolver.getGlobalMode()).toBe('dangerous');
    expect(resolver.resolveByScope('session-tui-999')).toBe('dangerous');
  });

  it('不传 scope = 全局 (缺省语义本身也要钉住)', () => {
    const resolver = makeResolver();
    setApprovalMode({
      mode: 'manual',
      approvalModeResolver: resolver,
      singleRuntime: null,
    });
    expect(resolver.getGlobalMode()).toBe('manual');
  });

  it("scope='agent' 但没给 scopeKey → 落回全局 (不能悄悄变成空 key 的会话)", () => {
    const resolver = makeResolver();
    setApprovalMode({
      mode: 'manual',
      scope: 'agent',
      scopeKey: '   ',
      approvalModeResolver: resolver,
      singleRuntime: null,
    });
    expect(resolver.getGlobalMode()).toBe('manual');
  });

  it('inherit 清掉会话覆盖, 回到全局', () => {
    const resolver = makeResolver();
    setApprovalMode({
      mode: 'manual', scope: 'agent', scopeKey: 's1',
      approvalModeResolver: resolver, singleRuntime: null,
    });
    expect(resolver.resolveByScope('s1')).toBe('manual');
    setApprovalMode({
      mode: 'manual', scope: 'agent', scopeKey: 's1', inherit: true,
      approvalModeResolver: resolver, singleRuntime: null,
    });
    expect(resolver.resolveByScope('s1')).toBe('dangerous');
  });

  it('非法 mode 直接抛, 不静默吞', () => {
    const resolver = makeResolver();
    expect(() => setApprovalMode({
      mode: 'suggest' as any,
      approvalModeResolver: resolver,
      singleRuntime: null,
    })).toThrow(/Invalid approval mode/);
  });
});

describe('ApprovalModeResolver 的 env 强制档', () => {
  beforeEach(() => {
    delete process.env.NEOX_FORCE_APPROVAL_MODE;
  });

  it('env 钉死时压过 config 与 per-scope', () => {
    process.env.NEOX_FORCE_APPROVAL_MODE = 'manual';
    const resolver = new ApprovalModeResolver({ agentApprovalMode: 'dangerous' } as any);
    resolver.setScopedMode('s1', 'dangerous');
    expect(resolver.getGlobalMode()).toBe('manual');
    expect(resolver.resolveByScope('s1')).toBe('manual');
    delete process.env.NEOX_FORCE_APPROVAL_MODE;
  });

  it('没设 env 时不干扰正常解析', () => {
    const resolver = new ApprovalModeResolver({ agentApprovalMode: 'dangerous' } as any);
    expect(resolver.resolveByScope('s1')).toBe('dangerous');
  });
});
