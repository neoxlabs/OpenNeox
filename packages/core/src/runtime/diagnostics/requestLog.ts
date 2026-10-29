import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { neoxHome } from '@neoxlabs/kernel/platform/neoxHome.js';

export type RequestKind = 'main' | 'sub' | 'side' | 'jev';

export type CacheBreakCode = 'system' | 'tools' | 'history' | 'expired' | 'upstream';

export interface RequestRecord {
  t: number;
  kind: RequestKind;
  /** 主请求 = 场景 / agent 名; 侧路 = 用途 (title / summary …); Jev = 问题名 */
  label: string;
  session?: string;
  model?: string;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  ms?: number;
  ok: boolean;
  error?: string;
  cacheBreak?: { code: CacheBreakCode; lost: number; detail?: string };
}

const MAX_LINES = 3000;
const TRIM_EVERY = 200;
let writesSinceTrim = 0;

export function requestLogPath(): string {
  return neoxHome('run', 'diagnostics.jsonl');
}

export function recordRequest(r: Omit<RequestRecord, 't'> & { t?: number }): void {
  /* 单测里会跑到真实调用链 (host / 侧路 / Jev 的测试), 不许往用户的 ~/.neox 里写假记录 */
  if (process.env.VITEST) return;
  try {
    const file = requestLogPath();
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ t: Date.now(), ...r }) + '\n');
    if (++writesSinceTrim >= TRIM_EVERY) {
      writesSinceTrim = 0;
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      if (lines.length > MAX_LINES) writeFileSync(file, lines.slice(-MAX_LINES).join('\n') + '\n');
    }
  } catch { /* 诊断写不进去不影响请求 */ }
}

export function readRequestLog(sinceMs = 0): RequestRecord[] {
  try {
    return readFileSync(requestLogPath(), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as RequestRecord; } catch { return null; } })
      .filter((r): r is RequestRecord => !!r && r.t >= sinceMs);
  } catch {
    return [];
  }
}

export interface RequestLogSummary {
  since: number;
  /** 主 agent + 子 agent 的请求: 缓存命中率 = cacheRead / input */
  agent: { count: number; input: number; cacheRead: number };
  /** 按类型: 次数 / 失败 / 平均耗时 (有耗时的才算) */
  kinds: Record<RequestKind, { count: number; fails: number; avgMs: number | null }>;
  /** 侧路 + Jev 按用途分组 */
  sideCalls: Array<{ kind: RequestKind; label: string; count: number; fails: number; avgMs: number | null; lastError?: string }>;
  breakCounts: Partial<Record<CacheBreakCode, number>>;
  /** 最近的缓存失效, 新的在前 */
  breaks: Array<{ t: number; label: string; model?: string; code: CacheBreakCode; lost: number; detail?: string }>;
}

export function summarizeRequests(records: RequestRecord[], since: number): RequestLogSummary {
  const kinds = {} as RequestLogSummary['kinds'];
  const msSum: Partial<Record<RequestKind, [number, number]>> = {};
  for (const k of ['main', 'sub', 'side', 'jev'] as RequestKind[]) kinds[k] = { count: 0, fails: 0, avgMs: null };
  const agent = { count: 0, input: 0, cacheRead: 0 };
  const groups = new Map<string, { kind: RequestKind; label: string; count: number; fails: number; ms: number; msN: number; lastError?: string }>();
  const breakCounts: RequestLogSummary['breakCounts'] = {};
  const breaks: RequestLogSummary['breaks'] = [];
  for (const r of records) {
    const k = kinds[r.kind];
    if (!k) continue;
    k.count++;
    if (!r.ok) k.fails++;
    if (typeof r.ms === 'number') { const s = (msSum[r.kind] ??= [0, 0]); s[0] += r.ms; s[1]++; }
    if (r.kind === 'main' || r.kind === 'sub') {
      agent.count++;
      agent.input += r.input ?? 0;
      agent.cacheRead += r.cacheRead ?? 0;
    } else {
      const key = `${r.kind}:${r.label}`;
      const g = groups.get(key) ?? { kind: r.kind, label: r.label, count: 0, fails: 0, ms: 0, msN: 0 };
      g.count++;
      if (!r.ok) { g.fails++; g.lastError = r.error; }
      if (typeof r.ms === 'number') { g.ms += r.ms; g.msN++; }
      groups.set(key, g);
    }
    if (r.cacheBreak) {
      breakCounts[r.cacheBreak.code] = (breakCounts[r.cacheBreak.code] ?? 0) + 1;
      breaks.push({ t: r.t, label: r.label, model: r.model, ...r.cacheBreak });
    }
  }
  for (const [k, s] of Object.entries(msSum)) kinds[k as RequestKind].avgMs = s[1] ? Math.round(s[0] / s[1]) : null;
  return {
    since,
    agent,
    kinds,
    sideCalls: [...groups.values()]
      .map((g) => ({ kind: g.kind, label: g.label, count: g.count, fails: g.fails, avgMs: g.msN ? Math.round(g.ms / g.msN) : null, lastError: g.lastError }))
      .sort((a, b) => b.count - a.count),
    breakCounts,
    breaks: breaks.reverse().slice(0, 40),
  };
}

/** 这么久没请求, 上游缓存多半已经过期 (各家 TTL 5 分钟起) */
const EXPIRE_GAP_MS = 5 * 60_000;

export function classifyCacheBreak(
  prefix: { systemChanged?: boolean; toolsChanged?: boolean; firstDivergentMsgIdx?: number; divergentRole?: string; sysDiff?: { curSnip?: string } } | null | undefined,
  gapMs: number,
): { code: CacheBreakCode; detail?: string } {
  if (prefix?.systemChanged) return { code: 'system', detail: prefix.sysDiff?.curSnip?.slice(0, 120) };
  if (prefix?.toolsChanged) return { code: 'tools' };
  if (prefix && typeof prefix.firstDivergentMsgIdx === 'number' && prefix.firstDivergentMsgIdx >= 0) {
    return { code: 'history', detail: `#${prefix.firstDivergentMsgIdx}${prefix.divergentRole ? ` ${prefix.divergentRole}` : ''}` };
  }
  if (gapMs >= EXPIRE_GAP_MS) return { code: 'expired', detail: `${Math.round(gapMs / 60_000)}m` };
  return { code: 'upstream' };
}
