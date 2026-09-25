/**
 * routingState — DB-backed routing 状态管理（替代 routing.json 文件）。
 *
 * 单源：SQLite app_state 表，key='routing'。
 * 每次读都从 DB 取（微秒级），不做内存缓存，杜绝一致性问题。
 * CLI 和 Desktop 各自的用户 DB 天然隔离，不互相覆盖。
 *
 * 使用方式：
 *   登录时: setRoutingState({ gatewayBase, routableProtocols })
 *   读取时: getRoutingState()  — 每次从 DB 现读
 *   登出时: clearRoutingState()
 */

import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);

export interface RoutingState {
  enabled: boolean;
  gatewayBase: string;
  routableProtocols: string[];
}

export const DEFAULT_GATEWAY_BASE = 'https://gateway.neox-dev.com/n1';

const LEGACY_GATEWAY_BASES = new Set([
  'https://neox-dev.com',
  'https://neox-dev.com/n1',
]);

/** 已登录用户 SQLite 里可能还是橙云同域 /n1, 读的时候迁到灰云 host. */
export function canonicalizeGatewayBase(raw: string): string {
  const cleaned = raw.replace(/\/+$/, '');
  if (LEGACY_GATEWAY_BASES.has(cleaned)) return DEFAULT_GATEWAY_BASE;
  return cleaned;
}
export const DEFAULT_ROUTABLE_PROTOCOLS = [
  'openai', 'openai-responses', 'kimi', 'deepseek', 'minimax', 'qwen', 'glm', 'doubao', 'anthropic', 'anthropic-openai',
];

const ROUTING_STATE_KEY = 'routing';

function getDb(): any {
  const g = (globalThis as any).__NEOX_DB__;
  if (g) return g;
  try {
    const { getDatabase } = _require('./database.js');
    return getDatabase();
  } catch (err: any) {
    cliLogger.warn('ROUTING', `getDb() failed: ${err?.message ?? err}`);
    return null;
  }
}

export function setRoutingState(state: Partial<RoutingState>, dbInstance?: any): void {
  const value: RoutingState = {
    enabled: state.enabled ?? true,
    gatewayBase: canonicalizeGatewayBase(state.gatewayBase ?? DEFAULT_GATEWAY_BASE),
    routableProtocols: state.routableProtocols ?? DEFAULT_ROUTABLE_PROTOCOLS,
  };
  const db = dbInstance ?? getDb();
  if (db) {
    db.setAppState(ROUTING_STATE_KEY, value);
    cliLogger.info('ROUTING', `state saved to DB: gateway=${value.gatewayBase}`);
  } else {
    cliLogger.warn('ROUTING', 'DB not available, routing state not persisted');
  }
}

/** 读取当前 routing 状态（每次从 DB 现读，null = 未登录） */
export function getRoutingState(): RoutingState | null {
  const db = getDb();
  if (!db) return null;
  const value = db.getAppState(ROUTING_STATE_KEY) as RoutingState | undefined;
  if (!value || !value.gatewayBase) return null;
  const gatewayBase = canonicalizeGatewayBase(value.gatewayBase);
  if (gatewayBase !== value.gatewayBase.replace(/\/+$/, '')) {
    setRoutingState({ ...value, gatewayBase });
    return { ...value, gatewayBase };
  }
  return { ...value, gatewayBase };
}

/** 清除 routing 状态（登出时调用）→ 从 DB 删除 */
export function clearRoutingState(): void {
  const db = getDb();
  if (db) {
    db.deleteAppState(ROUTING_STATE_KEY);
    cliLogger.info('ROUTING', 'state cleared from DB');
  }
}

/**
 * 从旧 routing.json 迁移到 DB（向后兼容，启动时调一次）。
 * 如果 DB 里已有 routing state，跳过（auth 流程已写入）。
 * 如果 DB 里没有但文件有，迁移文件内容到 DB。
 */
export function migrateFromLegacyRoutingFile(filePath: string): boolean {
  if (getRoutingState()) return false;
  try {
    const fs = require('node:fs');
    if (!fs.existsSync(filePath)) return false;
    const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (content.gatewayBase && content.enabled !== false) {
      setRoutingState({
        enabled: content.enabled ?? true,
        gatewayBase: content.gatewayBase,
        routableProtocols: content.routableProtocols ?? DEFAULT_ROUTABLE_PROTOCOLS,
      });
      cliLogger.info('ROUTING', `migrated from legacy routing.json to DB: gateway=${content.gatewayBase}`);
      return true;
    }
  } catch {
    /* 文件不存在或损坏 — 正常 */
  }
  return false;
}
