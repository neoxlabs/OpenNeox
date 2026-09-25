/**
 * 修完之后的四家对比: Neox 取多批中位数, 竞品用已有批次 (它们代码没动, 不重跑省钱)。
 *   node final-compare.mjs --neox V4-neox,V4b-neox --cli V2-cli
 *
 * 口径:
 *   · 墙钟 = 发送 → 最后一条事件 (desktop-run 的 wallMs 含 8 秒判停窗, CLI 没有)
 *   · 往返 = 真实请求数 (Neox 用 sessionUsage.requests; codex 的 JSON 流不报, 显示 -)
 *   · 白花的动作 = 找工具 / 读文件短答 / 强制重读 / 工具失败
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const RES = path.join(ROOT, 'results');
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const NEOX_LABELS = argOf('--neox', 'V4-neox,V4b-neox').split(',');
const CLI_LABEL = argOf('--cli', 'V2-cli');
const rd = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const med = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

function neoxWall(r) {
  const t0 = Number(r.runId.split('__').pop());
  const f = path.join(RES, 'events', r.runId + '.jsonl');
  if (!fs.existsSync(f) || !t0) return r.wallMs;
  const last = Math.max(...fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l).ts || 0; } catch { return 0; } }));
  return last > t0 ? last - t0 : r.wallMs;
}
function neoxWaste(r) {
  const out = { toolSearch: 0, stub: 0, force: 0, failed: 0 };
  const f = path.join(RES, 'events', r.runId + '.jsonl');
  if (!fs.existsSync(f)) return out;
  const args = new Map();
  for (const l of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type === 'tool_call_start') args.set(e.data.toolId, String(e.data.argsPreview || ''));
    if (e.type !== 'tool_call_end') continue;
    if (e.data.name === 'tool_search') out.toolSearch++;
    if (e.data.success === false) out.failed++;
    if (e.data.name === 'readfile') {
      if (/未变化/.test(String(e.data.outputPreview || ''))) out.stub++;
      if (/"force":true/.test(args.get(e.data.toolId) || '')) out.force++;
    }
  }
  return out;
}

const neoxRuns = rd(path.join(RES, 'desktop-runs.jsonl')).filter((r) => NEOX_LABELS.includes(r.label))
  .map((r) => ({ tool: 'neox', task: r.task, ok: r.ok, wallMs: neoxWall(r), requests: r.usage?.requests ?? r.iterations, tools: r.toolCalls, ...neoxWaste(r) }));
const cliRuns = rd(path.join(RES, 'cli-runs.jsonl')).filter((r) => r.label === CLI_LABEL)
  .map((r) => ({ tool: r.tool, task: r.task, ok: r.ok, wallMs: r.wallMs, requests: r.requests, tools: r.tools, toolSearch: null, stub: null, force: null, failed: null }));

const all = [...neoxRuns, ...cliRuns];
const tools = ['neox', ...[...new Set(cliRuns.map((r) => r.tool))]];
const tasks = [...new Set(all.map((r) => r.task))].sort();

const cell = (g) => (g.length
  ? `${g.filter((r) => r.ok).length}/${g.length} ${String(Math.round(med(g.map((r) => r.wallMs)) / 1000) + 's').padStart(5)} ${String(med(g.map((r) => r.requests)) ?? '-').padStart(3)}轮`
  : '-').padEnd(18);

console.log('任务'.padEnd(15) + tools.map((t) => t.padEnd(18)).join(''));
for (const task of tasks) {
  console.log(task.padEnd(15) + tools.map((t) => cell(all.filter((r) => r.tool === t && r.task === task))).join(''));
}
console.log('');
for (const t of tools) {
  const g = all.filter((r) => r.tool === t);
  const sum = (k) => g.reduce((n, x) => n + (x[k] ?? 0), 0);
  const waste = t === 'neox'
    ? ` · 白花的: 找工具 ${sum('toolSearch')} / 短答 ${sum('stub')} / 强制重读 ${sum('force')} / 失败 ${sum('failed')}`
    : '';
  console.log(`${t.padEnd(9)} 通过 ${g.filter((r) => r.ok).length}/${g.length}`
    + ` · 单题墙钟中位 ${(med(g.map((r) => r.wallMs)) / 1000).toFixed(0)}s`
    + ` · 往返中位 ${med(g.map((r) => r.requests)) ?? '-'}`
    + ` · 工具中位 ${med(g.map((r) => r.tools)) ?? '-'}${waste}`);
}
