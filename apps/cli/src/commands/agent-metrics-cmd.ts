import os from 'os';
import path from 'path';
import fs from 'fs';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import { DISTRIBUTION } from '@neoxlabs/kernel/platform/distribution.js';
import { getStallLogPath } from '@neoxlabs/kernel/utils/stallGuard.js';
import {
  aggregateEditStatsByWeek,
  parseEditStatLog,
  EDIT_SUCCESS_TARGET_PCT,
  type EditStatReport,
} from '@neoxlabs/core';
import { L } from '../i18n/index.js';

interface DbSummary {
  file: string;
  label: string;
  turns: number;
  toolCalls: number;
  dupReads: number;
  dupSearches: number;
  byTool: Array<{ tool_name: string; calls: number; dup: number; failures: number }>;
  newestMs: number | null;
}

function candidateDbs(): Array<{ file: string; label: string }> {
  const home = os.homedir();
  const out: Array<{ file: string; label: string }> = [];
  const push = (file: string, label: string) => {
    if (fs.existsSync(file)) out.push({ file, label });
  };
  const desktop = L('桌面 (打包)', 'Desktop (packaged)');
  const desktopDev = L('桌面 (dev)', 'Desktop (dev)');
  if (process.platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support');
    push(path.join(support, DISTRIBUTION.appName, 'neox.db'), desktop);
    push(path.join(support, 'Neox Dev', 'neox.db'), desktopDev);
    push(path.join(support, DISTRIBUTION.appName, 'neox-cli.db'), 'CLI / server');
  } else if (process.platform === 'win32') {
    /* Electron 的 userData 默认是 %APPDATA%\<appName>; dev 跑的是 "Neox Dev" 那份 profile
     * (跟 macOS 一样分家) —— 漏了它就会得出"桌面端没埋点"的错误结论, 我在 macOS 上已经栽过一次。 */
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    push(path.join(appData, DISTRIBUTION.appName, 'neox.db'), desktop);
    push(path.join(appData, 'Neox Dev', 'neox.db'), desktopDev);
    push(path.join(appData, DISTRIBUTION.appName, 'neox-cli.db'), 'CLI / server');
  } else {
    /* Linux: Electron userData = ~/.config/<appName> */
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    push(path.join(xdg, DISTRIBUTION.appName, 'neox.db'), desktop);
    push(path.join(xdg, 'Neox Dev', 'neox.db'), desktopDev);
    push(path.join(xdg, DISTRIBUTION.appName, 'neox-cli.db'), 'CLI / server');
  }
  push(path.join(home, NEOX_HOME_DIRNAME, 'neox.db'), L('全局 (~/.neox)', 'Global (~/.neox)'));
  push(path.join(home, NEOX_HOME_DIRNAME, 'neox-cli.db'), 'CLI (~/.neox)');
  return out;
}

async function readDb(file: string, label: string, sinceMs?: number): Promise<DbSummary | null> {
  const { openReadonlyDatabase } = await import('@neoxlabs/platform/platform/database.js');
  let handle: any;
  try {
    handle = openReadonlyDatabase(file);
  } catch {
    return null;   /* 打不开 (锁着 / 加密 key 不匹配) → 跳过, 不是错误 */
  }
  const raw = handle?.db ?? handle?._db ?? handle;
  const where = sinceMs ? 'WHERE timestamp >= ?' : '';
  const params = sinceMs ? [sinceMs] : [];
  try {
    const turn = raw.prepare(`
      SELECT COUNT(*) AS turns, COALESCE(SUM(tool_calls),0) AS tool_calls,
             COALESCE(SUM(duplicate_read_count),0) AS dup_reads,
             COALESCE(SUM(duplicate_search_count),0) AS dup_searches,
             MAX(timestamp) AS newest
      FROM agent_turn_metrics ${where}
    `).get(...params);
    const byTool = raw.prepare(`
      SELECT tool_name, COUNT(*) AS calls,
             COALESCE(SUM(is_duplicate),0) AS dup,
             COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END),0) AS failures
      FROM agent_tool_metrics ${where}
      GROUP BY tool_name ORDER BY calls DESC LIMIT 12
    `).all(...params);
    if (!turn || turn.turns === 0) return null;
    return {
      file, label,
      turns: turn.turns,
      toolCalls: turn.tool_calls,
      dupReads: turn.dup_reads,
      dupSearches: turn.dup_searches,
      byTool,
      newestMs: turn.newest ?? null,
    };
  } catch {
    return null;   /* 老库没有这两张表 */
  }
}

function pct(hit: number, total: number): string {
  return total > 0 ? `${((hit / total) * 100).toFixed(1)}%` : '—';
}

/**
 * VERIFY-08: 读 stall.log 里的 EDIT_STAT, 聚合成周看板。
 *
 * 只读; 日志不存在 / 没开过编辑 = 返回 null (这一节不占位)。
 * 放在这个命令里而不是单独一个子命令: metrics 就是"agent 干活质量"的看板,
 * edit 成功率是其中一栏 —— 用户不需要再记一个命令。
 */
export function readEditStatReport(weeks: number, now = Date.now()): EditStatReport | null {
  let text: string;
  try {
    text = fs.readFileSync(getStallLogPath(), 'utf-8');
  } catch {
    return null;
  }
  const { records, badLines } = parseEditStatLog(text);
  if (records.length === 0) return null;
  return aggregateEditStatsByWeek(records, { weeks, now, badLines });
}

function printEditStatReport(report: EditStatReport): void {
  console.log(`\n▌${L('edit 成功率 (按周)', 'edit success rate (weekly)')}`);
  for (const w of report.weeks) {
    const rate = w.successRate === null ? '—' : `${w.successRate}%`;
    const mark = w.successRate !== null && w.successRate >= EDIT_SUCCESS_TARGET_PCT ? '✅' : '⚠️';
    const recovered = w.recovered > 0 ? ` · ${L('容错', 'recovered')} ${w.recovered}` : '';
    console.log(`  ${w.key}  ${rate.padStart(6)} ${mark}  ${L('成功', 'ok')} ${w.ok}/${w.total}${recovered}`);
    if (w.failuresByCode.length > 0) {
      console.log(`      ${L('失败', 'failed')}: ` + w.failuresByCode.map((f) => `${f.code} ${f.count}`).join(' · '));
    }
  }
  const o = report.overall;
  const oRate = o.successRate === null ? '—' : `${o.successRate}%`;
  console.log(L(
    `  合计 ${oRate} (${o.ok}/${o.total}) · 目标 ${EDIT_SUCCESS_TARGET_PCT}% · 失败 ${o.failed}`,
    `  Total ${oRate} (${o.ok}/${o.total}) · target ${EDIT_SUCCESS_TARGET_PCT}% · failed ${o.failed}`,
  ));
  if (o.failuresByCode.length > 0) {
    console.log(`  ${L('按分诊', 'by diagnosis')}: ` + o.failuresByCode.map((f) => `${f.code} ${f.count}`).join(' · '));
  }
  if (report.badLines > 0) {
    console.log(L(`  ⚠️ ${report.badLines} 行 EDIT_STAT 解析不了 (日志格式可能变了)`,
      `  ⚠️ ${report.badLines} EDIT_STAT lines unparseable (log format may have changed)`));
  }
}

export async function handleAgentMetricsCommand(args: string[]): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    console.log('Usage: neox metrics [--days N] [--weeks N] [--json]');
    console.log('');
    console.log(L('  Agent 吞吐 / 去重埋点看板。扫描所有宿主的数据库 (桌面 / dev / CLI),', '  Agent throughput / dedup metrics. Scans every host database (desktop / dev / CLI)'));
    console.log(L('  报告每轮工具调用数、读去重与搜索去重命中率, 以及 edit 成功率周看板。', '  and reports tool calls per turn, dedup hit rates, and the weekly edit success rate.'));
    console.log('');
    console.log(L('  --days N   只统计最近 N 天 (默认全部)', '  --days N   only the last N days (default: all)'));
    console.log(L('  --weeks N  edit 周看板只显示最近 N 周 (默认 4)', '  --weeks N  edit weekly board window (default: 4)'));
    console.log(L('  --json     输出 JSON', '  --json     JSON output'));
    return 0;
  }
  const daysIdx = args.indexOf('--days');
  const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) : undefined;
  const sinceMs = days && Number.isFinite(days) && days > 0 ? Date.now() - days * 86_400_000 : undefined;
  const weeksIdx = args.indexOf('--weeks');
  const weeksArg = weeksIdx >= 0 ? Number(args[weeksIdx + 1]) : undefined;
  const editWeeks = weeksArg && Number.isFinite(weeksArg) && weeksArg > 0 ? weeksArg : 4;
  const asJson = args.includes('--json');

  const editReport = readEditStatReport(editWeeks);

  const candidates = candidateDbs();
  if (candidates.length === 0) {
    if (asJson) {
      console.log(JSON.stringify({ sinceMs: sinceMs ?? null, databases: [], editStats: editReport }, null, 2));
      return 0;
    }
    console.log(L('没找到任何 Neox 数据库 — 还没跑过会话?', 'No Neox database found — no sessions yet?'));
    if (editReport) printEditStatReport(editReport);
    return 0;
  }

  const summaries: DbSummary[] = [];
  for (const c of candidates) {
    const s = await readDb(c.file, c.label, sinceMs);
    if (s) summaries.push(s);
  }

  if (asJson) {
    console.log(JSON.stringify({ sinceMs: sinceMs ?? null, databases: summaries, editStats: editReport }, null, 2));
    return 0;
  }

  if (summaries.length === 0) {
    console.log(L(`扫了 ${candidates.length} 个库, 都没有 agent 埋点数据${sinceMs ? ' (在这个时间范围内)' : ''}。`,
      `Scanned ${candidates.length} databases — no agent metrics${sinceMs ? ' in this time range' : ''}.`));
    for (const c of candidates) console.log(`  · ${c.label}: ${c.file}`);
    if (editReport) printEditStatReport(editReport);
    return 0;
  }

  for (const s of summaries) {
    const newest = s.newestMs ? new Date(s.newestMs).toLocaleString() : '—';
    console.log(`\n▌${s.label}  ${s.file}`);
    console.log(L(`  轮次 ${s.turns} · 工具调用 ${s.toolCalls} · 最近一轮 ${newest}`, `  Turns ${s.turns} · tool calls ${s.toolCalls} · latest ${newest}`));
    const reads = s.byTool.find(t => t.tool_name === 'readfile')?.calls ?? 0;
    const searches = s.byTool.find(t => t.tool_name === 'search')?.calls ?? 0;
    console.log(`  ${L('读去重', 'Read dedup')} ${s.dupReads}/${reads} (${pct(s.dupReads, reads)}) · ${L('搜索去重', 'search dedup')} ${s.dupSearches}/${searches} (${pct(s.dupSearches, searches)})`);
    if (s.byTool.length) {
      console.log(L('  按工具:', '  By tool:'));
      for (const t of s.byTool) {
        const dupPart = t.dup > 0 ? ` · ${L('去重', 'dedup')} ${t.dup} (${pct(t.dup, t.calls)})` : '';
        const failPart = t.failures > 0 ? ` · ${L('失败', 'failed')} ${t.failures}` : '';
        console.log(`    ${t.tool_name.padEnd(18)} ${String(t.calls).padStart(5)}${L(' 次', '')}${dupPart}${failPart}`);
      }
    }
  }
  if (editReport) printEditStatReport(editReport);
  console.log('');
  return 0;
}
