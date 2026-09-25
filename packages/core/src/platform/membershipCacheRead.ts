/**
 * membershipCacheRead — 只读 membership 缓存 (跨进程共享的那一份)
 *
 * 为什么是"读文件"而不是"再拉一次 / 新开 IPC":
 *   登录后 CLI 侧 (neox-cli/auth/membershipCache.ts) 已经把 /api/v1/membership/me
 *   的结果落到 `~/.neox/membership-cache.json`, 桌面选择器里那 19 个订阅模型就是它。
 *   agent server 是**独立进程**, 但读的是同一个 home 下的同一个文件 —— 零网络、
 *   零新通道、也不会跟 CLI 的刷新逻辑打架 (这里只读, 从不写)。
 *
 * 谁刷新: 登录完成 / token 轮换 / 用户手动刷新, 都由 CLI 侧那份负责。
 * 这里**故意不做兜底拉取** —— 拉不到就当没有, 让上层回落到"不列任何模型",
 * 而不是自己再发一条网络请求把刷新逻辑变成两处。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

/** 跟 neox-cli/auth/membershipCache.ts 的 CACHE_FILE 必须一致 */
const CACHE_FILE = join(homedir(), NEOX_HOME_DIRNAME, 'membership-cache.json');

export interface CachedMembershipModel {
  modelId: string;
  displayName?: string;
  family?: string;
  allowed?: boolean;
  included?: boolean;
  /** 'image' = 出图模型 (server 由 models.image_billing_mode 派生). 老 server 不返. */
  modality?: 'chat' | 'image';
}

/** 在任意嵌套结构里找那个 models 数组 —— 缓存外层包了 snapshot/membership 几层, 不写死路径 */
function findModels(node: unknown, depth = 0): CachedMembershipModel[] | null {
  if (depth > 6 || node === null || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  const direct = obj.models;
  if (Array.isArray(direct) && direct.every((x) => x && typeof x === 'object')) {
    return direct as CachedMembershipModel[];
  }
  for (const v of Object.values(obj)) {
    const hit = findModels(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** 读缓存里的模型清单. 文件缺失 / 坏 JSON / 结构变了 一律返 []. */
export function readCachedMembershipModels(): CachedMembershipModel[] {
  try {
    if (!existsSync(CACHE_FILE)) return [];
    const parsed = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as unknown;
    return findModels(parsed) ?? [];
  } catch {
    return [];
  }
}

/**
 * 这个用户**当前订阅下真的能用**的出图模型 id。
 *
 * 判据只认 server 下发的 `modality === 'image'` —— 不按模型名猜。
 * 老 server 还没下发这个字段时返 [] , 上层会回落到"不列任何模型, 也别编造 id":
 * 少说一句话, 好过报一个选了就 no gateway channel available 的假选项。
 */
export function readAvailableCloudImageModels(): string[] {
  const out: string[] = [];
  for (const m of readCachedMembershipModels()) {
    if (m?.allowed === false) continue;
    if (m?.modality !== 'image') continue;
    const id = String(m.modelId ?? '').trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

export function readPlanMaxConcurrentAgents(): number | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const parsed = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as unknown;
    const plan = findPlan(parsed);
    const raw = (plan as Record<string, unknown> | null)?.maxConcurrentAgents;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) return null;
    return Math.floor(n);
  } catch {
    return null;
  }
}

export function readPlanMaxParallelSessions(): number | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const parsed = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as unknown;
    const n = Number((findPlan(parsed) as Record<string, unknown> | null)?.maxParallelSessions);
    if (!Number.isFinite(n) || n < 1) return null;
    return Math.floor(n);
  } catch {
    return null;
  }
}

/** 跟 findModels 同样的策略: 不写死嵌套路径 (缓存外层包了 snapshot/membership 几层)。 */
function findPlan(node: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 6 || node === null || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  const direct = obj.plan;
  /* 认"长得像 plan 的对象" —— 有 id 就够了; 只判 typeof object 会把 planId 字符串也认进来 */
  if (direct && typeof direct === 'object' && !Array.isArray(direct)
      && typeof (direct as Record<string, unknown>).id === 'string') {
    return direct as Record<string, unknown>;
  }
  for (const v of Object.values(obj)) {
    const hit = findPlan(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}
