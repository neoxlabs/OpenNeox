import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { neoxHome } from '@neoxlabs/kernel/platform/neoxHome.js';
import { join, dirname } from 'path';
import { createRequire } from 'node:module';
import { homedir } from 'os';

/**
 * 拿数据目录 —— **不能**在顶层 `import { app } from 'electron'`。
 *
 * 这个模块被 cloud:health-probe 用到, 而那条探活极简版也要 (登录页那条
 * "云端不可达"红条就靠它, renderer 自己 fetch 会撞 CORS 必须由宿主发)。
 * 顶层静态 import 会让**整个 bundle** 在纯 Node 进程里加载失败:
 *   `Named export 'app' not found. The requested module 'electron' is a CommonJS module`
 * —— 一个模块的 import 把同 bundle 里其余十几个 handler 全带下水,
 * 表现是"桥上一条路由都没有"。
 *
 * 改成运行时取: 在 Electron 里还是原来的 userData; 不在就回落到极简版的用户目录。
 */
function dataDir(): string {
  /* 显式覆盖最高优先 —— 测试要把数据落到临时目录。
   *
   * 为什么需要它: 测试原本靠 vi.doMock('electron') 换掉 app.getPath, 但下面是
   * createRequire 同步 require, **绕过 vitest 的模块 mock**。改成运行时取之后
   * 那个 mock 就失效了, 测试转而去读真实的 ~/.neox-lite —— 拿到我平时跑出来的
   * 真数据, 断言 length 1 却拿到 3。一个环境变量比让测试去猜宿主可靠得多。 */
  const override = process.env.NEOX_DATA_DIR?.trim();
  if (override) return override;
  try {
    const app = createRequire(import.meta.url)('electron')?.app;
    if (app?.getPath) return app.getPath('userData');
  } catch { /* 非 Electron 宿主 */ }
  return neoxHome();
}

/**
 * 健康状态类型
 */
export type HealthStatus = 'excellent' | 'good' | 'poor' | 'offline' | 'error';

/**
 * 单条健康记录
 */
export interface HealthRecord {
  status: HealthStatus;
  latency: number;
  timestamp: number;
  /** 探测失败时的原始错误 / 人话诊断 */
  error?: string;
  /** 上游 HTTP 状态码 */
  httpStatus?: number;
  /** 本次探测实际用的模型 */
  model?: string;
}

/**
 * Provider 健康信息
 */
export interface ProviderHealth {
  current: HealthStatus | 'testing';
  latency?: number;
  history: HealthRecord[];
}

/**
 * 健康数据存储结构
 */
export interface HealthCheckData {
  version: string;
  lastUpdated: number;
  providers: Record<string, ProviderHealth>;
}

// 6小时 = 360分钟，每分钟一条 = 360条记录
const MAX_HEALTH_HISTORY = 360;
// 6小时毫秒数
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/**
 * Health Check Service - 持久化健康检测结果到文件系统
 */
export class HealthCheckService {
  private dataFile: string;
  private data: HealthCheckData;

  constructor() {
    // 存储路径: ~/Library/Application Support/Neox/health-check.json (macOS)
    const userDataPath = dataDir();
    this.dataFile = join(userDataPath, 'health-check.json');
    this.data = this.loadData();
  }

  /**
   * 从文件加载健康数据
   */
  private loadData(): HealthCheckData {
    try {
      if (existsSync(this.dataFile)) {
        const content = readFileSync(this.dataFile, 'utf-8');
        const parsed = JSON.parse(content) as HealthCheckData;
        // 清理过期记录
        this.cleanupExpiredRecords(parsed);
        return parsed;
      }
    } catch (error) {
      console.error('[HealthCheckService] Failed to load data:', error);
    }
    // 返回默认数据
    return {
      version: '1.0',
      lastUpdated: Date.now(),
      providers: {},
    };
  }

  /**
   * 保存健康数据到文件
   */
  private saveData(): void {
    try {
      const dir = dirname(this.dataFile);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      this.data.lastUpdated = Date.now();
      writeFileSync(this.dataFile, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (error) {
      console.error('[HealthCheckService] Failed to save data:', error);
    }
  }

  /**
   * 清理超过6小时的历史记录
   */
  private cleanupExpiredRecords(data: HealthCheckData): void {
    const sixHoursAgo = Date.now() - SIX_HOURS_MS;
    for (const providerId of Object.keys(data.providers)) {
      const provider = data.providers[providerId];
      if (provider.history) {
        provider.history = provider.history.filter(r => r.timestamp > sixHoursAgo);
      }
    }
  }

  /**
   * 获取所有健康数据
   */
  getHealthData(): Record<string, ProviderHealth> {
    // 重新加载以获取最新数据
    this.data = this.loadData();
    return this.data.providers;
  }

  /**
   * 获取单个 Provider 的健康数据
   */
  getProviderHealth(providerId: string): ProviderHealth | null {
    return this.data.providers[providerId] || null;
  }

  /**
   * 更新 Provider 健康状态
   */
  updateProviderHealth(
    providerId: string,
    status: HealthStatus | 'testing',
    latency?: number,
    error?: string,
    httpStatus?: number,
    model?: string,
  ): ProviderHealth {
    const existing = this.data.providers[providerId] || {
      current: 'testing',
      history: [],
    };

    // 更新当前状态
    existing.current = status;
    if (latency !== undefined) {
      existing.latency = latency;
    }

    // 如果不是 testing 状态，添加到历史记录
    if (status !== 'testing') {
      const newRecord: HealthRecord = {
        status: status as HealthStatus,
        latency: latency || 0,
        timestamp: Date.now(),
        /* 失败才挂 error/httpStatus; model 成功失败都记, 方便诊断"测的是哪个模型". */
        ...(error ? { error } : {}),
        ...(httpStatus ? { httpStatus } : {}),
        ...(model ? { model } : {}),
      };
      existing.history = [...existing.history, newRecord].slice(-MAX_HEALTH_HISTORY);
    }

    this.data.providers[providerId] = existing;
    this.saveData();

    return existing;
  }

  /**
   * 批量更新健康数据（用于恢复）
   */
  setHealthData(data: Record<string, ProviderHealth>): void {
    this.data.providers = data;
    this.saveData();
  }

  /**
   * 删除 Provider 的健康数据
   */
  deleteProviderHealth(providerId: string): void {
    delete this.data.providers[providerId];
    this.saveData();
  }

  /**
   * 清除所有健康数据
   */
  clearAllHealth(): void {
    this.data.providers = {};
    this.saveData();
  }
}

export const healthCheckService = new HealthCheckService();
