
import type { ProviderConfigEntry } from '@neoxlabs/kernel/types/configTypes.js';
import { hasCapability, providerDeclaresModel } from '@neoxlabs/kernel/models/providerCapabilities.js';

export type ImageTier = 'standard' | 'advanced';

/** 已知的"全参数聚合商" —— 只在没有显式声明时用来兜底判定。加新的改这里。 */
const ADVANCED_HOST_HINTS = [/openrouter\.ai/i];

/** 这个 provider 属于哪个档位。显式声明优先, 否则按 baseUrl 主机名兜底判定。 */
export function tierOfProvider(p: ProviderConfigEntry): ImageTier {
  const declared = (p as { imageTier?: string }).imageTier;
  if (declared === 'standard' || declared === 'advanced') return declared;
  const url = `${p.baseUrl ?? ''} ${(p.channels ?? []).map((c) => c.baseUrl ?? '').join(' ')}`;
  return ADVANCED_HOST_HINTS.some((re) => re.test(url)) ? 'advanced' : 'standard';
}

export interface TierCandidate {
  provider: ProviderConfigEntry;
  tier: ImageTier;
  /** 是否显式声明了请求的模型 —— 排序时优先 */
  declaresModel: boolean;
}

/**
 * 按档位挑候选渠道, **返回一个有序列表而不是单个** —— 调用方要能逐个 failover。
 *
 * 排序: 显式声明该模型的排前面 (同档内), 其余按原顺序。
 * 只返回**本档**的渠道: 跨档回落由调用方显式决定, 这里不替它做主。
 */
export function candidatesForTier(
  providers: Iterable<ProviderConfigEntry>,
  tier: ImageTier,
  modality: 'image' | 'image-edit',
  model?: string,
): TierCandidate[] {
  const out: TierCandidate[] = [];
  for (const p of providers) {
    if (!hasCapability(p, modality) && !hasCapability(p, 'image')) continue;
    if (tierOfProvider(p) !== tier) continue;
    out.push({ provider: p, tier, declaresModel: !!model && providerDeclaresModel(p, model) });
  }
  out.sort((a, b) => Number(b.declaresModel) - Number(a.declaresModel));
  return out;
}

/** 普通档全灭时给用户看的话 —— 不提任何渠道名。 */
export function busyMessage(isZh: boolean): string {
  return isZh
    ? '当前出图服务繁忙, 请稍后再试 (或切换到「高级」档)。'
    : 'Image service is busy right now — please retry shortly (or switch to Advanced).';
}
