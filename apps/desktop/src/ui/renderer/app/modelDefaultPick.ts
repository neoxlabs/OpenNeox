
import type { ModelInfo } from '../../shared/ipc';
import { isNeoxCloudProviderId } from '../../shared/neoxCloud';
import { isChatModelInfo } from '../utils/modelKind';

/** 是不是 Neox Cloud 托管模型 (订阅组 + 按量组) —— 结构性入参, 传 ModelInfo 或裸 {providerId} 都行。
 *  调用方拿它区分"云端 vs BYOK": 按量模型也走网关, 不能被当成 BYOK 兜底挑上 */
export function isSubscriptionModel(m: { providerId?: string } | null | undefined): boolean {
  return !!m && isNeoxCloudProviderId(m.providerId);
}

/**
 * 订阅侧的自动路由入口。
 *
 *   服务端 catalog 里 auto 入口的 modelId 不是裸 'auto' —— free 档是 'or-free-auto',
 *   付费档是 'or-pro-auto' 之类带档位前缀的 id, 所以这里按"含 auto"放宽匹配
 *   (老逻辑只认 name === 'auto', 永远匹配不上, 于是"默认订阅 auto"退化成默认 BYOK)。
 */
export function isSubscriptionAutoModel(m: ModelInfo): boolean {
  return isSubscriptionModel(m) && /auto/i.test(String(m.name ?? ''));
}

/**
 * 低延迟档 —— 型号名里带 flash / mini / lite / haiku / nano 的对话模型。
 *
 * 「Fast」不是一个 effort / 思考档位, 而是选哪个 model id:
 * schemas/models/deepseek-v4-flash.yaml 写明 Flash / Pro 都支持 thinking 开关,
 * 想快就选 Flash 这个模型本身 (chat:C8-01)。
 */
const LOW_LATENCY_NAME_RE = /(^|[-_.:/])(flash|mini|lite|haiku|nano)([-_.:/]|$)/i;

export function isLowLatencyModel(m: { id?: string; name?: string } | null | undefined): boolean {
  if (!m || !isChatModelInfo(m)) return false;
  return LOW_LATENCY_NAME_RE.test(`${m.name ?? ''} ${m.id ?? ''}`.toLowerCase());
}

/**
 * 聊天模式的兜底模型 —— 先低延迟档, 再退回通用兜底。
 *
 * 只在「用户从没选过模型」时用 (lastModelId 落空): 聊天要的是打开就能问,
 * 所以不必先去试自动路由 (它落到哪个上游 / 多慢都由服务端定)。
 * 用户自己选过的模型 —— 包括高质量档 (pro / opus) —— 一律不在这里被动。
 */
export function pickChatFallbackModel(models: ModelInfo[]): ModelInfo | null {
  const candidates = models.filter((m) => !m.payAsYouGo && isChatModelInfo(m));
  return candidates.find((m) => isSubscriptionModel(m) && !m.isAutoRouted && isLowLatencyModel(m))
    ?? candidates.find((m) => !m.isAutoRouted && isLowLatencyModel(m))
    ?? pickFallbackModel(models);
}

/**
 * 兜底优先级 (启动 merge 与订阅段刷新两条路共用):
 *   订阅 auto → 任意订阅 → BYOK 直连 (非自动路由) → 列表首项 → 空列表返 null。
 *
 * 未登录 / 纯 BYOK (订阅段为空) 时自然落到 BYOK 直连, 行为跟以前一致。
 */
export function pickFallbackModel(models: ModelInfo[]): ModelInfo | null {
  const candidates = models.filter((m) => !m.payAsYouGo && isChatModelInfo(m));
  return candidates.find(isSubscriptionAutoModel)
    ?? candidates.find(isSubscriptionModel)
    ?? candidates.find((m) => !isSubscriptionModel(m) && !m.isAutoRouted)
    ?? candidates[0]
    ?? null;
}

export function shouldReconsiderAutoPick(args: {
  current: { providerId?: string } | null | undefined;
  autoPicked: boolean;
  subscriptionCount: number;
}): boolean {
  const { current, autoPicked, subscriptionCount } = args;
  if (!autoPicked || !current) return false;
  if (isSubscriptionModel(current)) return false;
  return subscriptionCount > 0;
}

export function pickStartupModel(
  models: ModelInfo[],
  lastModelId: string | null,
  chatMode: boolean,
): { model: ModelInfo | null; autoPicked: boolean } {
  const last = lastModelId ? models.find((m) => m.id === lastModelId && isChatModelInfo(m)) : null;
  if (last) return { model: last, autoPicked: false };
  return { model: chatMode ? pickChatFallbackModel(models) : pickFallbackModel(models), autoPicked: true };
}

/** [pickReconsideredModel] 的按模式简写 —— 订阅段迟到刷新时用。 */
export function pickReconsideredForMode(
  subscription: ModelInfo[],
  savedModelId: string | null,
  chatMode: boolean,
): ModelInfo | null {
  return pickReconsideredModel({ subscription, savedModelId, preferLowLatency: chatMode });
}

export function pickReconsideredModel(args: {
  subscription: ModelInfo[];
  savedModelId: string | null;
  /** 聊天模式: 用户没选过时优先低延迟档 (chat:C8-01) */
  preferLowLatency?: boolean;
}): ModelInfo | null {
  const subscription = args.subscription.filter(isChatModelInfo);
  const saved = args.savedModelId ? subscription.find((m) => m.id === args.savedModelId) : undefined;
  if (saved) return saved;
  if (args.preferLowLatency) {
    const fast = subscription.find((m) => !m.isAutoRouted && isLowLatencyModel(m));
    if (fast) return fast;
  }
  return subscription.find(isSubscriptionAutoModel) ?? subscription[0] ?? null;
}
