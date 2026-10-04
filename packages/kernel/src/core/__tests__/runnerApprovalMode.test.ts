/**
 * 审批姿态判定闸覆盖会话档位优先级和 critical-only 兼容分支。
 *
 *   · per-session 档覆盖全局 agentMode，避免会话之间共享审批状态。
 *   · critical-only 硬闸只在缺少 scopeMode 时生效，保留 auto 档 critical 操作的批准路径。
 */
import { describe, it, expect } from 'vitest';
import { resolveApprovalPosture } from '../runnerApprovalModeUtils.js';

describe('resolveApprovalPosture', () => {
  it('dangerous: 无人值守, 且不挂硬闸 (一条都不弹是这一档的全部意义)', () => {
    expect(resolveApprovalPosture({ scopeMode: 'dangerous', strategyAutoApprove: false }))
      .toEqual({ autoApprove: true, attachUnattendedRiskGate: false });
  });

  it('manual: 一律走审批, 即使全局 agentMode 是 AUTO', () => {
    expect(resolveApprovalPosture({ scopeMode: 'manual', strategyAutoApprove: true }))
      .toEqual({ autoApprove: false, attachUnattendedRiskGate: false });
  });

  it('auto + 全局 AUTO: 不挂硬闸 —— critical 要走审批卡, 不是直接拒', () => {
    expect(resolveApprovalPosture({ scopeMode: 'auto', strategyAutoApprove: true }))
      .toEqual({ autoApprove: true, attachUnattendedRiskGate: false });
  });

  it('拿不到 scopeMode (SDK/headless) + 无人值守: 保留 critical 硬闸', () => {
    expect(resolveApprovalPosture({ scopeMode: undefined, strategyAutoApprove: true }))
      .toEqual({ autoApprove: true, attachUnattendedRiskGate: true });
  });

  it('拿不到 scopeMode 且不自动批准: 什么闸都不挂 (逐条问)', () => {
    expect(resolveApprovalPosture({ scopeMode: undefined, strategyAutoApprove: false }))
      .toEqual({ autoApprove: false, attachUnattendedRiskGate: false });
  });
});
