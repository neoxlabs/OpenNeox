/**
 * Agent Runtime Config Accessor — "config 优先 · env var fallback · 默认值兜底"
 *
 * 为什么不直接让业务代码读 loadConfig()?
 *   · 每次读都要 I/O(loadConfig 从磁盘读 JSON)— 慢
 *   · 业务代码还想看 env var(CI/troubleshoot 临时覆盖)
 *   · 一个地方集中策略,未来 UI 设置页也只调 setter 就触发热刷新
 *
 * 三级优先级:
 *   1. 环境变量(最高,临时覆盖)
 *   2. NeoxConfig.agentRuntime.* 字段(用户在 ~/.neox/config.json 持久化设置 或 UI 调整)
 *   3. 代码默认值(安全缺省)
 */

import type { AgentRuntimeConfig } from '../utils/config.js';
import { loadConfig } from '../utils/config.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { threadId, isMainThread } from 'node:worker_threads';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

// ────────────────────────────────────────────────────────────
// 缓存:避免每次 I/O。进程启动后一次加载,UI 改动可通过 refreshAgentRuntimeConfig() 热刷。
// ────────────────────────────────────────────────────────────

let cached: AgentRuntimeConfig | null = null;
let cachedAt = 0;

const CACHE_TTL_MS = 2_000;

function diagThread(event: string, extra?: Record<string, unknown>): void {
  if (process.env.NEOX_DIAG_LOG !== '1' && process.env.NEOX_DIAG_LOG !== 'explore') return;
  try {
    const line = `[${new Date().toISOString()}] [RT_CONFIG_${event}] ${JSON.stringify({
      pid: process.pid, threadId, isMain: isMainThread, ...extra,
    })}\n`;
    fs.appendFileSync(path.join(os.homedir(), NEOX_HOME_DIRNAME, 'logs', 'explore-debug.log'), line);
  } catch { /* 诊断不能拖累正常路径 */ }
}

function readConfig(): AgentRuntimeConfig {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;
  try {
    const full = loadConfig();
    cached = full.agentRuntime ?? {};
    cachedAt = Date.now();
    diagThread('LOAD', { osSandboxEnabled: cached.osSandbox?.enabled ?? null, ptyEnabled: cached.pty?.enabled ?? null });
  } catch (err: any) {
    cliLogger.debug('AGENT_RT_CONFIG', `loadConfig failed (using defaults): ${err?.message ?? err}`);
    cached = {};
    cachedAt = Date.now();   /* 读盘失败也记时间, 否则每次调用都重试 I/O */
  }
  return cached;
}

/** UI 改动 / 测试场景重置缓存 */
export function refreshAgentRuntimeConfig(): void {
  diagThread('REFRESH');
  cached = null;
  cachedAt = 0;
}

// ────────────────────────────────────────────────────────────
// 对外 API — 每项一个 getter,签名稳定
// ────────────────────────────────────────────────────────────

/** OS 级沙箱是否启用 */
export function isOsSandboxEnabled(): boolean {
  const env = process.env.NEOX_OS_SANDBOX;
  if (env === 'on') return true;
  if (env === 'off') return false;
  // 兼容老 env var NEOX_SANDBOX=on(命令白名单沙箱开启时一起启用 OS 沙箱)
  if (process.env.NEOX_SANDBOX === 'on') return true;
  return readConfig().osSandbox?.enabled === true;  // 默认 false
}

/** OS 沙箱等级 (旧词汇, 保留兼容) */
export function getOsSandboxLevel(): 'strict' | 'moderate' | 'permissive' {
  const env = process.env.NEOX_SANDBOX_LEVEL;
  if (env === 'strict' || env === 'moderate' || env === 'permissive') return env;
  return readConfig().osSandbox?.level ?? 'moderate';
}

/**
 * OS 沙箱逻辑档 —— **单一真源** (mode 词汇, 与 SandboxMode / CLI 对齐)。
 * 优先 config.osSandbox.mode; 回落老 level 映射; 默认 workspace-write。
 * 桌面 UI 与 `neox sandbox <mode>` CLI 都写这个字段, OS 强制 + 工具类别门禁都读它。
 */
export function getOsSandboxMode(): 'read-only' | 'workspace-write' | 'danger-full-access' {
  const env = process.env.NEOX_SANDBOX_MODE;
  if (env === 'read-only' || env === 'workspace-write' || env === 'danger-full-access') return env;
  const cfg = readConfig().osSandbox as { mode?: string; level?: string } | undefined;
  if (cfg?.mode === 'read-only' || cfg?.mode === 'workspace-write' || cfg?.mode === 'danger-full-access') {
    return cfg.mode;
  }
  // 回落: 老 level → mode (strict=只读; moderate/permissive=工作区写, permissive 的"放网"由 allowNetwork 表达)
  if (cfg?.level === 'strict') return 'read-only';
  return 'workspace-write';
}

/** OS 沙箱是否允许网络 */
export function isOsSandboxNetworkAllowed(): boolean {
  if (process.env.NEOX_SANDBOX_NETWORK === 'off') return false;
  const cfg = readConfig().osSandbox?.allowNetwork;
  return cfg !== false;  // 默认 true
}

/** 前台命令超时转后台(adoptOnTimeout)— 默认开 */
export function isAdoptOnTimeoutEnabled(): boolean {
  if (process.env.NEOX_DISABLE_FG_ADOPT === '1') return false;
  const cfg = readConfig().adoptOnTimeout?.enabled;
  return cfg !== false;  // 默认 true
}

/** PTY 是否启用 — 默认开(不可用时 ptyExecutor 自己 fallback 到 execa)*/
export function isPtyEnabled(): boolean {
  if (process.env.NEOX_DISABLE_PTY === '1') return false;
  const cfg = readConfig().pty?.enabled;
  return cfg !== false;  // 默认 true
}

/** OS 系统通知 — 默认开 */
export function isOsNotificationsEnabled(): boolean {
  if (process.env.NEOX_OS_NOTIFICATIONS === 'off') return false;
  if (process.env.NEOX_QUIET === '1') return false;
  const cfg = readConfig().osNotifications?.enabled;
  return cfg !== false;  // 默认 true
}

/** Sub-agent 最大递归深度 — 默认 3 */
export function getMaxThreadDepth(): number {
  const envVal = Number(process.env.NEOX_MAX_AGENT_THREAD_DEPTH);
  if (Number.isInteger(envVal) && envVal >= 0) return envVal;
  const cfg = readConfig().threadDepth?.max;
  if (typeof cfg === 'number' && Number.isInteger(cfg) && cfg >= 0) return cfg;
  return 3;
}

export function getRolloutDir(): string | null {
  const envVal = process.env.NEOX_ROLLOUT_DIR;
  if (envVal) return envVal;
  const cfg = readConfig().rollout?.dir;
  return cfg ?? null;
}

/** 前台 bash 默认超时 */
export function getBashDefaultTimeoutMs(): number {
  const envVal = Number(process.env.NEOX_BASH_DEFAULT_TIMEOUT_MS || process.env.BASH_DEFAULT_TIMEOUT_MS);
  if (Number.isFinite(envVal) && envVal > 0) return envVal;
  const cfg = readConfig().bashTimeout?.defaultMs;
  if (typeof cfg === 'number' && cfg > 0) return cfg;
  return 120_000;
}

/** 前台 bash 最大超时上限 */
export function getBashMaxTimeoutMs(): number {
  const envVal = Number(process.env.NEOX_BASH_MAX_TIMEOUT_MS || process.env.BASH_MAX_TIMEOUT_MS);
  if (Number.isFinite(envVal) && envVal > 0) return envVal;
  const cfg = readConfig().bashTimeout?.maxMs;
  if (typeof cfg === 'number' && cfg > 0) return cfg;
  return 600_000;
}

/** Agent 的提交带不带 Neox 署名 — 默认开 */
export function isGitCoAuthorEnabled(): boolean {
  return readConfig().gitCoAuthor?.enabled !== false;
}

/** 细粒度 ApprovalCache 是否启用 — 默认开 */
export function isApprovalCacheEnabled(): boolean {
  const cfg = readConfig().approvalCache?.enabled;
  return cfg !== false;  // 默认 true
}

/**
 * 智能模型编排 (Team P1 能力 1) — 'on' 时 runtimeBuilder 向 system prompt 注入编排知识段。
 * 默认 **off** (发布稳定优先)。设置页开关写 config 后走 refreshAgentRuntimeConfig 热刷,
 * dynamicSystemPromptProvider 每轮重读 → 开关中途切换下一轮即生效。
 */
export function getModelOrchestrationMode(): 'off' | 'on' {
  const env = process.env.NEOX_MODEL_ORCHESTRATION;
  if (env === 'on') return 'on';
  if (env === 'off') return 'off';
  return readConfig().modelOrchestration === 'on' ? 'on' : 'off';
}
