
import {
  resolveSubAgentModelSelection,
  type ExploreProviderInfo,
  type ClaudeModelSelection,
} from '../runtime/agent/exploreModelPolicy.js';

/** 订阅哨兵 provider —— 三处各自定义过, 这里只做判断不做导出常量的活 */
const NEOX_CLOUD_PROVIDER_ID = 'neox-cloud';
const NEOX_MANAGED_KEY = 'neox-managed';

export type ModelSourceKind = 'subscription' | 'byok';

export interface ResearchModelInput {
  /** 当前会话跑在哪 */
  sessionProviderId: string;
  sessionModelName: string;
  /** 当前 provider 的模型清单 (订阅哨兵的 models[] 是空的, 这本身就是判据之一) */
  provider?: ExploreProviderInfo | null;
  /** 当前 provider 的 apiKey —— 只用来判订阅, 不外传 */
  providerApiKey?: string;
  /** 用户显式指定的 worker 模型 (设置页 / 提示词里说的)。给了就一切照它。 */
  overrideWorkerProviderId?: string;
  overrideWorkerModelName?: string;
  /**
   * BYOK 下是否也自动降级 worker。默认 false —— 用户自己付钱, 不替他做主。
   * 订阅下这个参数被忽略 (恒为 true)。
   */
  byokAutoDowngrade?: boolean;
}

export interface ResearchModelRoute {
  providerId: string;
  modelName: string;
}

export interface ResearchModelPlan {
  leader: ResearchModelRoute;
  worker: ResearchModelRoute;
  kind: ModelSourceKind;
  /** 走了哪条路 —— 'configured' 用户指定 / 'session' 同主模型 / 'low-profile' 被用户设置一票否决 / auto-* 自动降级 */
  source: ClaudeModelSelection['source'];
  /** 人话解释, 直接可以进日志和界面 */
  reason: string;
}

/**
 * 判订阅还是 BYOK。
 *
 * 三条判据任一命中即订阅 —— 仓库里 neoxConfigTool / providerResolver / providerHealthCheck
 * 用的都是前两条, 第三条 (models[] 为空) 是行为判据, 云端哨兵 provider 不枚举模型。
 */
export function isSubscriptionProvider(
  providerId: string,
  apiKey?: string,
  provider?: ExploreProviderInfo | null,
): boolean {
  if (providerId === NEOX_CLOUD_PROVIDER_ID) return true;
  if (apiKey === NEOX_MANAGED_KEY) return true;
  /* 有 provider 对象但模型清单是空的 = 云端哨兵 */
  if (provider && Array.isArray(provider.models) && provider.models.length === 0) return true;
  return false;
}

/**
 * 算出这一轮调研的 leader 和 worker 分别用什么模型。
 *
 * leader **永远是当前会话模型** —— 用户选了什么就是什么, 调研不该偷偷换掉他的主模型。
 * 变的只有 worker。
 */
export function resolveResearchModels(input: ResearchModelInput): ResearchModelPlan {
  const kind: ModelSourceKind = isSubscriptionProvider(input.sessionProviderId, input.providerApiKey, input.provider)
    ? 'subscription'
    : 'byok';

  const leader: ResearchModelRoute = {
    providerId: input.sessionProviderId,
    modelName: input.sessionModelName,
  };

  /* 订阅: 自动降级开着 (我们管控, 按 family 派生 fast 变种)
   * BYOK: 默认关 —— 用户没说就全用当前模型; 他自己开了或指定了才动 */
  const enabled = kind === 'subscription' ? true : (input.byokAutoDowngrade === true);

  const sel = resolveSubAgentModelSelection({
    providerId: leader.providerId,
    modelName: leader.modelName,
    provider: input.provider ?? undefined,
    configuredProviderId: input.overrideWorkerProviderId,
    configuredModelName: input.overrideWorkerModelName,
    enabled,
  });

  return {
    leader,
    worker: { providerId: sel.providerId, modelName: sel.modelName },
    kind,
    source: sel.source,
    reason: sel.reason,
  };
}

/** 界面/日志上的一行说明 */
export function describeModelPlan(plan: ResearchModelPlan): string {
  const same = plan.leader.providerId === plan.worker.providerId && plan.leader.modelName === plan.worker.modelName;
  const who = plan.kind === 'subscription' ? '订阅' : 'BYOK';
  return same
    ? `${who} · leader 和 worker 都用 ${plan.leader.modelName} (${plan.source})`
    : `${who} · leader ${plan.leader.modelName} / worker ${plan.worker.modelName} (${plan.source})`;
}
