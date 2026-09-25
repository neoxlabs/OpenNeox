import {
  ProviderStore,
  type CreateProviderInput as StoreCreateProviderInput,
  type UpdateProviderInput as StoreUpdateProviderInput,
} from '../utils/providerStore.js';
import {
  getActiveConfigFile,
  loadConfig,
  saveConfig,
  type ProviderConfigEntry,
  type ProviderModelConfig,
  type UserLanguage,
  type ModelRoutingConfig,
  type ModelRouteConfig,
  type ModelProviderRoute,
  type RoutingStrategy,
  type OrchestratorConfig,
  type SupervisorConfig,
  type ModelPricingConfig,
  type AssistantConfig,
  type AgentModelRef,
  type WorkerModelEntry,
  type AgentRuntimeConfig,
} from '../utils/config.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import type { GithubChannelConfig } from '../channels/types.js';
import { wrapApiKey, unwrapApiKey } from '../utils/apiKeyCrypto.js';
import { refreshAgentRuntimeConfig } from '../runtime/agentRuntimeConfig.js';
import type {
  ProviderConfig,
  CreateProviderInput,
  UpdateProviderInput,
  ModelInfo,
} from '../shared/ipc.js';
import type { CompatProfile } from '@neoxlabs/kernel/types/compat.js';
import { resolveProviderEntry, type ProviderResolveContext } from './providerResolver.js';
import { resolveModelCapabilities } from './modelCapabilities.js';

/**
 * Config Service - Electron 端桥接 CLI ProviderStore
 * 保证桌面端与 CLI 共享相同的配置/Provider 管理逻辑
 */
export class ConfigService {
  private store: ProviderStore;

  constructor() {
    this.store = new ProviderStore();
  }

  private refreshStore(): ProviderStore {
    this.store = new ProviderStore();
    return this.store;
  }

  private cloneProvider(entry: ProviderConfigEntry | undefined | null): ProviderConfig | null {
    if (!entry) {
      return null;
    }
    return {
      ...entry,
      models: entry.models.map(model => ({ ...model })),
    };
  }

  private toStoreCreateInput(input: CreateProviderInput): StoreCreateProviderInput {
    return {
      ...input,
      models: input.models,
      setAsDefault: input.setAsDefault,
    };
  }

  private toStoreUpdateInput(input: UpdateProviderInput): StoreUpdateProviderInput {
    return {
      ...input,
    };
  }

  getProviders(): ProviderConfig[] {
    const store = this.refreshStore();
    return store.getProviders().map(entry => this.cloneProvider(entry)!);
  }

  getProvider(id: string): ProviderConfig | null {
    const store = this.refreshStore();
    return this.cloneProvider(store.getProvider(id)) ?? null;
  }

  getDefaultProvider(): ProviderConfig | null {
    const store = this.refreshStore();
    return this.cloneProvider(store.getDefaultProvider()) ?? null;
  }

  /** 返回原始 ProviderConfigEntry（含完整 models 数组），供 buildProvider 直接使用.
   *   如 host (desktop) 注册了 providerResolver, 这里会先经它改写后再返回 — 让 LLM 调用透明走
   *   Neox 网关 (或其他 host 决定的代理). 无 resolver 时返回原配置. */
  getDefaultProviderEntry(ctx?: ProviderResolveContext): ProviderConfigEntry | null {
    const store = this.refreshStore();
    return resolveProviderEntry(store.getDefaultProvider() ?? null, ctx);
  }

  /** 按 id 拿原始 ProviderConfigEntry, 同样过 resolver — buildProvider / 路由查模型用. */
  getProviderEntryById(id: string, ctx?: ProviderResolveContext): ProviderConfigEntry | null {
    const store = this.refreshStore();
    return resolveProviderEntry(store.getProvider(id) ?? null, ctx);
  }

  addProvider(input: CreateProviderInput): ProviderConfig {
    const store = this.refreshStore();
    const created = store.addProvider(this.toStoreCreateInput(input));
    return this.cloneProvider(created)!;
  }

  updateProvider(id: string, updates: UpdateProviderInput): ProviderConfig {
    const store = this.refreshStore();
    const updated = store.updateProvider(id, this.toStoreUpdateInput(updates));
    return this.cloneProvider(updated)!;
  }

  deleteProvider(id: string): void {
    const store = this.refreshStore();
    store.deleteProvider(id);
  }

  setDefaultProvider(id: string): ProviderConfig {
    const store = this.refreshStore();
    const provider = store.setDefaultProvider(id);
    return this.cloneProvider(provider)!;
  }

  addModel(providerId: string, modelName: string, makeDefault = false): ProviderConfig {
    const store = this.refreshStore();
    const updated = store.addModel(providerId, modelName, makeDefault);
    return this.cloneProvider(updated)!;
  }

  removeModel(providerId: string, modelName: string): ProviderConfig {
    const store = this.refreshStore();
    const updated = store.removeModel(providerId, modelName);
    return this.cloneProvider(updated)!;
  }

  setSelectedModel(providerId: string, modelName: string): ProviderConfig {
    const store = this.refreshStore();
    const updated = store.setLastSelectedModel(providerId, modelName);
    const { apiKey: _dropped, ...rest } = this.cloneProvider(updated)!;
    return rest as ProviderConfig;
  }

  getAvailableModels(): ModelInfo[] {
    const providers = this.getProviders();
    const models: ModelInfo[] = [];

    for (const provider of providers) {
      for (const model of provider.models) {
        const capabilities = resolveModelCapabilities(provider, model.name);

        models.push({
          id: `${provider.id}:${model.name}`,
          name: model.label || model.name,
          provider: provider.name,
          providerId: provider.id,
          maxTokens: capabilities.maxOutputTokens,
          contextWindow: capabilities.contextWindow,
          protocol: provider.protocol,
          baseUrl: provider.baseUrl,
          supportsVision: capabilities.supportsVision,
          supportsThinking: capabilities.supportsThinking,
        });
      }
    }

    return models;
  }

  getLLMConfig(providerId?: string, modelName?: string): {
    apiKey: string;
    baseUrl: string;
    model: string;
    protocol: string;
    useResponsesAPI?: boolean;
    maxTokens?: number;
    maxInputTokens?: number;
    compatProfile?: CompatProfile | null;
    providerName: string;
  } | null {
    const store = this.refreshStore();
    const provider = providerId ? store.getProvider(providerId) : store.getDefaultProvider();

    if (!provider) {
      return null;
    }

    const resolvedModel =
      modelName ||
      provider.lastSelectedModel ||
      provider.defaultModel ||
      provider.models[0]?.name;

    if (!resolvedModel) {
      return null;
    }

    // 根据 protocol 确定是否使用 Responses API
    const useResponsesAPI = provider.protocol === 'openai-responses';

    const capabilities = resolveModelCapabilities(provider, resolvedModel, {
      defaultMaxOutputTokens: 16384,
    });

    return {
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl || '',
      model: resolvedModel,
      protocol: provider.protocol,
      useResponsesAPI,
      maxTokens: capabilities.maxOutputTokens,
      maxInputTokens: capabilities.contextWindow,
      compatProfile: capabilities.compatProfile,
      providerName: provider.name,
    };
  }

  getConfigPath(): string {
    /* 实时拿 active config 路径。当前版本 BYOK config 全局化, 这里保留函数调用兼容旧路径抽象。 */
    return getActiveConfigFile();
  }

  getPiiFilterPreference(): boolean {
    const config = loadConfig();
    // 默认开启 PII 保护，避免 Anthropic API 的 user_id PII 检查导致 400 错误
    return config.piiFilterEnabled !== false;
  }

  setPiiFilterPreference(enabled: boolean): void {
    const config = loadConfig();
    config.piiFilterEnabled = enabled;
    saveConfig(config);
  }

  getBrowserUseConfig(): { reuseDailyLogins: boolean; dailyLoginsDecided: boolean; dailyProfileDir?: string; dailyProfileName?: string } {
    const raw = (loadConfig() as unknown as Record<string, unknown>).browserUse;
    const bu = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
      reuseDailyLogins: bu.reuseDailyLogins === true,
      /* The user chose (setting toggle or the first-launch prompt). An absent key and an
       * explicit "no" both read false for reuseDailyLogins; only this tells them apart. */
      dailyLoginsDecided: bu.dailyLoginsDecided === true,
      ...(typeof bu.dailyProfileDir === 'string' ? { dailyProfileDir: bu.dailyProfileDir } : {}),
      ...(typeof bu.dailyProfileName === 'string' ? { dailyProfileName: bu.dailyProfileName } : {}),
    };
  }

  setBrowserUseConfig(patch: { reuseDailyLogins?: boolean; dailyProfileDir?: string | null; dailyProfileName?: string | null }): void {
    const config = loadConfig() as unknown as Record<string, unknown>;
    const cur = (config.browserUse && typeof config.browserUse === 'object' ? config.browserUse : {}) as Record<string, unknown>;
    const next: Record<string, unknown> = { ...cur };
    if (typeof patch.reuseDailyLogins === 'boolean') {
      next.reuseDailyLogins = patch.reuseDailyLogins;
      next.dailyLoginsDecided = true;
    }
    if (patch.dailyProfileDir !== undefined) { if (patch.dailyProfileDir) next.dailyProfileDir = patch.dailyProfileDir; else delete next.dailyProfileDir; }
    if (patch.dailyProfileName !== undefined) { if (patch.dailyProfileName) next.dailyProfileName = patch.dailyProfileName; else delete next.dailyProfileName; }
    config.browserUse = next;
    saveConfig(config as never);
  }


  getGithubChannelConfig(): GithubChannelConfig {
    const raw = (loadConfig() as unknown as { channels?: { github?: GithubChannelConfig } }).channels?.github;
    const g = (raw && typeof raw === 'object' ? raw : {}) as Partial<GithubChannelConfig>;
    return {
      enabled: g.enabled === true,
      repos: Array.isArray(g.repos) ? g.repos.filter((r) => r && typeof r.repo === 'string' && typeof r.path === 'string') : [],
      mention: typeof g.mention === 'string' && g.mention.trim() ? g.mention.trim() : '@neox',
      pollIntervalMs: typeof g.pollIntervalMs === 'number' ? g.pollIntervalMs : 30000,
      autoPush: g.autoPush !== false,
      allowedUsers: Array.isArray(g.allowedUsers) ? g.allowedUsers : [],
      ...(typeof g.secret === 'string' ? { secret: g.secret } : {}),
      ...(typeof g.providerId === 'string' ? { providerId: g.providerId } : {}),
      ...(typeof g.modelName === 'string' ? { modelName: g.modelName } : {}),
    };
  }

  setGithubChannelConfig(patch: Partial<GithubChannelConfig>): GithubChannelConfig {
    const config = loadConfig() as unknown as { channels?: Record<string, unknown> };
    const cur = this.getGithubChannelConfig();
    const next: GithubChannelConfig = { ...cur, ...patch };
    if (patch.providerId === '' || patch.providerId === null) delete next.providerId;
    if (patch.modelName === '' || patch.modelName === null) delete next.modelName;
    if (patch.secret === '' || patch.secret === null) delete next.secret;
    config.channels = { ...(config.channels ?? {}), github: next };
    saveConfig(config as never);
    return next;
  }

  /** core 的 GithubChannel 落盘的状态 (~/.neox/channels/github.json): 最近轮询 / 错误 / 最近处理 */
  getGithubChannelStatus(): { login?: string; lastPollAt?: string; lastError?: string | null; recent?: Array<{ at: string; repo: string; number: number; user: string; status: string; note?: string }> } {
    try {
      const file = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'channels', 'github.json');
      const st = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      return {
        ...(typeof st.login === 'string' ? { login: st.login } : {}),
        ...(typeof st.lastPollAt === 'string' ? { lastPollAt: st.lastPollAt } : {}),
        lastError: typeof st.lastError === 'string' ? st.lastError : null,
        recent: Array.isArray(st.recent) ? (st.recent as never[]) : [],
      };
    } catch {
      return { lastError: null, recent: [] };
    }
  }

  getLanguagePreference(): UserLanguage {
    const config = loadConfig();
    return config.language || 'zh'; // 默认中文
  }

  setLanguagePreference(language: UserLanguage): void {
    const config = loadConfig();
    config.language = language;
    saveConfig(config);
  }

  getSupervisorConfig(): SupervisorConfig {
    const config = loadConfig();
    return config.supervisor || {};
  }

  setSupervisorConfig(updates: SupervisorConfig): SupervisorConfig {
    const config = loadConfig();
    const next = { ...(config.supervisor || {}), ...updates };
    config.supervisor = next;
    saveConfig(config);
    return next;
  }

  getCliDebugPreference(): boolean {
    const config = loadConfig();
    return config.cliDebug === true;
  }

  setCliDebugPreference(enabled: boolean): void {
    const config = loadConfig();
    config.cliDebug = enabled;
    saveConfig(config);
  }

  getProviderHealthIntervalMinutes(): number {
    const config = loadConfig();
    return config.providerHealthCheckIntervalMinutes && config.providerHealthCheckIntervalMinutes > 0
      ? config.providerHealthCheckIntervalMinutes
      : 30;
  }

  setProviderHealthIntervalMinutes(minutes: number): void {
    const safeMinutes = !minutes || minutes <= 0 ? 30 : minutes;
    const config = loadConfig();
    config.providerHealthCheckIntervalMinutes = safeMinutes;
    saveConfig(config);
  }

  getEnabledTools(): Record<string, boolean> {
    const config = loadConfig();
    return config.enabledTools || {};
  }

  setEnabledTools(enabledTools: Record<string, boolean>): void {
    const config = loadConfig();
    config.enabledTools = enabledTools;
    saveConfig(config);
  }

  getAutoHealthCheck(): boolean {
    const config = loadConfig();
    return config.autoHealthCheckEnabled === true;
  }

  setAutoHealthCheck(enabled: boolean): void {
    const config = loadConfig();
    config.autoHealthCheckEnabled = enabled;
    saveConfig(config);
  }

  // Agent 全局设置
  getAgentSettings(): {
    sandboxEnabled: boolean;
    approvalMode: 'auto' | 'manual' | 'dangerous';
    webSearchEnabled: boolean;
    webSearchEngine: 'auto' | 'bocha' | 'serper' | 'custom';
    webSearchUrl: string;
    webSearchApiKey: string;
    javaDebugEnabled: boolean;
    javaDebugHome?: string;
    javaDebugJarPath?: string;
  } {
    const config = loadConfig();
    return {
      sandboxEnabled: config.agentSandboxEnabled === true,  // 默认关闭
      approvalMode: config.agentApprovalMode || 'auto',     // 默认自动
      webSearchEnabled: config.webSearch?.enabled !== false, // 缺省开: 原生渠道默认可用; 显式 false 才关
      webSearchEngine: config.webSearch?.engine || 'auto',
      webSearchUrl: config.webSearch?.url || '',
      /* 盘上是 enc:v1 密文 — 解出明文回设置页密码框回显 (旧明文配置透传) */
      webSearchApiKey: unwrapApiKey(config.webSearch?.apiKey),
      javaDebugEnabled: config.javaDebug?.enabled === true, // 默认关闭
      javaDebugHome: config.javaDebug?.javaHome,
      javaDebugJarPath: config.javaDebug?.jarPath,
    };
  }

  setAgentSettings(settings: {
    sandboxEnabled?: boolean;
    approvalMode?: 'auto' | 'manual' | 'dangerous';
    webSearchEnabled?: boolean;
    webSearchEngine?: 'auto' | 'bocha' | 'serper' | 'custom';
    webSearchUrl?: string;
    webSearchApiKey?: string;
    javaDebugEnabled?: boolean;
    javaDebugHome?: string;
    javaDebugJarPath?: string;
  }): void {
    const config = loadConfig();
    if (settings.sandboxEnabled !== undefined) {
      config.agentSandboxEnabled = settings.sandboxEnabled;
    }
    if (settings.approvalMode !== undefined) {
      config.agentApprovalMode = settings.approvalMode;
    }
    // Web Search 设置
    if (settings.webSearchEnabled !== undefined || settings.webSearchEngine !== undefined || settings.webSearchUrl !== undefined || settings.webSearchApiKey !== undefined) {
      if (!config.webSearch) {
        /* 只改 engine/url/key 时不要默写入 enabled:false — 那会把 7-07 起
         * "原生渠道默认可用" 的装配门直接焊死, Life 丢 web_search。 */
        config.webSearch = {};
      }
      if (settings.webSearchEnabled !== undefined) {
        config.webSearch.enabled = settings.webSearchEnabled;
      }
      if (settings.webSearchEngine !== undefined) {
        config.webSearch.engine = settings.webSearchEngine;
      }
      if (settings.webSearchUrl !== undefined) {
        const nextUrl = settings.webSearchUrl.trim();
        if (nextUrl) {
          config.webSearch.url = nextUrl;
        } else {
          delete config.webSearch.url;
        }
      }
      if (settings.webSearchApiKey !== undefined) {
        config.webSearch.apiKey = wrapApiKey(settings.webSearchApiKey);
      }
    }
    // Java Debug 设置
    if (settings.javaDebugEnabled !== undefined || settings.javaDebugHome !== undefined || settings.javaDebugJarPath !== undefined) {
      if (!config.javaDebug) {
        config.javaDebug = { enabled: false };
      }
      if (settings.javaDebugEnabled !== undefined) {
        config.javaDebug!.enabled = settings.javaDebugEnabled;
      }
      if (settings.javaDebugHome !== undefined) {
        config.javaDebug!.javaHome = settings.javaDebugHome;
      }
      if (settings.javaDebugJarPath !== undefined) {
        config.javaDebug!.jarPath = settings.javaDebugJarPath;
      }
    }
    saveConfig(config);
  }

  // ==================== Agent Runtime Config(2026-04 Superpower)====================

  /** 读取完整的 agentRuntime 配置(未设置字段用代码默认值) */
  getAgentRuntimeConfig(): Required<{
    osSandbox: { enabled: boolean; mode: 'read-only' | 'workspace-write' | 'danger-full-access'; level: 'strict' | 'moderate' | 'permissive'; allowNetwork: boolean };
    adoptOnTimeout: { enabled: boolean };
    pty: { enabled: boolean };
    osNotifications: { enabled: boolean };
    threadDepth: { max: number };
    rollout: { dir: string | null };
    bashTimeout: { defaultMs: number; maxMs: number };
    approvalCache: { enabled: boolean };
    gitCoAuthor: { enabled: boolean };
    modelOrchestration: 'off' | 'on';
    /* 有意**不给默认值**: 消费方 (设置页迁移 / ServicesSurfaceViewer) 靠 undefined
     * 区分"用户没设过"和"用户设成 never", 补默认值会让老 localStorage 值永远迁不过来。 */
  }> & { servicesStopConfirmation?: 'never' | 'always' } {
    const rt = loadConfig().agentRuntime ?? {};
    return {
      osSandbox: {
        enabled: rt.osSandbox?.enabled ?? false,
        // 单一真源 mode; 老 level 自动迁移 (strict→read-only, 余→workspace-write)
        mode: rt.osSandbox?.mode ?? (rt.osSandbox?.level === 'strict' ? 'read-only' : 'workspace-write'),
        level: rt.osSandbox?.level ?? 'moderate',
        allowNetwork: rt.osSandbox?.allowNetwork ?? true,
      },
      adoptOnTimeout: { enabled: rt.adoptOnTimeout?.enabled ?? true },
      pty: { enabled: rt.pty?.enabled ?? true },
      osNotifications: { enabled: rt.osNotifications?.enabled ?? true },
      threadDepth: { max: rt.threadDepth?.max ?? 3 },
      rollout: { dir: rt.rollout?.dir ?? null },
      bashTimeout: {
        defaultMs: rt.bashTimeout?.defaultMs ?? 120_000,
        maxMs: rt.bashTimeout?.maxMs ?? 600_000,
      },
      approvalCache: { enabled: rt.approvalCache?.enabled ?? true },
      gitCoAuthor: { enabled: rt.gitCoAuthor?.enabled ?? true },
      // 智能模型编排 (Team P1 能力1) — 默认 off, 稳定优先
      modelOrchestration: rt.modelOrchestration === 'on' ? 'on' : 'off',
      servicesStopConfirmation: rt.servicesStopConfirmation,
    };
  }

  /** 部分更新 agentRuntime 配置(只需传要改的字段)*/
  setAgentRuntimeConfig(partial: AgentRuntimeConfig): void {
    const config = loadConfig();
    const current = config.agentRuntime ?? {};
    config.agentRuntime = {
      osSandbox: { ...current.osSandbox, ...partial.osSandbox },
      adoptOnTimeout: { ...current.adoptOnTimeout, ...partial.adoptOnTimeout },
      pty: { ...current.pty, ...partial.pty },
      osNotifications: { ...current.osNotifications, ...partial.osNotifications },
      threadDepth: { ...current.threadDepth, ...partial.threadDepth },
      rollout: { ...current.rollout, ...partial.rollout },
      bashTimeout: { ...current.bashTimeout, ...partial.bashTimeout },
      approvalCache: { ...current.approvalCache, ...partial.approvalCache },
      gitCoAuthor: { ...current.gitCoAuthor, ...partial.gitCoAuthor },
      // 标量字段 — 不能对象展开; 未传时保留现值
      modelOrchestration: partial.modelOrchestration ?? current.modelOrchestration,
      modelOrchestrationHints: partial.modelOrchestrationHints ?? current.modelOrchestrationHints,
      servicesStopConfirmation: partial.servicesStopConfirmation ?? current.servicesStopConfirmation,
    };
    saveConfig(config);
    // 热刷新 agentRuntimeConfig 缓存,让 runtime 立刻看到新配置
    refreshAgentRuntimeConfig();
  }

  // Java Debug 方法
  async getJavaDebugStatus(): Promise<{
    javaAvailable: boolean;
    javaVersion?: string;
    jarFound: boolean;
    jarPath?: string;
    ready: boolean;
  }> {
    try {
      // 动态导入 utils 以避免循环依赖
      // 使用 fileURLToPath 和 import.meta.url 构建正确的运行时路径
      const { fileURLToPath } = await import('url');
      const path = await import('path');
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      // 从 dist/ui-electron/platform/ 到 dist/ui-electron/tools/java-debug/
      const utilsPath = path.join(__dirname, '..', 'tools', 'java-debug', 'utils.js');
      const { getJavaDebugStatus } = await import(utilsPath);
      return await getJavaDebugStatus();
    } catch (error) {
      console.error('[ConfigService] Failed to get Java Debug status:', error);
      return {
        javaAvailable: false,
        jarFound: false,
        ready: false,
      };
    }
  }

  async downloadJavaDebugJar(): Promise<{ success: boolean; error?: string }> {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      const path = await import('path');
      const { existsSync } = await import('fs');

      const scriptPath = path.join(process.cwd(), 'scripts', 'download-java-debug.sh');
      if (!existsSync(scriptPath)) {
        return {
          success: false,
          error:
            `下载脚本不存在 (${scriptPath})。该脚本只随源码仓库分发；` +
            `安装版的 Java Debug jar 已随包内置, 无需下载 —— 若调试仍不可用, 请反馈而不是重试下载。`,
        };
      }

      console.log('[ConfigService] Running download script:', scriptPath);
      await execAsync(`bash "${scriptPath}"`);

      return { success: true };
    } catch (error: any) {
      console.error('[ConfigService] Failed to download Java Debug JAR:', error);
      return {
        success: false,
        error: error.message || 'Failed to download JAR',
      };
    }
  }

  // ==================== 模型路由管理 ====================

  private getDefaultRoutingConfig(): ModelRoutingConfig {
    return {
      enabled: false,
      routes: {},
      healthCheck: {
        failureThreshold: 3,
        recoveryThreshold: 2,
        timeoutMs: 10000,
      },
    };
  }

  /** 获取模型路由是否启用 */
  getModelRoutingEnabled(): boolean {
    const config = loadConfig();
    return config.modelRouting?.enabled === true;
  }

  /** 设置模型路由开关 */
  setModelRoutingEnabled(enabled: boolean): void {
    const config = loadConfig();
    if (!config.modelRouting) {
      config.modelRouting = this.getDefaultRoutingConfig();
    }
    config.modelRouting.enabled = enabled;
    saveConfig(config);
  }

  /** 获取完整的模型路由配置 */
  getModelRoutingConfig(): ModelRoutingConfig {
    const config = loadConfig();
    return config.modelRouting || this.getDefaultRoutingConfig();
  }

  /** 获取所有模型路由 */
  getModelRoutes(): Record<string, ModelRouteConfig> {
    const config = loadConfig();
    return config.modelRouting?.routes || {};
  }

  /** 获取单个模型路由 */
  getModelRoute(modelAlias: string): ModelRouteConfig | null {
    const config = loadConfig();
    return config.modelRouting?.routes?.[modelAlias] || null;
  }

  /** 设置模型路由 */
  setModelRoute(modelAlias: string, route: ModelRouteConfig): void {
    const config = loadConfig();
    if (!config.modelRouting) {
      config.modelRouting = this.getDefaultRoutingConfig();
    }
    const timestamp = new Date().toISOString();
    config.modelRouting.routes[modelAlias] = {
      ...route,
      updatedAt: timestamp,
      createdAt: route.createdAt || timestamp,
    };
    saveConfig(config);
  }

  /** 删除模型路由 */
  deleteModelRoute(modelAlias: string): boolean {
    const config = loadConfig();
    if (config.modelRouting?.routes?.[modelAlias]) {
      delete config.modelRouting.routes[modelAlias];
      saveConfig(config);
      return true;
    }
    return false;
  }

  /** 自动检测模型路由 - 查找多个 Provider 中相同模型 */
  autoDetectModelRoutes(modelName: string): ModelRouteConfig | null {
    const providers = this.getProviders();
    const matchingProviders: Array<{ providerId: string; modelName: string }> = [];

    for (const provider of providers) {
      // 查找该 Provider 中是否有匹配的模型
      const matchingModel = provider.models.find((m: ProviderModelConfig) =>
        m.name === modelName || m.name.includes(modelName) || modelName.includes(m.name)
      );

      if (matchingModel) {
        matchingProviders.push({
          providerId: provider.id,
          modelName: matchingModel.name,
        });
      }
    }

    if (matchingProviders.length < 2) {
      return null; // 少于 2 个 Provider，不需要路由
    }

    // 创建路由配置
    const route: ModelRouteConfig = {
      modelAlias: modelName,
      displayName: modelName,
      routes: matchingProviders.map((p, index) => ({
        providerId: p.providerId,
        modelName: p.modelName,
        priority: index + 1,
        enabled: true,
      })),
      strategy: 'priority',
      autoFailover: true,
    };

    return route;
  }

  /** 获取自动路由模型列表（用于 UI ModelSelector） */
  getAutoRoutedModels(): ModelInfo[] {
    const routingConfig = this.getModelRoutingConfig();
    if (!routingConfig.enabled) {
      return [];
    }

    const models: ModelInfo[] = [];
    const routes = routingConfig.routes;

    for (const [modelAlias, route] of Object.entries(routes)) {
      if (route.routes.length === 0) continue;

      // 获取第一个启用的 Provider 作为默认显示
      const firstEnabledRoute = route.routes.find(r => r.enabled);
      if (!firstEnabledRoute) continue;

      const provider = this.getProvider(firstEnabledRoute.providerId);
      if (!provider) continue;

      const capabilities = resolveModelCapabilities(provider, firstEnabledRoute.modelName);

      models.push({
        id: `auto:${modelAlias}`,
        name: route.displayName || modelAlias,
        provider: 'Auto',
        providerId: 'auto',
        maxTokens: capabilities.maxOutputTokens,
        contextWindow: capabilities.contextWindow,
        protocol: provider.protocol,
        baseUrl: provider.baseUrl,
        isAutoRouted: true,
        routeConfig: route,
      });
    }

    return models;
  }

  // ==================== 多模型协作配置 ====================

  private getDefaultOrchestratorConfig(): OrchestratorConfig {
    return {
      enabled: false,
      taskRouting: [],
      contextSharing: {
        strategy: 'summary',
        maxSharedTokens: 2000,
        summarizerModel: 'claude-haiku',
      },
      mode: 'hybrid',
      analyzerModel: 'claude-haiku',
    };
  }

  /** 获取多模型协作配置 */
  getOrchestratorConfig(): OrchestratorConfig {
    const config = loadConfig();
    return config.orchestrator || this.getDefaultOrchestratorConfig();
  }

  /** 设置多模型协作配置（部分更新） */
  setOrchestratorConfig(updates: Partial<OrchestratorConfig>): void {
    const config = loadConfig();
    const currentOrchestrator = config.orchestrator || this.getDefaultOrchestratorConfig();

    config.orchestrator = {
      ...currentOrchestrator,
      ...updates,
      contextSharing: {
        ...currentOrchestrator.contextSharing,
        ...(updates.contextSharing || {}),
      },
    };

    saveConfig(config);
  }

  /** 获取多模型协作是否启用 */
  getOrchestratorEnabled(): boolean {
    const config = loadConfig();
    return config.orchestrator?.enabled === true;
  }

  /** 设置多模型协作开关 */
  setOrchestratorEnabled(enabled: boolean): void {
    const config = loadConfig();
    if (!config.orchestrator) {
      config.orchestrator = this.getDefaultOrchestratorConfig();
    }
    config.orchestrator.enabled = enabled;
    saveConfig(config);
  }

  // ==================== 模型定价配置 ====================

  /** 获取所有定价配置 */
  getModelPricing(): ModelPricingConfig[] {
    const config = loadConfig();
    const list = config.modelPricing || [];
    /* 脏数据兜底: 历史配置偶发 null/残缺项, 读 .pattern 会炸整页 ErrorBoundary */
    return list.filter(
      (p): p is ModelPricingConfig =>
        !!p
        && typeof p === 'object'
        && typeof p.pattern === 'string'
        && p.pattern.length > 0
        && typeof p.inputPrice === 'number'
        && typeof p.outputPrice === 'number',
    );
  }

  /** 设置所有定价配置 */
  setModelPricing(pricing: ModelPricingConfig[]): void {
    const config = loadConfig();
    config.modelPricing = (pricing || []).filter(
      (p): p is ModelPricingConfig =>
        !!p && typeof p === 'object' && typeof p.pattern === 'string' && p.pattern.length > 0,
    );
    saveConfig(config);
  }

  /** 添加或更新定价配置 */
  upsertModelPricing(pricing: ModelPricingConfig): void {
    if (!pricing || typeof pricing.pattern !== 'string' || !pricing.pattern) return;
    const config = loadConfig();
    const list = (config.modelPricing || []).filter(
      (p): p is ModelPricingConfig => !!p && typeof p?.pattern === 'string',
    );
    const idx = list.findIndex(p => p.pattern === pricing.pattern);
    if (idx >= 0) {
      list[idx] = pricing;
    } else {
      list.push(pricing);
    }
    config.modelPricing = list;
    saveConfig(config);
  }

  /** 删除定价配置 */
  deleteModelPricing(pattern: string): void {
    const config = loadConfig();
    const list = config.modelPricing || [];
    config.modelPricing = list.filter(p => p && p.pattern !== pattern);
    saveConfig(config);
  }

  // ==================== Agent 运行模式 ====================

  /** 获取当前运行模式 */
  getRunMode(): string {
    const config = loadConfig();
    // 兼容旧配置：'single'/'basic' → 'agentic'
    const raw = (config.runMode || 'agentic') as string;
    return raw === 'single' || raw === 'basic' ? 'agentic' : raw;
  }

  /** 设置运行模式 */
  setRunMode(mode: string): void {
    console.log('[ConfigService] 🔄 setRunMode called with:', mode);
    const config = loadConfig();
    config.runMode = mode as typeof config.runMode;
    saveConfig(config);
    // 验证保存是否成功
    const saved = loadConfig();
    console.log('[ConfigService] ✅ Saved runMode:', saved.runMode);
  }

  // ==================== 协作模式配置 ====================

  private getDefaultAssistantConfig(): AssistantConfig {
    return {
      workerPool: [],
      maxConcurrent: 3,
    };
  }

  /** 获取协作模式配置 */
  getAssistantConfig(): AssistantConfig {
    const config = loadConfig();
    return config.assistant || this.getDefaultAssistantConfig();
  }

  /** 设置协作模式配置（部分更新） */
  setAssistantConfig(updates: Partial<AssistantConfig>): void {
    const config = loadConfig();
    const currentAssistant = config.assistant || this.getDefaultAssistantConfig();
    const timestamp = new Date().toISOString();

    config.assistant = {
      ...currentAssistant,
      ...updates,
      workerPool: updates.workerPool ?? currentAssistant.workerPool,
      updatedAt: timestamp,
      createdAt: currentAssistant.createdAt || timestamp,
    };

    saveConfig(config);
  }

  /** 获取主 Agent 配置 */
  getMainAgent(): AgentModelRef | undefined {
    const config = loadConfig();
    return config.assistant?.mainAgent;
  }

  /** 设置主 Agent 配置 */
  setMainAgent(agent: AgentModelRef | undefined): void {
    const config = loadConfig();
    if (!config.assistant) {
      config.assistant = this.getDefaultAssistantConfig();
    }
    config.assistant.mainAgent = agent;
    config.assistant.updatedAt = new Date().toISOString();
    saveConfig(config);
  }

  /** 获取 Worker 模型池 */
  getWorkerPool(): WorkerModelEntry[] {
    const config = loadConfig();
    return config.assistant?.workerPool || [];
  }

  /** 设置 Worker 模型池 */
  setWorkerPool(pool: WorkerModelEntry[]): void {
    const config = loadConfig();
    if (!config.assistant) {
      config.assistant = this.getDefaultAssistantConfig();
    }
    config.assistant.workerPool = pool;
    config.assistant.updatedAt = new Date().toISOString();
    saveConfig(config);
  }

  /** 添加 Worker 到模型池 */
  addWorkerToPool(worker: WorkerModelEntry): void {
    const config = loadConfig();
    if (!config.assistant) {
      config.assistant = this.getDefaultAssistantConfig();
    }
    // 检查是否已存在
    const exists = config.assistant.workerPool.some(
      w => w.providerId === worker.providerId && w.model === worker.model
    );
    if (!exists) {
      config.assistant.workerPool.push(worker);
      config.assistant.updatedAt = new Date().toISOString();
      saveConfig(config);
    }
  }

  /** 从模型池移除 Worker */
  removeWorkerFromPool(providerId: string, model: string): void {
    const config = loadConfig();
    if (!config.assistant) return;
    config.assistant.workerPool = config.assistant.workerPool.filter(
      w => !(w.providerId === providerId && w.model === model)
    );
    config.assistant.updatedAt = new Date().toISOString();
    saveConfig(config);
  }



  // --- Auto Memory ---

  /** 获取 Auto Memory 配置 */
  getAutoMemoryConfig(): {
    enabled: boolean;
    minConfidence: number;
    maxItemsPerSession: number;
    dedupThreshold: number;
  } {
    const config = loadConfig();
    const mem = config.memory;
    return {
      enabled: mem?.autoMemoryEnabled !== false,       // 默认开启
      minConfidence: mem?.autoMemoryMinConfidence ?? 0.7,
      maxItemsPerSession: mem?.autoMemoryMaxItemsPerSession ?? 5,
      dedupThreshold: mem?.autoMemoryDedupThreshold ?? 0.75,
    };
  }

  /** 设置 Auto Memory 开关 */
  setAutoMemoryEnabled(enabled: boolean): void {
    const config = loadConfig();
    if (!config.memory) config.memory = {};
    config.memory.autoMemoryEnabled = enabled;
    saveConfig(config);
  }

  // ==================== Model Config 持久化 ====================

  /** 获取 Model Config (Codex-style) */
  getModelConfig(): NonNullable<ReturnType<typeof loadConfig>['modelConfig']> {
    const config = loadConfig();
    return {
      reasoning_summary: 'auto',
      verbosity: 'medium',
      web_search: 'cached',
      hide_agent_reasoning: false,
      context_window: 0,
      auto_compact_limit: 0,
      service_tier: 'auto',
      ...(config.modelConfig || {}),
    };
  }

  /** 设置 Model Config（部分更新） */
  setModelConfig(updates: Record<string, any>): void {
    const config = loadConfig();
    const current = config.modelConfig || {};
    config.modelConfig = { ...current, ...updates };
    saveConfig(config);
  }

  /** 获取 Reasoning Effort */
  getReasoningEffort(): string {
    const config = loadConfig();
    return config.reasoningEffort || 'high';
  }

  /** 设置 Reasoning Effort */
  setReasoningEffort(effort: string): void {
    const config = loadConfig();
    config.reasoningEffort = effort;
    saveConfig(config);
  }

  // ── Inline completion (ghost text) — pin a fast model across providers ──
  getInlineCompletionConfig(): { enabled: boolean; providerId?: string; model?: string } {
    const config = loadConfig();
    const cfg = config.inlineCompletion ?? {};
    return {
      enabled: cfg.enabled !== false,
      providerId: cfg.providerId,
      model: cfg.model,
    };
  }

  setInlineCompletionConfig(updates: {
    enabled?: boolean;
    providerId?: string | null;
    model?: string | null;
  }): { enabled: boolean; providerId?: string; model?: string } {
    const config = loadConfig();
    const next = { ...(config.inlineCompletion ?? {}) };
    if (updates.enabled !== undefined) next.enabled = updates.enabled;
    if (updates.providerId !== undefined) {
      if (updates.providerId === null || updates.providerId === '') {
        delete next.providerId;
      } else {
        next.providerId = updates.providerId;
      }
    }
    if (updates.model !== undefined) {
      if (updates.model === null || updates.model === '') {
        delete next.model;
      } else {
        next.model = updates.model;
      }
    }
    config.inlineCompletion = next;
    saveConfig(config);
    return {
      enabled: next.enabled !== false,
      providerId: next.providerId,
      model: next.model,
    };
  }

  /**
   * Resolve the (provider, model) pair to use for inline completion.
   * Honours the explicit override if it still points to a valid provider+model;
   * otherwise returns null so the caller can fall back to its own heuristic.
   */
  resolveInlineCompletionTarget(): { provider: ProviderConfigEntry; model: string } | null {
    const cfg = this.getInlineCompletionConfig();
    if (!cfg.enabled) return null;
    if (!cfg.providerId || !cfg.model) return null;
    const store = this.refreshStore();
    const provider = store.getProvider(cfg.providerId);
    if (!provider) return null;
    const modelExists = provider.models?.some((m) => m.name === cfg.model);
    if (!modelExists) return null;
    return { provider, model: cfg.model };
  }
}

export const configService = new ConfigService();
