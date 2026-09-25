/**
 * CLI Permission Setup - CLI 权限系统设置
 *
 * 为 CLI 配置权限管理器和默认权限
 */

import { PermissionManager, applyDefaultToolPermissions } from '@neoxlabs/kernel/core/permissions/index.js';
import { ToolPermission } from '@neoxlabs/kernel/types/permissions.js';
import type { ApprovalMode } from '@neoxlabs/platform/utils/config.js';
import { createFilePermissionStorage } from '@neoxlabs/core/core/permissions/index.js';
import { showApprovalDialog } from './approvalDialog.js';

export function createCLIPermissionManager(approvalMode: 'auto' | 'manual' | 'dangerous' = 'auto'): PermissionManager {
  const isDangerous = approvalMode === 'dangerous';

  const permissionManager = new PermissionManager({
    // dangerous 模式不设置 approvalHandler
    approvalHandler: isDangerous ? undefined : showApprovalDialog,
    storage: createFilePermissionStorage(),
    // dangerous: 全部 ALLOW; auto/manual: 默认 ASK（通过 defaultPermissions 给白名单 read 工具放行）
    defaultPermission: isDangerous ? ToolPermission.ALLOW : ToolPermission.ASK,
    memoryExpirationMs: 24 * 60 * 60 * 1000,
    /* CLI 单进程, 没有 per-scope override (那是 server/agent 多 scope 场景),
     * 所有 scopeKey 都返当前 approvalMode. 这条不传 PermissionManager
     * 不知道 dangerous → 弹 prompt. */
    scopeModeResolver: () => approvalMode as ApprovalMode,
  });

  // auto 模式: 应用默认权限（读工具 ALLOW，写/执行/网络工具 ASK）
  // manual 模式: 也应用默认权限（但 defaultPermission 已经是 ASK）
  // dangerous 模式: 跳过，全部 ALLOW
  if (!isDangerous) {
    applyDefaultToolPermissions(permissionManager);
  }

  return permissionManager;
}

/**
 * 获取权限管理器的统计信息
 */
export function getPermissionStats(pm: PermissionManager) {
  return pm.getStats();
}
