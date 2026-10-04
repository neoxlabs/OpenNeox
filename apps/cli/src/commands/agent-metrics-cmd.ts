import os from 'os';
import path from 'path';
import fs from 'fs';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

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
  if (process.platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support');
    push(path.join(support, 'Neox', 'neox.db'), '桌面 (打包)');
    push(path.join(support, 'Neox Dev', 'neox.db'), '桌面 (dev)');
    push(path.join(support, 'Neox', 'neox-cli.db'), 'CLI / server');
  } else if (process.platform === 'win32') {
    /* Electron 的 userData 默认是 %APPDATA%\<appName>; dev 跑的是 "Neox Dev" 那份 profile
     * (跟 macOS 一样分家) —— 漏了它就会得出"桌面端没埋点"的错误结论, 我在 macOS 上已经栽过一次。 */
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    push(path.join(appData, 'Neox', 'neox.db'), '桌面 (打包)');
    push(path.join(appData, 'Neox Dev', 'neox.db'), '桌面 (dev)');
    push(path.join(appData, 'Neox', 'neox-cli.db'), 'CLI / server');
  } else {
    /* Linux: Electron userData = ~/.config/<appName> */
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    push(path.join(xdg, 'Neox', 'neox.db'), '桌面 (打包)');
    push(path.join(xdg, 'Neox Dev', 'neox.db'), '桌面 (dev)');
    push(path.join(xdg, 'Neox', 'neox-cli.db'), 'CLI / server');
  }
  push(path.join(home, NEOX_HOME_DIRNAME, 'neox.db'), '全局 (~/.neox)');
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

export async function handleAgentMetricsCommand(args: string[]): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    console.log('Usage: neox metrics [--days N] [--json]');
    console.log('');
    console.log('  Agent 吞吐 / 去重埋点看板。扫描所有宿主的数据库 (桌面 / dev / CLI),');
    console.log('  报告每轮工具调用数、读去重与搜索去重命中率。');
    console.log('');
    console.log('  --days N   只统计最近 N 天 (默认全部)');
    console.log('  --json     输出 JSON');
    return 0;
  }
  const daysIdx = args.indexOf('--days');
  const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) : undefined;
  const sinceMs = days && Number.isFinite(days) && days > 0 ? Date.now() - days * 86_400_000 : undefined;
  const asJson = args.includes('--json');

  const candidates = candidateDbs();
  if (candidates.length === 0) {
    console.log('没找到任何 Neox 数据库 — 还没跑过会话?');
    return 0;
  }

  const summaries: DbSummary[] = [];
  for (const c of candidates) {
    const s = await readDb(c.file, c.label, sinceMs);
    if (s) summaries.push(s);
  }

  if (asJson) {
    console.log(JSON.stringify({ sinceMs: sinceMs ?? null, databases: summaries }, null, 2));
    return 0;
  }

  if (summaries.length === 0) {
    console.log(`扫了 ${candidates.length} 个库, 都没有 agent 埋点数据${sinceMs ? ' (在这个时间范围内)' : ''}。`);
    for (const c of candidates) console.log(`  · ${c.label}: ${c.file}`);
    return 0;
  }

  for (const s of summaries) {
    const newest = s.newestMs ? new Date(s.newestMs).toLocaleString() : '—';
    console.log(`\n▌${s.label}  ${s.file}`);
    console.log(`  轮次 ${s.turns} · 工具调用 ${s.toolCalls} · 最近一轮 ${newest}`);
    const reads = s.byTool.find(t => t.tool_name === 'readfile')?.calls ?? 0;
    const searches = s.byTool.find(t => t.tool_name === 'search')?.calls ?? 0;
    console.log(`  读去重 ${s.dupReads}/${reads} (${pct(s.dupReads, reads)}) · 搜索去重 ${s.dupSearches}/${searches} (${pct(s.dupSearches, searches)})`);
    if (s.byTool.length) {
      console.log('  按工具:');
      for (const t of s.byTool) {
        const dupPart = t.dup > 0 ? ` · 去重 ${t.dup} (${pct(t.dup, t.calls)})` : '';
        const failPart = t.failures > 0 ? ` · 失败 ${t.failures}` : '';
        console.log(`    ${t.tool_name.padEnd(18)} ${String(t.calls).padStart(5)} 次${dupPart}${failPart}`);
      }
    }
  }
  console.log('');
  return 0;
}
