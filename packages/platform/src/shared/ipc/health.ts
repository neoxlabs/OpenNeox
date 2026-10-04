import type { ProviderProtocol } from '@neoxlabs/kernel/types/configTypes.js';

export interface HealthCheckRequest {
  providerId: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  urlSuffix?: string;
  apiKey: string;
  model: string;
  disableCaching?: boolean;
  /**
   * Anthropic 身份策略 (auto/on/off). undefined 视作 'auto', 保持向后兼容.
   * providerHealthCheck 使用同一逻辑决定 Test Connection 请求的身份,
   * 与真实 chat 请求同步, 避免"测试通过但 chat 报 400"的诡异不一致.
   * (只对 protocol='anthropic' 生效)
   */
  claudeCodeMode?: 'auto' | 'on' | 'off';
  /**
   * NeoxCloud 控制面 base (https://neox-dev.com) —— 只给托管 provider (neox-cloud) 探活用.
   *
   *   托管 provider 没有用户自己的 Key 可验, 也**不能**拿真 chat 请求去探 —— 那会烧订阅额度,
   *   而自动健康检查是按分钟周期跑的。所以走控制面的 GET /api/health (无鉴权/零成本)。
   *   调用方 (桌面 main) 传入; 不传则退回"未登录"判定, 行为跟加这个字段之前一致。
   */
  cloudApiBase?: string;
}

export interface HealthCheckResult {
  providerId: string;
  status: 'excellent' | 'good' | 'poor' | 'offline' | 'error';
  latency: number;
  timestamp: number;
  errorMessage?: string;
  /** 探测失败时上游返回的 HTTP 状态码 (401/403/429/500…), 便于用户诊断. */
  httpStatus?: number;
}

export interface KimiBalanceResult {
  success: boolean;
  available_balance?: number;
  voucher_balance?: number;
  cash_balance?: number;
  error?: string;
}

export type HealthStatus = 'excellent' | 'good' | 'poor' | 'offline' | 'error';

export interface HealthRecord {
  status: HealthStatus;
  latency: number;
  timestamp: number;
  /** 探测的原始错误信息 (仅失败记录有). 供 UI 弹窗展示"最近几次错误". */
  error?: string;
  /** 上游 HTTP 状态码 (仅失败记录有). */
  httpStatus?: number;
  /** 本次探测实际使用的模型 id. */
  model?: string;
}

export interface ProviderHealth {
  current: HealthStatus | 'testing';
  status?: HealthStatus | 'testing';
  latency?: number;
  history: HealthRecord[];
}
