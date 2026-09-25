/**
 * Resolve the approval posture for one tool batch.
 *
 * The function is pure: it maps session scope and runner strategy to two
 * explicit booleans used by orchestration.
 */

import type { ApprovalMode } from '../types/configTypes.js';

export interface ApprovalPosture {
  /** 本批工具是否走无人值守 (不逐条问用户)。 */
  autoApprove: boolean;
  /** 是否挂 critical-only 硬闸 (它排在 permission 之前, 命中即拒 + 终止本轮)。 */
  attachUnattendedRiskGate: boolean;
}

export interface ApprovalPostureInput {
  /** 本会话生效的审批档 (PermissionManager.getScopeMode)。undefined = 拿不到会话上下文。 */
  scopeMode: ApprovalMode | undefined;
  /** runner 自身 modeStrategy 的判断 (全局 agentMode 推出来的)。 */
  strategyAutoApprove: boolean;
}

/**
 * Session scope takes precedence over the runner strategy. The unattended risk
 * gate is attached only when no session scope is present.
 *
 * A scoped manual or dangerous mode remains visible to that session only.
 * The unattended risk gate applies when the runner has no session scope, while
 * scoped interactive sessions leave critical decisions to PermissionManager.
 */
export function resolveApprovalPosture(input: ApprovalPostureInput): ApprovalPosture {
  const { scopeMode, strategyAutoApprove } = input;
  const autoApprove = scopeMode === 'dangerous'
    ? true
    : scopeMode === 'manual'
      ? false
      : strategyAutoApprove;
  return {
    autoApprove,
    attachUnattendedRiskGate: autoApprove && scopeMode === undefined,
  };
}
