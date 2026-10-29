/**
 * subscriptionState — main 进程缓存 renderer 推过来的订阅模型列表.
 *
 *   ── 为什么 ──
 *   订阅模型的权威数据在 NeoxCloud server, renderer 通过 membershipStore 拉取并 cache.
 *   但 mobile-bridge (跑在 electron main) 也要给手机端列订阅模型 — 它够不到 renderer state.
 *
 *   方案: renderer 每次 membership 刷新都通过 IPC 把扁平 model 列表 push 到这里,
 *   mobile-bridge wsServer 的 `model.list` RPC 直接读. main 不发起 HTTP, 不重复 fetch.
 *
 *   ── 数据形状 ──
 *   { modelId, displayName?, provider?, contextWindow?, supportsVision?, supportsThinking? }
 *   只是给手机 picker 渲染用, chat 路由 (providerId/modelName 拆解) 由 wsServer normalize 自己拼.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

export interface SubscriptionModel {
  modelId: string;
  displayName?: string;
  provider?: string;
  contextWindow?: number;
  supportsVision?: boolean;
  supportsThinking?: boolean;
  /** 额度消耗速度 (基准模型 = 1.0, 已含倍率) — 手机 picker 画消耗条, 跟桌面同一个数. */
  relativeCost?: number;
  /** 按量模型 (桌面「按量模型」开关打开时才有): 走 neox-cloud-payg, 只扣平台余额 */
  payAsYouGo?: boolean;
}

let cached: SubscriptionModel[] = [];
let lastUpdatedAt = 0;

const PAYG_CACHE_FILE = join(homedir(), NEOX_HOME_DIRNAME, 'payg-models.json');
function persistPaygModels(models: SubscriptionModel[]): void {
  try {
    const ids = [...new Set(models.filter((m) => m.payAsYouGo).map((m) => m.modelId).filter(Boolean))];
    mkdirSync(dirname(PAYG_CACHE_FILE), { recursive: true });
    writeFileSync(PAYG_CACHE_FILE, JSON.stringify({ updatedAt: Date.now(), models: ids }));
  } catch { /* 写不了就当没有, 子 agent 点名时回落到网关校验 */ }
}

export const subscriptionState = {
  setModels(models: SubscriptionModel[] | null): void {
    cached = Array.isArray(models) ? models.slice() : [];
    lastUpdatedAt = Date.now();
    persistPaygModels(cached);
  },
  getModels(): SubscriptionModel[] {
    return cached.slice();
  },
  getLastUpdatedAt(): number {
    return lastUpdatedAt;
  },
  clear(): void {
    cached = [];
    lastUpdatedAt = Date.now();
  },
};
