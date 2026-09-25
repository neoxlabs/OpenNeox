/**
 * Device Manager Middleware
 *
 * 设备注册与管理。从 Client Agent 迁移，适配 HTTP 模式。
 */

import type { MiddlewareHandler } from 'hono';
import crypto from 'crypto';
import type { DeviceInfo, Capability } from '../client-agent/protocol.js';

// ============================================================================
// Types
// ============================================================================

export interface DeviceState {
  id: string;
  device: DeviceInfo;
  capabilities: Capability[];
  registeredAt: number;
  lastSeen: number;
  ip: string;
  /** 设备级运行模式偏好（优先于全局 mode） */
  preferredMode?: string;
}

export interface DeviceManagerConfig {
  /** 最大设备数（默认 20） */
  maxDevices?: number;
  /** 设备空闲超时 ms（默认 24h） */
  idleTimeout?: number;
}

// ============================================================================
// DeviceManager
// ============================================================================

export class DeviceManager {
  private devices = new Map<string, DeviceState>();
  private maxDevices: number;
  private idleTimeout: number;
  private cleanupTimer: NodeJS.Timeout;

  constructor(config?: DeviceManagerConfig) {
    this.maxDevices = config?.maxDevices ?? 20;
    this.idleTimeout = config?.idleTimeout ?? 24 * 60 * 60 * 1000;

    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  register(device: DeviceInfo, capabilities: Capability[], ip: string): string {
    // 同设备名 + 同 IP 复用
    for (const [id, state] of this.devices) {
      if (state.device.name === device.name && state.ip === ip) {
        state.device = device;
        state.capabilities = capabilities;
        state.lastSeen = Date.now();
        return id;
      }
    }

    if (this.devices.size >= this.maxDevices) {
      // 淘汰最久未活跃的
      let oldest: string | null = null;
      let oldestTime = Infinity;
      for (const [id, state] of this.devices) {
        if (state.lastSeen < oldestTime) {
          oldestTime = state.lastSeen;
          oldest = id;
        }
      }
      if (oldest) this.devices.delete(oldest);
    }

    const id = crypto.randomUUID();
    this.devices.set(id, {
      id,
      device,
      capabilities,
      registeredAt: Date.now(),
      lastSeen: Date.now(),
      ip,
    });
    return id;
  }

  touch(deviceId: string): void {
    const d = this.devices.get(deviceId);
    if (d) d.lastSeen = Date.now();
  }

  getDevice(deviceId: string): DeviceState | null {
    return this.devices.get(deviceId) ?? null;
  }

  removeDevice(deviceId: string): boolean {
    return this.devices.delete(deviceId);
  }

  getAll(): DeviceState[] {
    return [...this.devices.values()];
  }

  /** 独立的设备模式偏好（不依赖设备注册） */
  private modePrefs = new Map<string, string>();

  setPreferredMode(deviceId: string, mode: string): void {
    this.modePrefs.set(deviceId, mode);
    // 同步到已注册设备
    const d = this.devices.get(deviceId);
    if (d) d.preferredMode = mode;
  }

  getPreferredMode(deviceId: string): string | undefined {
    return this.modePrefs.get(deviceId) ?? this.devices.get(deviceId)?.preferredMode;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, state] of this.devices) {
      if (now - state.lastSeen > this.idleTimeout) {
        this.devices.delete(id);
      }
    }
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
    this.devices.clear();
  }
}

// ============================================================================
// Middleware — 自动 touch 已注册设备
// ============================================================================

export function deviceMiddleware(manager: DeviceManager): MiddlewareHandler {
  return async (c, next) => {
    const deviceId = c.req.header('x-device-id');
    if (deviceId) {
      manager.touch(deviceId);
      // 注入到 context 供后续 handler 使用
      c.set('deviceId', deviceId);
    }
    return next();
  };
}
