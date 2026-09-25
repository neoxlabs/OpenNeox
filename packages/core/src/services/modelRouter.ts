/**
 * ModelRouter - 模型路由服务
 *
 * 负责在同一模型的多个 Provider 之间进行智能路由：
 * - 基于健康状态自动切换
 * - 支持优先级、延迟、轮询等策略
 * - 自动故障转移
 */

import {
  ModelRouteConfig,
  ModelRoutingConfig,
  ModelProviderRoute,
  RoutingStrategy,
  ProviderConfigEntry,
  loadConfig,
  saveConfig,
} from '@neoxlabs/platform/utils/config.js';

/** Provider 运行时健康状态 */
export type ProviderHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

/** Provider 运行时状态 */
export interface ProviderRuntimeStatus {
  providerId: string;
  status: ProviderHealthStatus;
  lastLatency?: number;
  failureCount: number;
  successCount: number;
  lastChecked?: number;
  lastError?: string;
}

/** 路由解析结果 */
export interface ResolvedRoute {
  /** 选中的 Provider ID */
  providerId: string;
  /** 选中的模型名称 */
  modelName: string;
  /** 备选路由链（用于 fallback） */
  fallbackChain: ModelProviderRoute[];
  /** 是否处于降级状态 */
  degraded?: boolean;
  /** 路由原因 */
  reason?: string;
}

/** 路由失败错误 */
export class RoutingError extends Error {
  constructor(
    message: string,
    public readonly modelAlias: string,
    public readonly attemptedProviders: string[]
  ) {
    super(message);
    this.name = 'RoutingError';
  }
}

/** 默认路由配置 */
const DEFAULT_ROUTING_CONFIG: ModelRoutingConfig = {
  enabled: false,
  routes: {},
  healthCheck: {
    failureThreshold: 3,
    recoveryThreshold: 2,
    timeoutMs: 10000,
  },
};

/**
 * ModelRouter 类 - 模型路由核心
 */
export class ModelRouter {
  private config: ModelRoutingConfig;
  private runtimeStatus: Map<string, ProviderRuntimeStatus> = new Map();
  private roundRobinIndex: Map<string, number> = new Map();
  private getProviderFn: (id: string) => ProviderConfigEntry | undefined;
  private getHealthFn?: (providerId: string) => { status: string; latency?: number } | undefined;

  constructor(
    getProvider: (id: string) => ProviderConfigEntry | undefined,
    getHealth?: (providerId: string) => { status: string; latency?: number } | undefined
  ) {
    this.getProviderFn = getProvider;
    this.getHealthFn = getHealth;
    this.config = this.loadRoutingConfig();
  }

  /**
   * 加载路由配置
   */
  private loadRoutingConfig(): ModelRoutingConfig {
    const config = loadConfig();
    return config.modelRouting || DEFAULT_ROUTING_CONFIG;
  }

  /**
   * 保存路由配置
   */
  private saveRoutingConfig(): void {
    const config = loadConfig();
    config.modelRouting = this.config;
    saveConfig(config);
  }

  /**
   * 刷新配置（从文件重新加载）
   */
  refresh(): void {
    this.config = this.loadRoutingConfig();
  }

  /**
   * 检查路由是否启用
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * 启用/禁用路由
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    this.saveRoutingConfig();
  }

  /**
   * 获取所有路由配置
   */
  getRoutes(): Record<string, ModelRouteConfig> {
    return this.config.routes;
  }

  /**
   * 获取单个模型的路由配置
   */
  getRoute(modelAlias: string): ModelRouteConfig | undefined {
    return this.config.routes[modelAlias];
  }

  /**
   * 检查模型是否有路由配置
   */
  hasRoute(modelAlias: string): boolean {
    return !!this.config.routes[modelAlias];
  }

  /**
   * 添加或更新模型路由
   */
  setRoute(modelAlias: string, route: ModelRouteConfig): void {
    const timestamp = new Date().toISOString();
    this.config.routes[modelAlias] = {
      ...route,
      updatedAt: timestamp,
      createdAt: route.createdAt || timestamp,
    };
    this.saveRoutingConfig();
  }

  /**
   * 删除模型路由
   */
  deleteRoute(modelAlias: string): boolean {
    if (this.config.routes[modelAlias]) {
      delete this.config.routes[modelAlias];
      this.saveRoutingConfig();
      return true;
    }
    return false;
  }

  /**
   * 获取 Provider 的运行时状态
   */
  private getProviderStatus(providerId: string): ProviderRuntimeStatus {
    let status = this.runtimeStatus.get(providerId);
    if (!status) {
      status = {
        providerId,
        status: 'unknown',
        failureCount: 0,
        successCount: 0,
      };
      this.runtimeStatus.set(providerId, status);
    }

    // 如果有外部健康检查数据，同步状态
    if (this.getHealthFn) {
      const health = this.getHealthFn(providerId);
      if (health) {
        status.status = this.mapHealthStatus(health.status);
        status.lastLatency = health.latency;
      }
    }

    return status;
  }

  /**
   * 映射健康检查状态到路由状态
   */
  private mapHealthStatus(status: string): ProviderHealthStatus {
    switch (status) {
      case 'excellent':
      case 'good':
        return 'healthy';
      case 'poor':
        return 'degraded';
      case 'offline':
      case 'error':
        return 'unhealthy';
      default:
        return 'unknown';
    }
  }

  /**
   * 记录 Provider 调用成功
   */
  recordSuccess(providerId: string, latency?: number): void {
    const status = this.getProviderStatus(providerId);
    status.successCount++;
    status.failureCount = 0;
    status.lastLatency = latency;
    status.lastChecked = Date.now();
    status.lastError = undefined;

    // 连续成功超过阈值，恢复为健康
    if (status.successCount >= this.config.healthCheck.recoveryThreshold) {
      status.status = 'healthy';
    }
  }

  /**
   * 记录 Provider 调用失败
   */
  recordFailure(providerId: string, error?: Error): void {
    const status = this.getProviderStatus(providerId);
    status.failureCount++;
    status.successCount = 0;
    status.lastChecked = Date.now();
    status.lastError = error?.message;

    // 连续失败超过阈值，标记为不健康
    if (status.failureCount >= this.config.healthCheck.failureThreshold) {
      status.status = 'unhealthy';
    } else {
      status.status = 'degraded';
    }
  }

  /**
   * 标记 Provider 为降级状态（如限流）
   */
  markDegraded(providerId: string, reason?: string): void {
    const status = this.getProviderStatus(providerId);
    status.status = 'degraded';
    status.lastError = reason;
    status.lastChecked = Date.now();
  }

  /**
   * 解析最优 Provider - 核心路由方法
   */
  resolveProvider(modelAlias: string): ResolvedRoute | null {
    const routeConfig = this.config.routes[modelAlias];
    if (!routeConfig) {
      return null;
    }

    // 过滤出启用的路由
    const enabledRoutes = routeConfig.routes.filter(r => r.enabled);
    if (enabledRoutes.length === 0) {
      return null;
    }

    switch (routeConfig.strategy) {
      case 'priority':
        return this.resolvePriority(routeConfig, enabledRoutes);
      case 'latency':
        return this.resolveByLatency(routeConfig, enabledRoutes);
      case 'round-robin':
        return this.resolveRoundRobin(routeConfig, enabledRoutes);
      default:
        return this.resolvePriority(routeConfig, enabledRoutes);
    }
  }

  /**
   * 优先级策略：选择优先级最高且健康的 Provider
   */
  private resolvePriority(
    config: ModelRouteConfig,
    routes: ModelProviderRoute[]
  ): ResolvedRoute {
    const sorted = [...routes].sort((a, b) => a.priority - b.priority);

    // 查找第一个健康的 Provider
    for (const route of sorted) {
      const status = this.getProviderStatus(route.providerId);
      const provider = this.getProviderFn(route.providerId);

      if (!provider) continue;

      if (status.status === 'healthy' || status.status === 'unknown') {
        return {
          providerId: route.providerId,
          modelName: route.modelName,
          fallbackChain: sorted.filter(r => r.providerId !== route.providerId),
          reason: `Priority ${route.priority}, status: ${status.status}`,
        };
      }
    }

    // 没有健康的，尝试降级的
    for (const route of sorted) {
      const status = this.getProviderStatus(route.providerId);
      const provider = this.getProviderFn(route.providerId);

      if (!provider) continue;

      if (status.status === 'degraded') {
        return {
          providerId: route.providerId,
          modelName: route.modelName,
          fallbackChain: sorted.filter(r => r.providerId !== route.providerId),
          degraded: true,
          reason: `Degraded fallback, priority ${route.priority}`,
        };
      }
    }

    // 全部不可用，返回第一个尝试
    const first = sorted[0];
    return {
      providerId: first.providerId,
      modelName: first.modelName,
      fallbackChain: sorted.slice(1),
      degraded: true,
      reason: 'All providers unhealthy, trying first',
    };
  }

  /**
   * 延迟策略：选择延迟最低的健康 Provider
   */
  private resolveByLatency(
    config: ModelRouteConfig,
    routes: ModelProviderRoute[]
  ): ResolvedRoute {
    // 获取所有健康 Provider 并按延迟排序
    const healthy = routes
      .map(route => ({
        route,
        status: this.getProviderStatus(route.providerId),
        provider: this.getProviderFn(route.providerId),
      }))
      .filter(({ status, provider }) =>
        provider && (status.status === 'healthy' || status.status === 'unknown')
      )
      .sort((a, b) => (a.status.lastLatency ?? Infinity) - (b.status.lastLatency ?? Infinity));

    if (healthy.length > 0) {
      const best = healthy[0];
      return {
        providerId: best.route.providerId,
        modelName: best.route.modelName,
        fallbackChain: routes.filter(r => r.providerId !== best.route.providerId),
        reason: `Lowest latency: ${best.status.lastLatency ?? 'unknown'}ms`,
      };
    }

    // 没有健康的，fallback 到优先级策略
    return this.resolvePriority(config, routes);
  }

  /**
   * 轮询策略：依次使用各个健康的 Provider
   */
  private resolveRoundRobin(
    config: ModelRouteConfig,
    routes: ModelProviderRoute[]
  ): ResolvedRoute {
    const healthy = routes.filter(route => {
      const status = this.getProviderStatus(route.providerId);
      const provider = this.getProviderFn(route.providerId);
      return provider && (status.status === 'healthy' || status.status === 'unknown');
    });

    if (healthy.length === 0) {
      // 没有健康的，fallback 到优先级策略
      return this.resolvePriority(config, routes);
    }

    // 获取并更新轮询索引
    const currentIndex = this.roundRobinIndex.get(config.modelAlias) ?? 0;
    const nextIndex = (currentIndex + 1) % healthy.length;
    this.roundRobinIndex.set(config.modelAlias, nextIndex);

    const selected = healthy[currentIndex % healthy.length];
    return {
      providerId: selected.providerId,
      modelName: selected.modelName,
      fallbackChain: routes.filter(r => r.providerId !== selected.providerId),
      reason: `Round-robin index: ${currentIndex}`,
    };
  }

  /**
   * 获取模型的所有可用 Provider（用于 UI 展示）
   */
  getAvailableProvidersForModel(modelAlias: string): Array<{
    providerId: string;
    modelName: string;
    priority: number;
    enabled: boolean;
    status: ProviderHealthStatus;
    latency?: number;
  }> {
    const routeConfig = this.config.routes[modelAlias];
    if (!routeConfig) {
      return [];
    }

    return routeConfig.routes.map(route => {
      const status = this.getProviderStatus(route.providerId);
      return {
        providerId: route.providerId,
        modelName: route.modelName,
        priority: route.priority,
        enabled: route.enabled,
        status: status.status,
        latency: status.lastLatency,
      };
    });
  }

  /**
   * 快速创建路由配置的辅助方法
   */
  createRouteFromProviders(
    modelAlias: string,
    providers: Array<{ providerId: string; modelName: string }>,
    options: {
      strategy?: RoutingStrategy;
      autoFailover?: boolean;
      displayName?: string;
    } = {}
  ): ModelRouteConfig {
    const { strategy = 'priority', autoFailover = true, displayName } = options;

    return {
      modelAlias,
      displayName: displayName || modelAlias,
      routes: providers.map((p, index) => ({
        providerId: p.providerId,
        modelName: p.modelName,
        priority: index + 1,
        enabled: true,
      })),
      strategy,
      autoFailover,
    };
  }

  /**
   * 自动检测并创建路由配置
   * 查找所有 Provider 中包含相同模型名称的，自动创建路由
   */
  autoDetectRoutes(
    providers: ProviderConfigEntry[],
    modelName: string
  ): ModelRouteConfig | null {
    const matchingProviders: Array<{ providerId: string; modelName: string }> = [];

    for (const provider of providers) {
      // 查找该 Provider 中是否有匹配的模型
      const matchingModel = provider.models.find(m =>
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
      return null; // 少于2个 Provider，不需要路由
    }

    return this.createRouteFromProviders(modelName, matchingProviders);
  }
}

// 单例实例导出
let routerInstance: ModelRouter | null = null;

export function getModelRouter(
  getProvider: (id: string) => ProviderConfigEntry | undefined,
  getHealth?: (providerId: string) => { status: string; latency?: number } | undefined
): ModelRouter {
  if (!routerInstance) {
    routerInstance = new ModelRouter(getProvider, getHealth);
  }
  return routerInstance;
}

export function resetModelRouter(): void {
  routerInstance = null;
}
