import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createStore } from '../store.js';
import { getDefaultAppState, type NeoxAppState } from '../appState.js';
import { onStateChange, registerStateChangeHooks, recordApproval, recordToolCall, appendAuditLog } from '../onStateChange.js';
import { getPermissionSummary, getMcpHealthStatus, getSystemHealth, getTopTools } from '../selectors.js';
import { createSnapshot, restoreFromSnapshot } from '../persistence.js';
import { initGlobalStore, getAppState, setAppState, destroyGlobalStore } from '../index.js';

describe('NeoxAppState defaults', () => {
  it('creates valid default state', () => {
    const state = getDefaultAppState({ workDir: '/test', version: '1.0.0' });
    expect(state.initialized).toBe(false);
    expect(state.version).toBe('1.0.0');
    expect(state.workDir).toBe('/test');
    expect(state.runMode).toBe('agentic');
    expect(state.permissions.mode).toBe('manual');
    expect(state.mcp.enabled).toBe(true);
    expect(state.ui.language).toBe('zh');
    expect(state.auditLog).toEqual([]);
  });
});

describe('onStateChange side effects', () => {
  it('calls onPermissionModeChange hook', () => {
    const hook = vi.fn();
    registerStateChangeHooks({ onPermissionModeChange: hook });

    const old = getDefaultAppState();
    const next = { ...old, permissions: { ...old.permissions, mode: 'auto' as const } };
    onStateChange({ newState: next, oldState: old });

    expect(hook).toHaveBeenCalledWith('auto', 'manual');
  });

  it('calls onAuthChange on authVersion bump', () => {
    const hook = vi.fn();
    registerStateChangeHooks({ onAuthChange: hook });

    const old = getDefaultAppState();
    const next = { ...old, authVersion: 1 };
    onStateChange({ newState: next, oldState: old });

    expect(hook).toHaveBeenCalled();
  });

  it('does not fire hooks when state is unchanged', () => {
    const hook = vi.fn();
    registerStateChangeHooks({ onPermissionModeChange: hook });

    const state = getDefaultAppState();
    onStateChange({ newState: state, oldState: state });

    expect(hook).not.toHaveBeenCalled();
  });
});

describe('State updater functions', () => {
  it('recordApproval appends to history', () => {
    const state = getDefaultAppState();
    const updated = recordApproval({
      timestamp: Date.now(),
      toolName: 'bash',
      toolCategory: 'EXECUTE',
      approved: true,
      remembered: false,
    })(state);

    expect(updated.permissions.history.length).toBe(1);
    expect(updated.permissions.history[0].toolName).toBe('bash');
  });

  it('recordToolCall updates metrics', () => {
    const state = getDefaultAppState();
    const updated = recordToolCall('read_file', 'READ', true, 50)(state);

    expect(updated.toolMetrics.totalCalls).toBe(1);
    expect(updated.toolMetrics.byTool['read_file'].count).toBe(1);
    expect(updated.toolMetrics.byTool['read_file'].avgDurationMs).toBe(50);
    expect(updated.toolMetrics.byCategory['READ']).toBe(1);
  });

  it('recordToolCall accumulates correctly', () => {
    let state = getDefaultAppState();
    state = recordToolCall('edit', 'WRITE', true, 100)(state);
    state = recordToolCall('edit', 'WRITE', false, 200)(state);

    expect(state.toolMetrics.byTool['edit'].count).toBe(2);
    expect(state.toolMetrics.byTool['edit'].successCount).toBe(1);
    expect(state.toolMetrics.byTool['edit'].failCount).toBe(1);
    expect(state.toolMetrics.byTool['edit'].avgDurationMs).toBe(150);
  });

  it('appendAuditLog trims at max capacity', () => {
    let state = getDefaultAppState();
    for (let i = 0; i < 250; i++) {
      state = appendAuditLog('test', `action-${i}`)(state);
    }
    expect(state.auditLog.length).toBe(200);
    expect(state.auditLog[0].action).toBe('action-50'); // oldest trimmed
  });
});

describe('Selectors', () => {
  it('getPermissionSummary calculates approval rate', () => {
    const state = getDefaultAppState();
    state.permissions.history = [
      { timestamp: Date.now(), toolName: 'a', toolCategory: 'READ', approved: true, remembered: false },
      { timestamp: Date.now(), toolName: 'b', toolCategory: 'WRITE', approved: false, remembered: false },
      { timestamp: Date.now(), toolName: 'c', toolCategory: 'READ', approved: true, remembered: true },
    ];

    const summary = getPermissionSummary(state);
    expect(summary.approvalRate).toBe(67); // 2/3
    expect(summary.recentApprovals).toBe(3);
  });

  it('getMcpHealthStatus returns correct status', () => {
    const state = getDefaultAppState();
    state.mcp.servers = [
      { id: 'a', status: 'connected', toolCount: 3, consecutiveErrors: 0, epoch: 1 },
      { id: 'b', status: 'error', toolCount: 0, consecutiveErrors: 2, epoch: 1, lastError: 'fail' },
    ];

    const health = getMcpHealthStatus(state);
    expect(health.status).toBe('degraded');
    expect(health.connectedCount).toBe(1);
    expect(health.errorCount).toBe(1);
  });

  it('getMcpHealthStatus disabled', () => {
    const state = getDefaultAppState();
    state.mcp.enabled = false;
    expect(getMcpHealthStatus(state).status).toBe('disabled');
  });

  it('getSystemHealth aggregates all systems', () => {
    const state = getDefaultAppState();
    state.memoryPressure = 'critical';
    const health = getSystemHealth(state);
    expect(health.overall).toBe('critical');
    expect(health.details.some(d => d.includes('CRITICAL'))).toBe(true);
  });

  it('getTopTools returns sorted results', () => {
    const state = getDefaultAppState();
    state.toolMetrics.byTool = {
      'read': { count: 10, successCount: 10, failCount: 0, avgDurationMs: 5, lastCalledAt: 0 },
      'write': { count: 50, successCount: 45, failCount: 5, avgDurationMs: 20, lastCalledAt: 0 },
      'bash': { count: 3, successCount: 2, failCount: 1, avgDurationMs: 100, lastCalledAt: 0 },
    };

    const top = getTopTools(state, 2);
    expect(top.length).toBe(2);
    expect(top[0].name).toBe('write');
    expect(top[0].successRate).toBe(90);
    expect(top[1].name).toBe('read');
  });
});

describe('Snapshot persistence', () => {
  it('createSnapshot captures key fields', () => {
    const state = getDefaultAppState({ workDir: '/project', version: '2.0' });
    state.permissions.mode = 'auto';
    state.settings.model = 'gpt-4';
    state.ui.verbose = true;

    const snapshot = createSnapshot(state);
    expect(snapshot.version).toBe(2);
    expect(snapshot.workDir).toBe('/project');
    expect(snapshot.permissionMode).toBe('auto');
    expect(snapshot.settings.model).toBe('gpt-4');
    expect(snapshot.ui.verbose).toBe(true);
  });

  it('restoreFromSnapshot produces valid state', () => {
    const state = getDefaultAppState();
    state.permissions.mode = 'dangerous';
    state.ui.fastMode = true;

    const snapshot = createSnapshot(state);
    const restored = restoreFromSnapshot(snapshot, { workDir: '/new' });

    expect(restored.workDir).toBe('/new');
    expect(restored.permissions.mode).toBe('dangerous');
    expect(restored.ui.fastMode).toBe(true);
    expect(restored.initialized).toBe(false); // not preserved
  });

  it('restoreFromSnapshot handles invalid snapshot', () => {
    const restored = restoreFromSnapshot({ version: 1 } as any);
    expect(restored.permissions.mode).toBe('manual'); // defaults
  });
});

describe('Global store', () => {
  afterEach(() => {
    destroyGlobalStore();
    // Reset hooks
    registerStateChangeHooks({});
  });

  it('initGlobalStore creates singleton', () => {
    const store = initGlobalStore();
    const state = store.getState();
    expect(state.runMode).toBe('agentic');
    expect(state.permissions.mode).toBe('manual');
  });

  it('getAppState/setAppState work on global store', () => {
    initGlobalStore(undefined, { version: '3.0' });
    expect(getAppState().version).toBe('3.0');

    setAppState(prev => ({ ...prev, isRunning: true }));
    expect(getAppState().isRunning).toBe(true);
  });

  it('full integration: store + onChange + selectors', () => {
    const hook = vi.fn();
    registerStateChangeHooks({ onPermissionModeChange: hook });

    const store = initGlobalStore();

    // Record some tool calls
    store.setState(recordToolCall('bash', 'EXECUTE', true, 100));
    store.setState(recordToolCall('read', 'READ', true, 10));
    store.setState(recordApproval({
      timestamp: Date.now(), toolName: 'bash', toolCategory: 'EXECUTE',
      approved: true, remembered: true,
    }));

    // Check metrics via selector
    const top = getTopTools(store.getState());
    expect(top.length).toBe(2);

    // Change permission mode
    store.setState(prev => ({
      ...prev,
      permissions: { ...prev.permissions, mode: 'auto' as const },
    }));
    expect(hook).toHaveBeenCalledWith('auto', 'manual');

    // System health
    const health = getSystemHealth(store.getState());
    expect(health.overall).toBe('healthy');
  });
});
