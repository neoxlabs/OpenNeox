import { AgentMode } from '@neoxlabs/kernel/core/runner.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import type { ApprovalModeResolver } from './approvalModeResolver.js';
import type { AgenticRuntime } from '../../runtime/agenticRuntime.js';
import type { PermissionManager } from '@neoxlabs/kernel/core/permissions/index.js';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { getApprovalCache } from '@neoxlabs/kernel/core/permissions/approvalCache.js';

interface SetApprovalModeOptions {
  mode: 'auto' | 'manual' | 'dangerous';
  scope?: 'global' | 'agent';
  scopeKey?: string;
  inherit?: boolean;
  approvalModeResolver: ApprovalModeResolver;
  singleRuntime: AgenticRuntime | null;
  permissionManager?: PermissionManager;
}

export function setApprovalMode(options: SetApprovalModeOptions): void {
  const { mode, scope = 'global', scopeKey, inherit, approvalModeResolver, singleRuntime, permissionManager } = options;
  if (mode !== 'auto' && mode !== 'manual' && mode !== 'dangerous') {
    throw new Error(`Invalid approval mode: ${String(mode)}. Expected auto | manual | dangerous.`);
  }
  const normalizedScopeKey = scopeKey?.trim().toLowerCase();

  if (scope === 'agent' && normalizedScopeKey) {
    const previousScopedMode = approvalModeResolver.resolveByScope(normalizedScopeKey);
    if (inherit) {
      approvalModeResolver.clearScopedMode(normalizedScopeKey);
      permissionManager?.clearMemoryForScope(normalizedScopeKey);
      /* 持久化: inherit 等价于"清掉 per-session, 回到 global"; DB 也得擦, 否则下次启动又被 seed 回来 */
      try { getDatabase().setSessionApprovalMode(normalizedScopeKey, null); }
      catch (err: any) { cliLogger.warn('SERVER', `persist approval clear failed: ${err?.message}`); }
      cliLogger.info(
        'SERVER',
        `Approval mode inherit global: scope=${normalizedScopeKey}, global=${approvalModeResolver.getGlobalMode()}`,
      );
      return;
    }

    approvalModeResolver.setScopedMode(normalizedScopeKey, mode);
    if (previousScopedMode !== mode) {
      permissionManager?.clearMemoryForScope(normalizedScopeKey);
      if (mode === 'manual') {
        getApprovalCache().clearScope(normalizedScopeKey);
      }
    }
    /* 持久化到 SQLite sessions.approval_mode — 重启 server 也不丢, 启动时 seedResolverFromDb
     *  会再 setScopedMode 回 resolver. sessionId 不在 sessions 表 (per-agent scope 如 'worker')
     *  时 UPDATE 影响 0 行, 无害. */
    try { getDatabase().setSessionApprovalMode(normalizedScopeKey, mode); }
    catch (err: any) { cliLogger.warn('SERVER', `persist approval mode failed: ${err?.message}`); }
    cliLogger.info('SERVER', `Approval mode set for scope=${normalizedScopeKey}: ${mode}`);
    /* DIAG (yolo-still-asks): 写入 scope/key 全貌, 跟 [PERM_DECIDE] 那行的 scopeKey 对比. */
    cliLogger.info('PERM_SET', `mode=${mode} scope=agent rawScopeKey=${scopeKey ?? '<undef>'} normalized=${normalizedScopeKey} globalMode=${approvalModeResolver.getGlobalMode()}`);
    return;
  }

  const previousGlobalMode = approvalModeResolver.getGlobalMode();
  approvalModeResolver.setGlobalMode(mode);
  if (previousGlobalMode !== mode) {
    permissionManager?.clearMemory();
    if (mode === 'manual') {
      getApprovalCache().clear();
    }
  }
  const agentMode = mode === 'dangerous' ? AgentMode.AUTO : AgentMode.AGENT;
  if (singleRuntime) singleRuntime.setAgentMode(agentMode);
  cliLogger.info(
    'SERVER',
    `Global approval mode set: ${mode} → agentMode=${agentMode === AgentMode.AUTO ? 'AUTO' : 'AGENT'}`,
  );
  /* DIAG (yolo-still-asks): global 路径也记一条, 方便区分前端走的是 'agent' 还是 'global' scope. */
  cliLogger.info('PERM_SET', `mode=${mode} scope=global prev=${previousGlobalMode}`);
}
