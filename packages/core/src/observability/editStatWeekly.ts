/**
 * EDIT_STAT 周看板 (VERIFY-08)
 *
 * ── 为什么需要 ──────────────────────────────────────────────────────────────
 * edit 的成功/失败一直在记账 (editFileTool.ts 写 EDIT_STAT 到 ~/.neox/logs/stall.log),
 * 但**没有任何聚合**: 想知道"这周 edit 成功率多少、失败里哪一类最多", 只能手动 grep
 * 十几万行日志再数。于是"改坏率"看不见, 质量好不好全凭感觉。
 *
 * 这里把 stall.log 里的 EDIT_STAT 行读出来, 按自然周聚合:
 *   · 总次数 / 成功 / 失败 / 成功率 (目标 ≥98%)
 *   · 失败按分诊类型拆分 (unread / stale / match / ambiguous / not_found …)
 *   · 恢复类 (recovered > 0) 单独计数 —— 它们算成功, 但是"带着容错成功", 值得盯着
 *
 * ── 口径 ────────────────────────────────────────────────────────────────────
 * 只认 tag === 'EDIT_STAT' 的行:
 *   成功  message 以 `edit ok:` 开头
 *   失败  message 以 `edit failed:` 开头, 冒号后是 errorCode
 * 其它行 (COMPACT_STAT / LEDGER_REBUILD …) 一律忽略。无法解析的行只计入 badLines,
 * 不计入分子分母 —— 宁少不虚。
 *
 * 纯函数 + 显式传入文本, 方便测试; CLI 侧读 getStallLogPath() 即可。
 */

export interface EditStatRecord {
  /** 记录时间 (ms)。无法解析时间的行为 null, 会被丢弃。 */
  ts: number;
  ok: boolean;
  /** 失败时的分诊类型 (unread / stale / match_failed / ambiguous_match …) */
  errorCode?: string;
  /** 成功时: 是否走了容错恢复 (recovered > 0) */
  recovered?: boolean;
}

export interface EditStatWeek {
  /** 周标识 `YYYY-Www` (ISO 周) */
  key: string;
  /** 该周周一 00:00 本地时间 (ms) */
  weekStartMs: number;
  total: number;
  ok: number;
  failed: number;
  /** 成功率 (0-100, 保留一位小数); total=0 时为 null */
  successRate: number | null;
  /** 失败分诊类型 → 次数, 降序 */
  failuresByCode: Array<{ code: string; count: number }>;
  /** 带着容错恢复成功的次数 (已计入 ok) */
  recovered: number;
}

export interface EditStatReport {
  weeks: EditStatWeek[];
  /** 全部周的合计 */
  overall: Omit<EditStatWeek, 'key' | 'weekStartMs'>;
  /** 解析不了的行数 (诊断用: 突然变多说明日志格式变了) */
  badLines: number;
}

/** 一条 stall.log 行的最小形状 (只取用得到的字段) */
interface StallLine {
  ts?: unknown;
  tag?: unknown;
  message?: unknown;
  recovered?: unknown;
}

/** 解析一行 EDIT_STAT, 不是 EDIT_STAT 返回 null。 */
export function parseEditStatLine(line: string): EditStatRecord | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;
  let obj: StallLine;
  try {
    obj = JSON.parse(trimmed) as StallLine;
  } catch {
    return null;
  }
  if (obj?.tag !== 'EDIT_STAT') return null;
  const message = typeof obj.message === 'string' ? obj.message : '';
  const ts = typeof obj.ts === 'string' ? Date.parse(obj.ts) : NaN;
  if (!Number.isFinite(ts)) return null;

  if (message.startsWith('edit ok:')) {
    /* already_done 也是成功 (事情已经做好了), recovered 由字段给 */
    return {
      ts,
      ok: true,
      recovered: typeof obj.recovered === 'number' ? obj.recovered > 0 : false,
    };
  }
  if (message.startsWith('edit failed:')) {
    const code = message.slice('edit failed:'.length).trim() || 'unknown';
    return { ts, ok: false, errorCode: code };
  }
  /* tag 对但 message 不认识 —— 格式漂了, 交给调用方计 badLines */
  return null;
}

/** 解析整份日志文本。返回记录 + 无法解析的 EDIT_STAT 行数。 */
export function parseEditStatLog(text: string): { records: EditStatRecord[]; badLines: number } {
  const records: EditStatRecord[] = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    /* 先粗筛, 避免对每一行都 JSON.parse (stall.log 动辄几十万行) */
    if (!trimmed.includes('"EDIT_STAT"')) continue;
    const rec = parseEditStatLine(trimmed);
    if (rec) records.push(rec);
    else badLines++;
  }
  return { records, badLines };
}

/** 该时间点所在周的周一 00:00 (本地时区) —— 用户看到的"周"是他自己的周。 */
export function weekStartOf(ts: number): number {
  const d = new Date(ts);
  const day = d.getDay();                 // 0=Sun … 6=Sat
  const sinceMonday = (day + 6) % 7;      // Mon→0, Sun→6
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - sinceMonday);
  return d.getTime();
}

/** ISO 周标识 `YYYY-Www` (跨年周按 ISO 规则归属, 用周四所在年)。 */
export function weekKeyOf(ts: number): string {
  const d = new Date(weekStartOf(ts));
  const thursday = new Date(d);
  thursday.setDate(d.getDate() + 3);      // 周一 + 3 天 = 周四
  const isoYear = thursday.getFullYear();
  const jan1 = new Date(isoYear, 0, 1);
  const week = Math.floor((thursday.getTime() - weekStartOf(jan1.getTime())) / (7 * 86_400_000)) + 1;
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

function emptyWeek(key: string, weekStartMs: number): EditStatWeek {
  return {
    key,
    weekStartMs,
    total: 0,
    ok: 0,
    failed: 0,
    successRate: null,
    failuresByCode: [],
    recovered: 0,
  };
}

function finalizeWeek(w: EditStatWeek): EditStatWeek {
  w.successRate = w.total > 0 ? Math.round((w.ok / w.total) * 1000) / 10 : null;
  return w;
}

/**
 * 按周聚合。
 * @param records   解析出的记录
 * @param options.weeks 只保留最近 N 周 (含当前周); 不传 = 全部
 * @param options.now   当前时间 (测试注入)
 */
export function aggregateEditStatsByWeek(
  records: EditStatRecord[],
  options: { weeks?: number; now?: number; badLines?: number } = {},
): EditStatReport {
  const buckets = new Map<string, EditStatWeek>();
  const codeCounts = new Map<string, Map<string, number>>();

  for (const rec of records) {
    const start = weekStartOf(rec.ts);
    const key = weekKeyOf(rec.ts);
    let w = buckets.get(key);
    if (!w) {
      w = emptyWeek(key, start);
      buckets.set(key, w);
      codeCounts.set(key, new Map());
    }
    w.total++;
    if (rec.ok) {
      w.ok++;
      if (rec.recovered) w.recovered++;
    } else {
      w.failed++;
      const code = rec.errorCode || 'unknown';
      const m = codeCounts.get(key)!;
      m.set(code, (m.get(code) ?? 0) + 1);
    }
  }

  let weeks = [...buckets.values()].sort((a, b) => b.weekStartMs - a.weekStartMs);
  for (const w of weeks) {
    const m = codeCounts.get(w.key);
    w.failuresByCode = m
      ? [...m.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count)
      : [];
    finalizeWeek(w);
  }

  if (options.weeks && options.weeks > 0) {
    const now = options.now ?? Date.now();
    /* 从"当前周"往前数 N 周 —— 空周不补, 只裁剪范围 */
    const oldestStart = weekStartOf(now) - (options.weeks - 1) * 7 * 86_400_000;
    weeks = weeks.filter((w) => w.weekStartMs >= oldestStart);
  }

  const overall: Omit<EditStatWeek, 'key' | 'weekStartMs'> = {
    total: 0,
    ok: 0,
    failed: 0,
    successRate: null,
    failuresByCode: [],
    recovered: 0,
  };
  const overallCodes = new Map<string, number>();
  for (const w of weeks) {
    overall.total += w.total;
    overall.ok += w.ok;
    overall.failed += w.failed;
    overall.recovered += w.recovered;
    for (const { code, count } of w.failuresByCode) {
      overallCodes.set(code, (overallCodes.get(code) ?? 0) + count);
    }
  }
  overall.successRate = overall.total > 0 ? Math.round((overall.ok / overall.total) * 1000) / 10 : null;
  overall.failuresByCode = [...overallCodes.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count);

  return { weeks, overall, badLines: options.badLines ?? 0 };
}

/** 目标成功率 —— 方案里定的 98%。 */
export const EDIT_SUCCESS_TARGET_PCT = 98;

export function formatEditStatLine(week: EditStatWeek | null, zh = true): string {
  if (!week || week.total === 0) return '';
  const rate = week.successRate ?? 0;
  const pass = rate >= EDIT_SUCCESS_TARGET_PCT;
  const head = `${rate}% (${week.ok}/${week.total})`;
  const target = zh ? `目标 ${EDIT_SUCCESS_TARGET_PCT}%` : `target ${EDIT_SUCCESS_TARGET_PCT}%`;
  const mark = pass ? '✅' : '⚠️';
  const recovered = week.recovered > 0
    ? ` · ${zh ? '容错' : 'recovered'} ${week.recovered}`
    : '';
  return `${head} · ${target} ${mark}${recovered}`;
}
