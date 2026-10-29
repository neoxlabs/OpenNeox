/**
 * W1 SandboxMode 单元测试
 *
 * 覆盖:
 *   - get/set/reset state
 *   - listener 触发 + unsubscribe
 *   - isCategoryBlockedBySandbox 各档行为
 *   - evaluateToolRisk 接受 sandboxMode 参数, READ_ONLY 注入 critical signal
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SandboxMode,
  DEFAULT_SANDBOX_MODE,
  getCurrentSandboxMode,
  setCurrentSandboxMode,
  resetSandboxMode,
  onSandboxModeChange,
  isCategoryBlockedBySandbox,
  __resetSandboxModeForTests,
} from '../sandboxMode.js';
import { evaluateToolRisk } from '../toolRiskEvaluator.js';
import { ToolCategory } from '../../types/permissions.js';

beforeEach(() => {
  __resetSandboxModeForTests();
});

afterEach(() => {
  __resetSandboxModeForTests();
});

// ============================================================================
// State get/set/reset
// ============================================================================

describe('sandboxMode — state', () => {
  it('默认 mode = WORKSPACE_WRITE', () => {
    expect(getCurrentSandboxMode()).toBe(SandboxMode.WORKSPACE_WRITE);
    expect(DEFAULT_SANDBOX_MODE).toBe(SandboxMode.WORKSPACE_WRITE);
  });

  it('setCurrentSandboxMode 切换 + 返 true', () => {
    const changed = setCurrentSandboxMode(SandboxMode.READ_ONLY);
    expect(changed).toBe(true);
    expect(getCurrentSandboxMode()).toBe(SandboxMode.READ_ONLY);
  });

  it('set 同 mode 返 false (no-op)', () => {
    setCurrentSandboxMode(SandboxMode.READ_ONLY);
    const changed = setCurrentSandboxMode(SandboxMode.READ_ONLY);
    expect(changed).toBe(false);
  });

  it('resetSandboxMode 回到 DEFAULT', () => {
    setCurrentSandboxMode(SandboxMode.DANGER_FULL_ACCESS);
    expect(getCurrentSandboxMode()).toBe(SandboxMode.DANGER_FULL_ACCESS);
    resetSandboxMode();
    expect(getCurrentSandboxMode()).toBe(DEFAULT_SANDBOX_MODE);
  });
});

// ============================================================================
// Listener
// ============================================================================

describe('sandboxMode — listener', () => {
  it('mode 变化时 listener 收到 (next, prev)', () => {
    const listener = vi.fn();
    onSandboxModeChange(listener);

    setCurrentSandboxMode(SandboxMode.READ_ONLY);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(SandboxMode.READ_ONLY, SandboxMode.WORKSPACE_WRITE);
  });

  it('same-mode set 不触发 listener', () => {
    const listener = vi.fn();
    setCurrentSandboxMode(SandboxMode.READ_ONLY);
    onSandboxModeChange(listener);

    setCurrentSandboxMode(SandboxMode.READ_ONLY);

    expect(listener).not.toHaveBeenCalled();
  });

  it('unsubscribe 后不再收到', () => {
    const listener = vi.fn();
    const unsub = onSandboxModeChange(listener);

    setCurrentSandboxMode(SandboxMode.READ_ONLY);
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    setCurrentSandboxMode(SandboxMode.DANGER_FULL_ACCESS);
    expect(listener).toHaveBeenCalledTimes(1);  // 还是 1
  });

  it('listener throw 不影响其它 listener', () => {
    const failing = vi.fn(() => { throw new Error('boom'); });
    const ok = vi.fn();
    onSandboxModeChange(failing);
    onSandboxModeChange(ok);

    setCurrentSandboxMode(SandboxMode.READ_ONLY);

    expect(failing).toHaveBeenCalled();
    expect(ok).toHaveBeenCalled();
  });
});

// ============================================================================
// isCategoryBlockedBySandbox
// ============================================================================

describe('isCategoryBlockedBySandbox', () => {
  it('READ_ONLY 下 READ 类不拒, 其余都拒', () => {
    expect(isCategoryBlockedBySandbox('read', SandboxMode.READ_ONLY)).toBe(false);
    expect(isCategoryBlockedBySandbox('write', SandboxMode.READ_ONLY)).toBe(true);
    expect(isCategoryBlockedBySandbox('execute', SandboxMode.READ_ONLY)).toBe(true);
    expect(isCategoryBlockedBySandbox('network', SandboxMode.READ_ONLY)).toBe(true);
    expect(isCategoryBlockedBySandbox('system', SandboxMode.READ_ONLY)).toBe(true);
  });

  it('WORKSPACE_WRITE 下 category 级别不拒 (具体由其它机制)', () => {
    for (const c of ['read', 'write', 'execute', 'network', 'system'] as const) {
      expect(isCategoryBlockedBySandbox(c, SandboxMode.WORKSPACE_WRITE)).toBe(false);
    }
  });

  it('DANGER_FULL_ACCESS 下 category 级别不拒', () => {
    for (const c of ['read', 'write', 'execute', 'network', 'system'] as const) {
      expect(isCategoryBlockedBySandbox(c, SandboxMode.DANGER_FULL_ACCESS)).toBe(false);
    }
  });

  it('不传 mode 时读 getCurrentSandboxMode', () => {
    setCurrentSandboxMode(SandboxMode.READ_ONLY);
    expect(isCategoryBlockedBySandbox('write')).toBe(true);
    setCurrentSandboxMode(SandboxMode.WORKSPACE_WRITE);
    expect(isCategoryBlockedBySandbox('write')).toBe(false);
  });
});

// ============================================================================
// evaluateToolRisk + sandboxMode 集成
// ============================================================================

describe('evaluateToolRisk + sandboxMode', () => {
  it('READ_ONLY + WRITE category → 注入 critical sandbox:read-only-violation', () => {
    const assessment = evaluateToolRisk({
      toolName: 'edit',
      args: { path: '/a.ts', start_line: 1, end_line: 2, new_string: 'x' },
      category: ToolCategory.WRITE,
      sandboxMode: SandboxMode.READ_ONLY,
    });

    const sig = assessment.signals.find((s) => s.code === 'sandbox:read-only-violation');
    expect(sig).toBeDefined();
    expect(sig!.level).toBe('critical');
    expect(sig!.domain).toBe('sandbox');
    expect(sig!.message).toContain('read-only');
  });

  it('READ_ONLY + READ category → 不注入 sandbox signal', () => {
    const assessment = evaluateToolRisk({
      toolName: 'readfile',
      args: { path: '/a.ts' },
      category: ToolCategory.READ,
      sandboxMode: SandboxMode.READ_ONLY,
    });

    const sig = assessment.signals.find((s) => s.code === 'sandbox:read-only-violation');
    expect(sig).toBeUndefined();
  });

  it('WORKSPACE_WRITE + WRITE → 不注入 sandbox signal', () => {
    const assessment = evaluateToolRisk({
      toolName: 'edit',
      args: { path: '/a.ts' },
      category: ToolCategory.WRITE,
      sandboxMode: SandboxMode.WORKSPACE_WRITE,
    });

    expect(assessment.signals.find((s) => s.code === 'sandbox:read-only-violation')).toBeUndefined();
  });

  it('不传 sandboxMode → 读 getCurrentSandboxMode', () => {
    setCurrentSandboxMode(SandboxMode.READ_ONLY);
    const assessment = evaluateToolRisk({
      toolName: 'edit',
      args: { path: '/a.ts' },
      category: ToolCategory.WRITE,
    });
    expect(assessment.signals.find((s) => s.code === 'sandbox:read-only-violation')).toBeDefined();
  });

  it('READ_ONLY 但 category 缺失 → 不能判断, 不注入 (避免误拦)', () => {
    const assessment = evaluateToolRisk({
      toolName: 'mystery_tool',
      args: {},
      sandboxMode: SandboxMode.READ_ONLY,
      /* no category */
    });
    expect(assessment.signals.find((s) => s.code === 'sandbox:read-only-violation')).toBeUndefined();
  });

  it('Sandbox signal 跟 shell signal 共存 (READ_ONLY + 危险 rm)', () => {
    const assessment = evaluateToolRisk({
      toolName: 'execute_shell',
      args: { command: 'rm -rf /' },
      category: ToolCategory.EXECUTE,
      sandboxMode: SandboxMode.READ_ONLY,
    });
    const sandbox = assessment.signals.find((s) => s.code === 'sandbox:read-only-violation');
    const shell = assessment.signals.find((s) => s.domain === 'shell');
    expect(sandbox).toBeDefined();
    expect(shell).toBeDefined();
  });
});
