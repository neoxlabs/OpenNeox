/**
 * 发行版能力钩子 —— uiSlots 的函数版。
 *
 * uiSlots 回答"页面上这个位置渲染什么组件"; 这里回答"这个判断 / 这份数据从哪来":
 * 登录态、会员信息、订阅模型、额度事件、带凭据的云端请求……
 *
 * 共享代码只认这张表里的契约, 从不 import 账号 / 计费目录。没有人注册时, 每一项都是
 * 无账号体系下的答案 (未登录、无会员、无订阅模型、云端能力关), 于是公开构建里那些分支
 * 自然不走, 也不需要在共享组件里写 if (edition) 之类的判断。
 *
 * 带账号体系的发行版在启动最早期 (React 挂载之前, 见 editionSlots.ts 的 bootEdition)
 * 一次性注册全部实现, 之后不再改 —— React hook 类的条目 (useAuth / useMembership …)
 * 因此在整个生命周期里是同一个函数, hook 调用顺序稳定。
 *
 * @see uiSlots.tsx      组件插槽
 * @see editionSlots.ts  发行版唯一的注册入口
 */
import type { ModelInfo, UsageSummary, ProviderUsageStats } from '../../../shared/ipc';
import type { DockPill } from '../agent-timeline/dock/dockTypes';

/** 当前登录用户 —— 共享代码只用得到 id (切账户判定)。 */
export interface EditionUser {
  readonly id: string;
}

export interface EditionAuthState {
  user: EditionUser | null;
  isAuthenticated: boolean;
}

/** 会员信息里共享代码读得到的那几格。其余字段只在发行版自己的组件里用。 */
export interface EditionMembership {
  plan?: { id?: string } | null;
  /** 套餐里的云端模型 (设置页的模型下拉会列出来)。 */
  models?: ReadonlyArray<{ modelId: string; displayName?: string | null; allowed: boolean }>;
  /** 活动金 (只能用于限时活动模型) —— 模型菜单「限时活动」一行显示余额与过期 */
  promoCredit?: { balanceMicros: number; expiresAt: string | null } | null;
}

export interface EditionMembershipStatus {
  /** 正在拉 (inflight)。 */
  loading: boolean;
  stale: boolean;
  /** 最后一次失败的简短描述; null = 当前健康。 */
  lastError: string | null;
}

/** 模型权益视图 —— 由发行版按会员套餐给云端模型打上的标签。 */
export type ModelEntitlement = {
  /** plan 是否允许调用 — false = 模型选择器灰显 + 不可选 */
  allowed: boolean;
  /** 是否包含在套餐里 — false = 按量计费 */
  included: boolean;
  /** 当前套餐生效的额度倍率, 仅用于解释额度消耗. */
  multiplier: number;
  /** 促销前的基础倍率; 只有促销中有值. */
  baseMultiplier?: number | null;
  /** 当前生效的限时活动. */
  promo?: { label: string; endsAt: string } | null;
  /** 服务端的好读名字 (models.display_name), 如「DeepSeek V4.1 Flash」—— 模型列表显示它而不是 id */
  displayName?: string | null;
  /** 版本说明 (服务端 models.metadata.version_*), 如「官方 1017 版」—— 上游原地升级时只改它, 不新增模型 */
  versionLabel?: string | null;
  versionNote?: string | null;
  /** 额度烧速 (基准模型 = 1.0, 已含倍率), 消耗条用。null = 没给 → 不渲染 */
  relativeCost?: number | null;
  /** 服务端权威能力位。null = 无可核验数据 → 不展示该项 */
  caps?: { vision: boolean | null; reasoning: boolean | null; audioInput: boolean | null; videoInput: boolean | null } | null;
};

/** ModelInfo 加上权益视图 — 不破坏原结构, 只追加一个可选字段。 */
export type EntitledModelInfo = ModelInfo & {
  entitlement?: ModelEntitlement;
};

/** 对话流里一条已分类错误 —— 交给发行版判断要不要自愈 / 弹额度窗。 */
export interface ClassifiedStreamError {
  /** 错误信封里的 code (有信封时) */
  envelopeCode?: string;
  envelopeMessage?: string;
  /** 事件本身的 code / message */
  eventCode?: string;
  eventMessage?: string;
}

/** 时间线错误卡「提交反馈」的载荷。 */
export type TimelineErrorFeedbackPayload = {
  schemaVersion: 1;
  source: 'desktop.timeline.error';
  severity: 'error' | 'warning';
  privacyMode: 'minimal';
  userNote?: string;
  error: {
    code?: string;
    message: string;
    suggestion?: string;
    /** 网关 request id */
    requestId?: string;
  };
  context: {
    selectedModelId?: string;
    appVersion?: string;
    appEnvironment?: string;
    platform?: string;
    arch?: string;
    occurredAt: string;
  };
};

/**
 * 按量模型 (平台余额) —— 订阅套餐之外、从平台余额按官方价扣的云端模型。
 * 模型菜单里单独一组: 开关默认关, 关着时只显示一行灰色入口; 打开后才列出模型、才能选。
 */
export interface EditionPlatformModels {
  /** 这个发行版 / 账号有没有按量模型这回事; false = 菜单里整组不出现 */
  supported: boolean;
  /** 用户在菜单里打开了按量模型 (本机偏好, 默认关) */
  enabled: boolean;
  setEnabled(enabled: boolean): void;
  /** 可用平台余额 (美元) */
  balanceUsd: number;
  /** 能不能真的调用: 余额 > 0 且开着额外用量 */
  usable: boolean;
  /** usable=false 的原因, 菜单据此给对应的出路 */
  blockedReason: 'no_balance' | 'extra_usage_off' | null;
  openTopUp(): void;
  enableExtraUsage(): Promise<void>;
}

export interface EditionHooks {
  /**
   * 这个发行版有没有账号体系。false 时共享界面里所有"登录 / 订阅 / 云端模型"入口整块不渲染
   * (不是灰着 —— 公开构建里点了也没有任何地方可去)。
   */
  hasAccount: boolean;

  /* ── 登录态 ── */
  isAuthenticated(): boolean;
  useAuth(): EditionAuthState;
  /** 首帧快路径: 只等本地 session 恢复, 网络复验在后台跑。 */
  bootstrapAuthLocal(): Promise<unknown>;
  /** 带登录凭据请求云端接口 (path 是相对 API base 的路径)。 */
  fetchWithAuth(path: string, init?: RequestInit): Promise<Response>;

  /* ── 会员 / 订阅 ── */
  useMembership(): EditionMembership | null;
  useMembershipStatus(): EditionMembershipStatus;
  getMembershipNow(): EditionMembership | null;
  refreshMembership(): Promise<EditionMembership | null>;
  /** 订阅模型 (合成成 ModelInfo, providerId = neox-cloud)。 */
  getSubscriptionModelsNow(): ModelInfo[];
  /** 会员当前是否有一个额度窗口已经用尽。 */
  hasExhaustedUsageWindow(membership: EditionMembership | null): boolean;
  /** 给模型列表打权益标签; 没有会员信息时原样返回。 */
  decorateModelsWithEntitlement(models: ModelInfo[], membership: EditionMembership | null): EntitledModelInfo[];
  /** 打开升级 / 充值页。 */
  openUpgradeUrl(anchor?: 'topup' | 'redeem' | 'pricing' | 'extra-usage'): void;
  /** 按量模型 (平台余额) 的开关与可用状态; 模型本身随订阅模型一起经 getSubscriptionModelsNow 下发 (payAsYouGo=true)。 */
  usePlatformModels(): EditionPlatformModels;
  /** 输入框上方的额度横幅此刻是否显示 (输入框状态药丸要给它让位)。 */
  useQuotaBannerVisible(): boolean;
  /** 时间线底部停靠条里的账单药丸 (续费 / 到期提醒); null = 不显示。 */
  useBillingPill(): DockPill | null;
  /** 云端用量汇总, 已换算成本地用量页的形状。 */
  loadCloudUsage(days: number): Promise<{ summary: UsageSummary; providerStats: ProviderUsageStats[] }>;

  /* ── 云端运行 ── */
  /** 云端运行是否对当前账号开放。 */
  useCloudAgentAvailable(): boolean;
  /** 服务端全员开关: 当前是否允许新建云端会话。 */
  useCloudCreateEnabled(): boolean;
  /** 启动云端开关的轮询, 返回停止函数。 */
  startCloudFeatureFlags(): () => void;
  bindCloudSessionToWorkspace(sessionId: string, workspacePath: string): void;
  /** 云端会话 id → 工作区路径。 */
  readCloudWorkspaceMap(): Record<string, string>;

  /* ── 杂项 ── */
  /** 外壳顶层的常驻副作用 (同步托管服务商、写会员皮肤等)。在 App 组件里每次渲染调用一次。 */
  useAppShellEffects(): void;
  /** 对话流里的已分类错误 —— 发行版可以在这里做凭据自愈、额度弹窗。 */
  onClassifiedStreamError(error: ClassifiedStreamError): void;
  /** 错误卡「提交反馈」; null = 这个发行版没有反馈通道, 错误卡不出反馈按钮。 */
  submitTimelineErrorFeedback: ((payload: TimelineErrorFeedbackPayload) => Promise<{ id?: string; feedbackId?: string }>) | null;
}

const SIGNED_OUT: EditionAuthState = { user: null, isAuthenticated: false };
const NO_PLATFORM_MODELS: EditionPlatformModels = {
  supported: false,
  enabled: false,
  setEnabled: () => { /* 没有按量模型 */ },
  balanceUsd: 0,
  usable: false,
  blockedReason: null,
  openTopUp: () => { /* 没有充值页 */ },
  enableExtraUsage: async () => { /* 没有额外用量 */ },
};
const HEALTHY: EditionMembershipStatus = { loading: false, stale: false, lastError: null };
const unavailable = (): Promise<never> => Promise.reject(new Error('This build has no account service.'));

/** 无账号体系下的答案。 */
const LOCAL_ONLY: EditionHooks = {
  hasAccount: false,
  isAuthenticated: () => false,
  useAuth: () => SIGNED_OUT,
  bootstrapAuthLocal: async () => null,
  fetchWithAuth: unavailable,
  useMembership: () => null,
  useMembershipStatus: () => HEALTHY,
  getMembershipNow: () => null,
  refreshMembership: async () => null,
  getSubscriptionModelsNow: () => [],
  hasExhaustedUsageWindow: () => false,
  decorateModelsWithEntitlement: (models) => models,
  openUpgradeUrl: () => { /* 没有升级页 */ },
  usePlatformModels: () => NO_PLATFORM_MODELS,
  useQuotaBannerVisible: () => false,
  useBillingPill: () => null,
  loadCloudUsage: unavailable,
  useCloudAgentAvailable: () => false,
  useCloudCreateEnabled: () => false,
  startCloudFeatureFlags: () => () => { /* 没有轮询可停 */ },
  bindCloudSessionToWorkspace: () => { /* 没有云端会话 */ },
  readCloudWorkspaceMap: () => ({}),
  useAppShellEffects: () => { /* 没有常驻副作用 */ },
  onClassifiedStreamError: () => { /* 常规错误卡已经够了 */ },
  submitTimelineErrorFeedback: null,
};

let active: EditionHooks = LOCAL_ONLY;

/**
 * 注册发行版实现。只在启动最早期调一次 (见 editionSlots.ts 的 bootEdition);
 * 没给的条目保持无账号体系下的答案。
 */
export function registerEditionHooks(impl: Partial<EditionHooks>): void {
  active = { ...LOCAL_ONLY, ...impl };
}

/** 取一项发行版实现。 */
export function getEditionHook<K extends keyof EditionHooks>(name: K): EditionHooks[K] {
  return active[name];
}

/* ── React hook 形态的薄封装: 让调用点读起来就是普通 hook, 也让 rules-of-hooks 扫描认得出 ── */

export function useEditionAuth(): EditionAuthState {
  return active.useAuth();
}

export function useEditionMembership(): EditionMembership | null {
  return active.useMembership();
}

export function useEditionMembershipStatus(): EditionMembershipStatus {
  return active.useMembershipStatus();
}

export function useCloudAgentAvailable(): boolean {
  return active.useCloudAgentAvailable();
}

export function useEditionPlatformModels(): EditionPlatformModels {
  return active.usePlatformModels();
}

export function useEditionBillingPill(): DockPill | null {
  return active.useBillingPill();
}

export function useQuotaBannerVisible(): boolean {
  return active.useQuotaBannerVisible();
}

export function useCloudCreateEnabled(): boolean {
  return active.useCloudCreateEnabled();
}

export function useEditionAppShellEffects(): void {
  active.useAppShellEffects();
}
