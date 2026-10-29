
/** 0 = Free · 1 = Pro · 2 = Max(pro-plus) / Teams · 3 = Ultra / Enterprise */
export type PlanTier = 0 | 1 | 2 | 3;

/**
 * planId → 档位。**全应用唯一的档位推导**。
 *
 *   在这之前同一套 if-else 在 QuotaBadge.planSkinFor 和 AppShell 的
 *   data-plan-skin effect 里各抄了一份, 改一处另一处不会跟着动。
 *   新增档位 / 改 plan id 只改这里。
 *
 *   入参是**服务端下发的原始 plan id 字符串** (客户端一直把 plan 当 opaque string,
 *   没有本地枚举), 所以这里只能按子串判定, 顺序不能乱: 'pro-plus' 必须在 'pro' 之前。
 */
export function planTierOf(planId: string | null | undefined): PlanTier {
  const k = (planId ?? '').toLowerCase().replace(/_/g, '-');
  if (!k) return 0;
  if (k.includes('enterprise') || k.includes('vip')) return 3;
  if (k.includes('ultra')) return 3;
  if (k.includes('team') || k.includes('elite')) return 2;
  if (k.includes('plus')) return 2;          /* pro-plus = Max */
  if (k.includes('pro')) return 1;
  return 0;
}

/** 档位的展示名 — 账户页 / 用量角标用。 */
export const TIER_LABEL: Record<PlanTier, { zh: string; en: string }> = {
  0: { zh: 'Free', en: 'Free' },
  1: { zh: 'Pro', en: 'Pro' },
  2: { zh: 'Max', en: 'Max' },
  3: { zh: 'Ultra', en: 'Ultra' },
};
