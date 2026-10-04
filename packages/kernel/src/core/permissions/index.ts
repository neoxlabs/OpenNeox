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
  ApprovalProvenanceInfo,
} from './PermissionManager.js';

/* 来源分级 (../trust) 是审批闸的第二条轴, 从这扇门出去 —— 深引基线是棘轮, 不为新目录开新口。 */
export {
  resolveProvenance,
  resolveProvenanceRef,
  resolveSideEffect,
  shellSideEffect,
  scanForInjection,
  wrapExternalContent,
  EXTERNAL_CONTENT_TAG,
} from '../trust/provenance.js';
export type {
  ToolProvenance,
  ToolSideEffect,
  ToolProvenanceSpec,
  ToolSideEffectSpec,
} from '../trust/provenance.js';
export { SessionTaint, displayRef } from '../trust/sessionTaint.js';
export type { TaintSnapshot, ExternalSource } from '../trust/sessionTaint.js';
