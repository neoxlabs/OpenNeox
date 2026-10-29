/**
 * 授权账本 —— 用户授予了哪些能力、对哪些点过「不再询问」、花了多少钱
 *
 *   存在 `~/.neox/plugins/grants.json`。这张表是「安装」这个概念的实体:
 *   没有它, 权限、升级二次同意、卸载全都无从谈起 —— 只有一个下载计数。
 *
 *   为什么是同步读写
 *   ----------------
 *   闸门在每次工具调用的热路径上, 做成 async 会让 gate 的调用方全部染上
 *   await, 而这个文件是几 KB 量级、只在授权变更时写。同步换来的是一个
 *   可以在任何位置直接调用的纯函数式闸门。
 *
 *   installationId 的口径
 *   ---------------------
 *   桌面端一台机器一个用户, 所以直接用插件名做 installationId。将来云端多
 *   用户时换成 `${userId}:${pluginName}`, 这一层接口不用动。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { CapabilityId } from '@neoxlabs/platform/shared/plugin-connector.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

const GRANTS_FILE = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'plugins', 'grants.json');

type GrantRecord = {
  /** 安装时用户勾选授予的能力 */
  granted: string[];
  /** 用户点过「不再询问」的能力 */
  remembered: string[];
  /** costly 能力的预算上限 (USD); 缺省不限 */
  budgetUsd?: number;
  /** 已花费 (USD) */
  spentUsd?: number;
  /** 授权时间, 供 UI 展示与升级 diff */
  grantedAt?: string;
};

type GrantsFile = {
  version: 1;
  installations: Record<string, GrantRecord>;
};

export type GrantStore = {
  isGranted(installationId: string, capability: CapabilityId): boolean;
  isRemembered(installationId: string, capability: CapabilityId): boolean;
  remember(installationId: string, capability: CapabilityId): void;
};

export type BudgetStore = {
  /** 剩余额度 (USD)。Infinity 表示不限。 */
  remainingUsd(installationId: string): number;
  charge(installationId: string, usd: number): void;
};

// ============================================================================
// 持久化
// ============================================================================

let cache: GrantsFile | null = null;
let cacheMtimeMs = -1;

function fileMtimeMs(): number {
  try { return fs.statSync(GRANTS_FILE).mtimeMs; } catch { return 0; }
}

function load(): GrantsFile {
  const mtime = fileMtimeMs();
  if (cache && mtime === cacheMtimeMs) return cache;
  try {
    const raw = fs.readFileSync(GRANTS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as GrantsFile;
    cache = parsed?.installations ? parsed : { version: 1, installations: {} };
  } catch {
    cache = { version: 1, installations: {} };
  }
  cacheMtimeMs = mtime;
  return cache;
}

function persist(): void {
  if (!cache) return;
  try {
    fs.mkdirSync(path.dirname(GRANTS_FILE), { recursive: true });
    fs.writeFileSync(GRANTS_FILE, JSON.stringify(cache, null, 2), 'utf-8');
    cacheMtimeMs = fileMtimeMs();
  } catch { /* 写失败不该拖垮调用方 —— 最坏结果是下次重新问一遍用户 */ }
}

function recordOf(installationId: string): GrantRecord {
  const data = load();
  if (!data.installations[installationId]) {
    data.installations[installationId] = { granted: [], remembered: [] };
  }
  return data.installations[installationId];
}

/** 测试用: 丢弃内存缓存, 下次访问重新读盘 */
export function __resetGrantCache(): void {
  cache = null;
  cacheMtimeMs = -1;
}

// ============================================================================
// 授权读写
// ============================================================================

export const grantStore: GrantStore = {
  isGranted: (id, cap) => recordOf(id).granted.includes(cap),
  isRemembered: (id, cap) => recordOf(id).remembered.includes(cap),
  remember: (id, cap) => {
    const rec = recordOf(id);
    if (!rec.remembered.includes(cap)) {
      rec.remembered.push(cap);
      persist();
    }
  },
};

export const budgetStore: BudgetStore = {
  remainingUsd: (id) => {
    const rec = recordOf(id);
    if (rec.budgetUsd === undefined) return Infinity;
    return rec.budgetUsd - (rec.spentUsd ?? 0);
  },
  charge: (id, usd) => {
    const rec = recordOf(id);
    rec.spentUsd = (rec.spentUsd ?? 0) + usd;
    persist();
  },
};

/**
 * 安装 / 升级时写入用户授予的能力集合。
 *
 *   这里是**全量覆盖**而不是合并: 升级时若新版本少要了某项能力, 旧授权必须
 *   随之消失。反过来新增能力必须由调用方先弹权限 diff 拿到同意 —— 「装的时候
 *   人畜无害, 更新时提权」是市场类攻击最核心的一条路径。
 */
export function setGrants(
  installationId: string,
  capabilities: CapabilityId[],
  options?: { budgetUsd?: number },
): void {
  const data = load();
  const prev = data.installations[installationId];
  data.installations[installationId] = {
    granted: [...new Set(capabilities as string[])],
    /* 记住的选择只在仍被授予的能力上保留 */
    remembered: (prev?.remembered ?? []).filter(c => capabilities.includes(c as CapabilityId)),
    budgetUsd: options?.budgetUsd ?? prev?.budgetUsd,
    spentUsd: prev?.spentUsd,
    grantedAt: new Date().toISOString(),
  };
  persist();
}

export function getGrants(installationId: string): CapabilityId[] {
  return recordOf(installationId).granted as CapabilityId[];
}

export function revokeGrants(installationId: string): void {
  const data = load();
  delete data.installations[installationId];
  persist();
}

export function setBudget(installationId: string, budgetUsd: number | undefined): void {
  const rec = recordOf(installationId);
  rec.budgetUsd = budgetUsd;
  persist();
}

export function getBudgetState(installationId: string): { budgetUsd?: number; spentUsd: number } {
  const rec = recordOf(installationId);
  return { budgetUsd: rec.budgetUsd, spentUsd: rec.spentUsd ?? 0 };
}

/**
 * 升级时算权限 diff。
 *
 *   返回新版本要求、但用户还没授予过的能力 —— 非空就必须重新征得同意。
 */
export function newPermissionsSince(
  installationId: string,
  required: CapabilityId[],
): CapabilityId[] {
  const granted = new Set(getGrants(installationId));
  return required.filter(c => !granted.has(c));
}
