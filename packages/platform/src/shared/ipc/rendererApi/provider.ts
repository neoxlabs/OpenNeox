type AgentSettings = import('../../ipc.js').AgentSettings;
type CreateProviderInput = import('../../ipc.js').CreateProviderInput;
type FetchProviderModelsRequest = import('../../ipc.js').FetchProviderModelsRequest;
type FetchProviderModelsResult = import('../../ipc.js').FetchProviderModelsResult;
type HealthCheckRequest = import('../../ipc.js').HealthCheckRequest;
type HealthCheckResult = import('../../ipc.js').HealthCheckResult;
type JavaDebugStatus = import('../../ipc.js').JavaDebugStatus;
type ModelConfig = import('../../ipc.js').ModelConfig;
type ModelInfo = import('../../ipc.js').ModelInfo;
type ModelRouteConfig = import('../../ipc.js').ModelRouteConfig;
type ModelRoutingConfig = import('../../ipc.js').ModelRoutingConfig;
type OrchestratorConfig = import('../../ipc.js').OrchestratorConfig;
type ProviderConfig = import('../../ipc.js').ProviderConfig;
type ProviderHealth = import('../../ipc.js').ProviderHealth;
type ProviderUsageStats = import('../../ipc.js').ProviderUsageStats;
type TokenUsageRecord = import('../../ipc.js').TokenUsageRecord;
type UpdateProviderInput = import('../../ipc.js').UpdateProviderInput;
type UsageSummary = import('../../ipc.js').UsageSummary;
type UserLanguage = import('../../ipc.js').UserLanguage;

export interface RendererAPIProvider {
  getProviders: () => Promise<ProviderConfig[]>;
  getProvider: (id: string) => Promise<ProviderConfig | null>;
  getDefaultProvider: () => Promise<ProviderConfig | null>;
  onProvidersChanged?: (
    handler: (payload: {
      source: 'fs-watch' | 'user-switch';
      path: string;
      exists: boolean;
      mtimeMs: number;
    }) => void
  ) => () => void;
  addProvider: (input: CreateProviderInput) => Promise<ProviderConfig>;
  updateProvider: (id: string, updates: UpdateProviderInput) => Promise<ProviderConfig>;
  deleteProvider: (id: string) => Promise<void>;
  setDefaultProvider: (id: string) => Promise<ProviderConfig>;
  fetchProviderModels: (request: FetchProviderModelsRequest) => Promise<FetchProviderModelsResult>;
  addModel: (providerId: string, modelName: string, makeDefault?: boolean) => Promise<ProviderConfig>;
  removeModel: (providerId: string, modelName: string) => Promise<ProviderConfig>;
  setSelectedModel: (providerId: string, modelName: string) => Promise<ProviderConfig>;
  getAvailableModels: () => Promise<ModelInfo[]>;
  getSandboxStatus: (sessionId: string) => Promise<boolean>;
  setSandboxStatus: (sessionId: string, enabled: boolean, modelId: string) => Promise<void>;
  getApprovalMode: (sessionId: string) => Promise<'auto' | 'manual' | 'dangerous'>;
  getStatus: () => Promise<{
    status: string;
    uptime: number;
    pid: number;
    workDir: string;
    activeSessions: string[];
    mode: string;
  }>;
  setApprovalMode: (
    sessionId: string,
    mode: 'auto' | 'manual' | 'dangerous',
    modelId: string,
    options?: {
      scope?: 'global' | 'agent';
      scopeKey?: string;
      inherit?: boolean;
      dangerousConfirmation?: {
        acknowledgeNoApproval: true;
        acknowledgeHighRiskExecution: true;
      };
    }
  ) => Promise<void>;
  replyPermission: (requestId: string, approved: boolean, remember?: boolean) => Promise<void>;
  cancelPermission: (
    requestId: string,
    reason?: 'resolved' | 'timeout' | 'manual_cancel' | 'session_aborted' | 'stale',
  ) => Promise<void>;
  /** 返回值: { status, reason? } — UI 据此区分:
   *   resolved/resumed → 卡片翻 ✓ 已回答; orphan → 显示"会话已断开"+ "改作消息重发" 入口. */
  replyAskUser: (
    requestId: string,
    answers: Record<string, string>,
  ) => Promise<{ status: 'resolved' | 'resumed' | 'orphan'; reason?: string }>;
  getLanguagePreference: () => Promise<UserLanguage>;
  setLanguagePreference: (language: UserLanguage) => Promise<void>;
  getPiiFilterPreference: () => Promise<boolean>;
  setPiiFilterPreference: (enabled: boolean) => Promise<void>;
  /** agent 浏览器: 带上日常 Chrome 登录态  */
  getBrowserUseConfig: () => Promise<{ reuseDailyLogins: boolean; dailyLoginsDecided: boolean; dailyProfileDir?: string; dailyProfileName?: string }>;
  /** First agent-browser launch asks whether to reuse everyday Chrome sign-ins (main → renderer). */
  onDailyLoginsAsk: (cb: (payload: { id: number }) => void) => () => void;
  dailyLoginsAck: (id: number) => void;
  dailyLoginsAnswer: (id: number, allow: boolean) => void;
  setBrowserUseConfig: (patch: { reuseDailyLogins?: boolean; dailyProfileDir?: string | null; dailyProfileName?: string | null }) => Promise<void>;
  /** 立即把日常 Chrome 的 Cookies 同步进 agent 浏览器 (会先关掉 agent Chrome, 下次自动重启) */
  syncDailyLogins: () => Promise<{ ok: boolean; copied?: boolean; bytes?: number; source?: string; error?: string; note?: string }>;
  /* GitHub channel (PR 评论当指令,) */
  getGithubChannelConfig: () => Promise<import('../../../channels/types.js').GithubChannelConfig>;
  setGithubChannelConfig: (patch: Partial<import('../../../channels/types.js').GithubChannelConfig>) => Promise<import('../../../channels/types.js').GithubChannelConfig>;
  getGithubChannelStatus: () => Promise<{ login?: string; lastPollAt?: string; lastError?: string | null; recent?: Array<{ at: string; repo: string; number: number; user: string; status: string; note?: string }> }>;
  /** 本机有没有 GitHub token (gh auth / GITHUB_TOKEN) —— 设置页据此提示 */
  getGithubTokenInfo: () => Promise<{ ok: boolean; login?: string; source?: string; error?: string }>;
  getCliDebugPreference: () => Promise<boolean>;
  setCliDebugPreference: (enabled: boolean) => Promise<void>;
  getReasoningEffort: () => Promise<string>;
  setReasoningEffort: (effort: string) => Promise<void>;
  getModelConfig: () => Promise<ModelConfig>;
  setModelConfig: (config: Partial<ModelConfig>) => Promise<void>;
  getEnabledTools: () => Promise<Record<string, boolean>>;
  setEnabledTools: (enabledTools: Record<string, boolean>) => Promise<void>;
  getAgentSettings: () => Promise<AgentSettings>;
  setAgentSettings: (settings: Partial<AgentSettings>) => Promise<void>;
  getRunMode?: () => Promise<'agentic'>;
  setRunMode?: (mode: 'agentic') => Promise<void>;
  getOrchestratorConfig: () => Promise<OrchestratorConfig>;
  setOrchestratorConfig: (config: Partial<OrchestratorConfig>) => Promise<void>;
  getOrchestratorEnabled: () => Promise<boolean>;
  setOrchestratorEnabled: (enabled: boolean) => Promise<void>;
  getJavaDebugStatus: () => Promise<JavaDebugStatus>;
  downloadJavaDebugJar: () => Promise<{ success: boolean; error?: string }>;
  getUsageSummary: () => Promise<UsageSummary>;
  /** 按天聚合的本地用量 (趋势图) — 聚合在 SQL 侧完成, 最多返回 days 行 */
  getDailyUsage: (days?: number) => Promise<Array<{
    day: string; requests: number; inputTokens: number; outputTokens: number; totalTokens: number;
  }>>;
  getProviderUsageStats: () => Promise<ProviderUsageStats[]>;
  getProviderUsageRecords: (provider: string, limit?: number) => Promise<TokenUsageRecord[]>;
  getRecentUsageRecords: (limit?: number) => Promise<TokenUsageRecord[]>;
  clearUsageStats: () => Promise<void>;
  clearProviderUsageStats: (provider: string) => Promise<void>;
  checkProviderHealth: (request: HealthCheckRequest) => Promise<HealthCheckResult>;
  /* 图片模式直连 IPC (bypass LLM, 用于 "创建图片" chip / 图片 surface).
   * 详见 apps/desktop/src/ui/electron/ipc/imageDirectHandlers.ts. */
  imageDirectGenerate?: (request: {
    prompt: string; model?: string; n?: number; size?: string; quality?: string; optimizePrompt?: boolean;
  }) => Promise<{
    ok: boolean; paths?: string[]; fileUrls?: string[]; count?: number;
    mode?: string; providerLabel?: string; latencyMs?: number; revisedPrompt?: string; error?: string;
  }>;
  imageDirectEdit?: (request: {
    prompt: string; source: string; mask?: string; model?: string; n?: number; size?: string;
  }) => Promise<{
    ok: boolean; paths?: string[]; fileUrls?: string[]; count?: number;
    mode?: string; providerLabel?: string; latencyMs?: number; error?: string;
  }>;
  /** 对话测试: 真发一句话拿回复 (主进程走 core runProviderChatProbe) */
  providerChatProbe: (req: {
    providerId?: string; protocol?: string; baseUrl?: string; urlSuffix?: string; apiKey?: string;
    model: string; prompt?: string; claudeCodeMode?: 'auto' | 'on' | 'off';
  }) => Promise<{
    ok: boolean; reply?: string; reasoning?: string; latencyMs: number;
    inputTokens?: number; outputTokens?: number; error?: string; httpStatus?: number;
  }>;
  /** BYOK 余额 (DeepSeek / Kimi / OpenRouter / 硅基流动); 其它家 unsupported —— 主进程 services/providerBalance.ts */
  providerBalance: (providerId: string) => Promise<
    | { status: 'ok'; amount: number; currency: 'CNY' | 'USD'; kind?: 'balance' | 'used' }
    | { status: 'unsupported' }
    | { status: 'error'; error: string }
  >;
  getHealthCheckInterval: () => Promise<number>;
  setHealthCheckInterval: (minutes: number) => Promise<void>;
  getAutoHealthCheck: () => Promise<boolean>;
  setAutoHealthCheck: (enabled: boolean) => Promise<void>;
  getHealthData: () => Promise<Record<string, ProviderHealth>>;
  updateHealthData: (providerId: string, status: string, latency?: number, error?: string, httpStatus?: number, model?: string) => Promise<ProviderHealth>;
  setAllHealthData: (data: Record<string, ProviderHealth>) => Promise<void>;
  deleteHealthData: (providerId: string) => Promise<void>;
  clearAllHealthData: () => Promise<void>;
  getModelRoutingEnabled: () => Promise<boolean>;
  setModelRoutingEnabled: (enabled: boolean) => Promise<void>;
  getModelRoutingConfig: () => Promise<ModelRoutingConfig>;
  getModelRoutes: () => Promise<Record<string, ModelRouteConfig>>;
  getModelRoute: (modelAlias: string) => Promise<ModelRouteConfig | null>;
  setModelRoute: (modelAlias: string, route: ModelRouteConfig) => Promise<void>;
  deleteModelRoute: (modelAlias: string) => Promise<boolean>;
  autoDetectModelRoutes: (modelName: string) => Promise<ModelRouteConfig | null>;
  getAutoRoutedModels: () => Promise<ModelInfo[]>;
}
