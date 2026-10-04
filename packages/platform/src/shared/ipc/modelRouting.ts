export type RoutingStrategy = 'priority' | 'latency' | 'round-robin';

export interface ModelProviderRoute {
  providerId: string;
  modelName: string;
  priority: number;
  enabled: boolean;
}

export interface ModelRouteConfig {
  modelAlias: string;
  displayName?: string;
  routes: ModelProviderRoute[];
  strategy: RoutingStrategy;
  autoFailover: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface FallbackSettings {
  autoFallback: boolean;
  maxConsecutiveFallbacks: number;
  fallbackCooldownMs: number;
  notifyOnFallback: boolean;
  notifyOnRecovery: boolean;
}

export interface RecoverySettings {
  enabled: boolean;
  checkIntervalMs: number;
  confirmationCount: number;
  autoSwitchBack: boolean;
}

export type FallbackReason =
  | 'provider_error'
  | 'timeout'
  | 'rate_limit'
  | 'quota_exceeded'
  | 'network_error'
  | 'auth_error'
  | 'model_unavailable'
  | 'manual'
  | 'health_check';

export interface FallbackEvent {
  timestamp: number;
  modelAlias: string;
  fromProviderId: string;
  toProviderId: string;
  reason: FallbackReason;
  errorMessage?: string;
  automatic: boolean;
  fallbackIndex: number;
  remainingProviders: number;
}

export interface RecoveryEvent {
  timestamp: number;
  providerId: string;
  modelAlias?: string;
  previousStatus: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  currentStatus: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  recoveryDuration: number;
}

export interface ModelRoutingConfig {
  enabled: boolean;
  routes: Record<string, ModelRouteConfig>;
  healthCheck: {
    failureThreshold: number;
    recoveryThreshold: number;
    timeoutMs: number;
  };
  fallback?: FallbackSettings;
  recovery?: RecoverySettings;
}
