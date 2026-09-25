/**
 * 正面对比: Neox (desktop-runs.jsonl, --neox <label>) vs 竞品 CLI (cli-runs.jsonl, --cli <label>), 同模型同任务。
 *   node h-compare.mjs [--neox H-neox] [--cli H-cli]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const RES = path.join(ROOT, 'results');
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const NL = argOf('--neox', 'H-neox');
const CL = argOf('--cli', 'H-cli');
const rd = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const med = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const sum = (a) => a.reduce((n, x) => n + (x || 0), 0);
function neoxWall(r) {
  const t0 = Number(r.runId.split('__').pop());
  const f = path.join(RES, 'events', r.runId + '.jsonl');
  if (!fs.existsSync(f) || !t0) return r.wallMs;
  const last = Math.max(...fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l).ts || 0; } catch { return 0; } }));
  return last > t0 ? last - t0 : r.wallMs;
}

const rows = [
  ...rd(path.join(RES, 'desktop-runs.jsonl')).filter((r) => r.label === NL && r.wsOk !== false && r.modelOk !== false).map((r) => ({
    /* desktop-run 的 wallMs 含"停止按钮消失后再等 8 秒"的判停窗口, CLI 没有这 8 秒 ——
     * 公平口径: 发送 (runId 末尾的 t0) → 最后一条事件 (run_result) */
    tool: 'neox', task: r.task, ok: r.ok, wallMs: neoxWall(r), requests: r.usage?.requests ?? r.iterations, tools: r.toolCalls,
    input: r.usage?.inputTokens ?? null, cache: r.usage?.cacheReadTokens ?? null, output: r.usage?.outputTokens ?? null, why: r.why })),
  ...rd(path.join(RES, 'cli-runs.jsonl')).filter((r) => r.label === CL),
];
const tools = [...new Set(rows.map((r) => r.tool))];
const tasks = [...new Set(rows.map((r) => r.task))].sort();

const fmt = (g) => {
  if (!g.length) return '-'.padEnd(30);
  const w = med(g.map((r) => r.wallMs)); const q = med(g.map((r) => r.requests)); const i = med(g.map((r) => r.input));
  return `${g.filter((r) => r.ok).length}/${g.length} ${(w / 1000).toFixed(0).padStart(3)}s ${String(q ?? '-').padStart(3)}次 ${String(i != null ? Math.round(i / 1000) + 'K' : '-').padStart(5)}`.padEnd(30);
};
console.log('任务'.padEnd(15) + tools.map((t) => t.padEnd(30)).join(''));
console.log(''.padEnd(15) + tools.map(() => '通过 墙钟 往返 输入'.padEnd(30)).join(''));
for (const task of tasks) console.log(task.padEnd(15) + tools.map((t) => fmt(rows.filter((r) => r.tool === t && r.task === task))).join(''));
console.log('');
for (const t of tools) {
  const g = rows.filter((r) => r.tool === t);
  const cacheKnown = g.filter((r) => r.cache != null && r.input);
  console.log(`${t.padEnd(9)} 通过 ${g.filter((r) => r.ok).length}/${g.length} · 墙钟合计 ${(sum(g.map((r) => r.wallMs)) / 1000).toFixed(0)}s (中位 ${(med(g.map((r) => r.wallMs)) / 1000).toFixed(1)}s)`
    + ` · 往返中位 ${med(g.map((r) => r.requests)) ?? '-'} · 工具中位 ${med(g.map((r) => r.tools)) ?? '-'}`
    + ` · 输入合计 ${(sum(g.map((r) => r.input)) / 1e6).toFixed(2)}M (缓存 ${cacheKnown.length ? Math.round(sum(cacheKnown.map((r) => r.cache)) / sum(cacheKnown.map((r) => r.input)) * 100) + '%' : '-'})`
    + ` · 输出合计 ${sum(g.map((r) => r.output))}`);
  for (const r of g.filter((x) => !x.ok)) console.log(`    ✗ ${r.task}: ${r.why}`);
}
