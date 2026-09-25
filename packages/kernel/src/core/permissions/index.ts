/**
 * Permission System - 权限系统
 *
 * 导出所有权限相关的类和工具
 */

export { PermissionManager } from './PermissionManager.js';
export { applyDefaultToolPermissions } from './defaultPermissions.js';
export type {
  ApprovalRequest,
  ApprovalResult,
  ApprovalHandler,
  PermissionManagerConfig,
} from './PermissionManager.js';
