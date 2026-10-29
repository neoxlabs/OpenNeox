/**
 * PROMPT-07 · system 段字节稳定看板 —— **纯度量, 不拦任何请求**。
 *
 * 依据: `内部设计文档` §3.3-C 与 `内部设计文档` 第三节。
 * 裁决明确: 同会话内 system 本来就稳定, 环境信息不搬家; 缺的是「能不能看见它稳不稳」。
 * 所以这里只记录两件事, 一次请求一笔:
 *
 *   · system 前缀 hash —— 每轮实际发出去的那份 (agenticRuntime 冻结后的串)
 *   · token 用量 —— prompt / 命中缓存的部分 (runtimeOrchestrator 的 token_usage)
 *
 * 由它们算出 PROMPT-07 的两个验收数:
 *   `systemHashChanges` (同会话连续 5 轮应为 0) 与 `cacheHitRate` (≥80%)。
 *
 * 落盘原因: runtime 跑在 worker 进程里, 而 `/stats` 在 CLI / 主进程 —— 内存里的数它们看不见。
 * 按行追加到 `~/.neox/run/prefix-stability.jsonl`, 跟 diagnostics.jsonl 同一个范式;
 * 写失败一律静默, 度量绝不能影响请求本身。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { neoxHome } from '@neoxlabs/kernel/platform/neoxHome.js';

export interface PrefixStabilityStats {
  sessionId: string;
  /** 记录到的轮数 (每轮一次请求级 system 快照) */
  turns: number;
  /** system 前缀 hash 变化的次数 —— PROMPT-07 的主指标 */
  systemHashChanges: number;
  /** 最近一轮 system 字符数 */
  systemChars: number;
  /** 输入 token 总量 (含命中缓存的部分) */
  inputTokens: number;
  /** 其中命中缓存的部分 */
  cacheHitTokens: number;
  /** cacheHitTokens / inputTokens, 没有样本时为 null */
  cacheHitRate: number | null;
}

interface ProbeRecord {
  t: number;
  s: string;
  k: 'turn' | 'usage';
  /** turn: 前缀 hash */
  h?: string;
  /** turn: system 字符数 */
  c?: number;
  /** turn: 相比上一轮是否变了 */
  ch?: 0 | 1;
  /** usage: 输入 token (含缓存) */
  i?: number;
  /** usage: 命中缓存 token */
  cache?: number;
}

interface SessionState {
  turns: number;
  systemHashChanges: number;
  systemChars: number;
  inputTokens: number;
  cacheHitTokens: number;
  lastHash?: string;
}

const MAX_LINES = 6000;
const KEEP_LINES = 4000;
const TRIM_EVERY = 200;

const sessions = new Map<string, SessionState>();
let writesSinceTrim = 0;

function probePath(): string {
  /* 测试可指向临时文件, 不去读用户真实的 ~/.neox (与 NEOX_HOME_DIRNAME 同样的显式覆盖思路) */
  return process.env.NEOX_PREFIX_PROBE_FILE || neoxHome('run', 'prefix-stability.jsonl');
}

/** 单测会跑到真实调用链 —— 不许往用户的 ~/.neox 里写假记录 (同 requestLog 的做法)。 */
function persistenceEnabled(): boolean {
  return !process.env.VITEST && process.env.NEOX_PREFIX_PROBE !== '0';
}

function appendRecord(record: ProbeRecord): void {
  if (!persistenceEnabled()) return;
  try {
    const file = probePath();
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`);
    if (++writesSinceTrim >= TRIM_EVERY) {
      writesSinceTrim = 0;
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      if (lines.length > MAX_LINES) writeFileSync(file, `${lines.slice(-KEEP_LINES).join('\n')}\n`);
    }
  } catch { /* 度量写不进去不影响请求 */ }
}

function emptyState(): SessionState {
  return { turns: 0, systemHashChanges: 0, systemChars: 0, inputTokens: 0, cacheHitTokens: 0 };
}

function hashPrompt(prompt: string): string {
  return createHash('sha1').update(prompt).digest('hex').slice(0, 16);
}

/**
 * 记一轮 system 前缀, **返回本轮 hash** —— 调用方直接拿它做日志, 不在热路径多算一次。
 * 内容跟上一轮相同就不算 changes; 会话第一轮没有比较对象, 也不算变化。
 */
export function recordSystemPrefix(sessionId: string, systemPrompt: string): string {
  const hash = hashPrompt(systemPrompt);
  const state = sessions.get(sessionId) ?? emptyState();
  const changed = state.lastHash !== undefined && state.lastHash !== hash;
  state.turns += 1;
  state.systemChars = systemPrompt.length;
  if (changed) state.systemHashChanges += 1;
  state.lastHash = hash;
  sessions.set(sessionId, state);
  appendRecord({ t: Date.now(), s: sessionId, k: 'turn', h: hash, c: systemPrompt.length, ch: changed ? 1 : 0 });
  return hash;
}

/** 记一次请求的用量。`inputTokens` 应含命中缓存的部分 (调用方自己相加, 与预算记账同口径)。 */
export function recordPrefixTokenUsage(sessionId: string, inputTokens: number, cacheHitTokens: number): void {
  const input = Math.max(0, Math.floor(inputTokens || 0));
  const cached = Math.min(input, Math.max(0, Math.floor(cacheHitTokens || 0)));
  const state = sessions.get(sessionId) ?? emptyState();
  state.inputTokens += input;
  state.cacheHitTokens += cached;
  sessions.set(sessionId, state);
  appendRecord({ t: Date.now(), s: sessionId, k: 'usage', i: input, cache: cached });
}

function toStats(sessionId: string, state: SessionState): PrefixStabilityStats {
  return {
    sessionId,
    turns: state.turns,
    systemHashChanges: state.systemHashChanges,
    systemChars: state.systemChars,
    inputTokens: state.inputTokens,
    cacheHitTokens: state.cacheHitTokens,
    cacheHitRate: state.inputTokens > 0
      ? Number((state.cacheHitTokens / state.inputTokens).toFixed(4))
      : null,
  };
}

/** 进程内看板 (runtime worker 自己用; 没有记录返回 null)。 */
export function getPrefixStabilityStats(sessionId: string): PrefixStabilityStats | null {
  const state = sessions.get(sessionId);
  return state ? toStats(sessionId, state) : null;
}

/** 从落盘记录聚合 —— 给 /stats 这类**别的进程**的读方用。 */
export function readPrefixStabilityStats(sessionId: string): PrefixStabilityStats | null {
  if (!sessionId) return null;
  let records: ProbeRecord[];
  try {
    records = readFileSync(probePath(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ProbeRecord)
      .filter((r) => r && r.s === sessionId);
  } catch {
    return null;
  }
  if (!records.length) return null;
  const state = emptyState();
  for (const record of records) {
    if (record.k === 'turn') {
      state.turns += 1;
      if (record.ch === 1) state.systemHashChanges += 1;
      state.systemChars = record.c ?? state.systemChars;
    } else if (record.k === 'usage') {
      state.inputTokens += Math.max(0, record.i ?? 0);
      state.cacheHitTokens += Math.max(0, record.cache ?? 0);
    }
  }
  return toStats(sessionId, state);
}

/** `/stats` 用的一行摘要; 没有可展示的数据时返回空串。 */
export function formatPrefixStabilityLine(stats: PrefixStabilityStats, zh: boolean): string {
  if (!stats.turns) return '';
  const hit = stats.cacheHitRate === null ? 'n/a' : `${Math.round(stats.cacheHitRate * 100)}%`;
  return zh
    ? `${stats.turns} 轮 · system 变更 ${stats.systemHashChanges} 次 · 缓存命中 ${hit}`
    : `${stats.turns} turns · ${stats.systemHashChanges} system changes · ${hit} cached`;
}

/** 仅供测试: 清空进程内状态。 */
export function __resetPrefixStabilityProbeForTests(): void {
  sessions.clear();
}
