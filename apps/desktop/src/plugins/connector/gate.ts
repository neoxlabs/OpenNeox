
import {
  SIDE_EFFECT_POLICY,
  type CapabilityId,
  type LocalizedText,
  type PluginConnectorDefinition,
  type SideEffect,
} from '@neoxlabs/platform/shared/plugin-connector.js';
import type { BudgetStore, GrantStore } from './grantStore.js';

export type GateDenial =
  | 'capability_not_declared'  // 清单里没这条 —— 插件在越权
  | 'capability_not_granted'   // 用户没授予
  | 'confirmation_required'    // 需要用户点确认
  | 'budget_exceeded';         // costly 能力超预算

export type GateDecision =
  | { allow: true; effect: SideEffect }
  | {
      allow: false;
      code: GateDenial;
      /** 给用户看的话。confirmation_required 时就是确认框文案。 */
      message: LocalizedText;
      /** 用户能否选「不再询问」—— destructive / costly 恒为 false */
      rememberable?: boolean;
      /** 预计花费 (USD), 仅 costly */
      estimatedUsd?: number;
    };

export type GateContext = {
  installationId: string;
  grants: GrantStore;
  budgets?: BudgetStore;
  confirmed?: boolean;
  /** 用户在确认框里勾了「不再询问」 */
  rememberChoice?: boolean;
};

export function evaluateGate(
  connector: PluginConnectorDefinition,
  pluginName: string,
  capability: CapabilityId,
  ctx: GateContext,
): GateDecision {
  // ── 1. 声明过吗 (纵深防御, 见文件头) ──────────────────────────────────
  const permission = connector.permissions.find(p => p.capability === capability);
  if (!permission) {
    return {
      allow: false,
      code: 'capability_not_declared',
      message: {
        en: `"${pluginName}" tried to use "${capability}", which it never declared.`,
        zh: `「${pluginName}」试图使用未声明的能力「${capability}」。`,
      },
    };
  }

  // ── 2. 用户授予了吗 ───────────────────────────────────────────────────
  if (!ctx.grants.isGranted(ctx.installationId, capability)) {
    return {
      allow: false,
      code: 'capability_not_granted',
      message: {
        en: `You have not granted "${capability}" to ${pluginName}.`,
        zh: `你尚未授予「${pluginName}」这项能力：${capability}。`,
      },
    };
  }

  const policy = SIDE_EFFECT_POLICY[permission.effect];

  // ── 3. 预算 (costly) ─────────────────────────────────────────────────
  let estimatedUsd: number | undefined;
  if (policy.budgeted) {
    /* 校验器保证 costly 必须带 cost, 这里兜底取 0 只为类型收敛 */
    estimatedUsd = permission.cost?.approxUsd ?? 0;
    const remaining = ctx.budgets?.remainingUsd(ctx.installationId) ?? Infinity;
    if (estimatedUsd > remaining) {
      return {
        allow: false,
        code: 'budget_exceeded',
        message: {
          en: `This action costs about $${estimatedUsd.toFixed(2)} but only $${remaining.toFixed(2)} is left in this budget.`,
          zh: `这个操作约需 $${estimatedUsd.toFixed(2)}，但当前预算只剩 $${remaining.toFixed(2)}。`,
        },
        estimatedUsd,
      };
    }
  }

  // ── 4. 要不要确认 ────────────────────────────────────────────────────
  const needsConfirm =
    policy.confirm === 'always' ||
    (policy.confirm === 'first-time' && !ctx.grants.isRemembered(ctx.installationId, capability));

  if (needsConfirm && !ctx.confirmed) {
    return {
      allow: false,
      code: 'confirmation_required',
      /* 展示的是清单里那句人话理由, 不是 capability 字符串 */
      message: permission.reason,
      rememberable: policy.rememberable,
      estimatedUsd,
    };
  }

  /* 只有 rememberable 的等级才允许记住 —— destructive / costly 永远每次问 */
  if (ctx.confirmed && ctx.rememberChoice && policy.rememberable) {
    ctx.grants.remember(ctx.installationId, capability);
  }

  if (policy.budgeted && estimatedUsd) {
    ctx.budgets?.charge(ctx.installationId, estimatedUsd);
  }

  return { allow: true, effect: permission.effect };
}
