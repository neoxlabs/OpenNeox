/**
 * 同一套 v2 任务、同一模型, 把几轮 Neox 批次并排看 (改之前 / 改之后)。
 *   node v-compare.mjs V2-neox V3-neox V4-neox
 * 每题一行: 通过 · 墙钟 · 往返 · 工具数; 批次末尾给"白花的动作"合计。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const RES = path.join(ROOT, 'results');
const LABELS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const runs = fs.readFileSync(path.join(RES, 'desktop-runs.jsonl'), 'utf8').trim().split('\n')
  .map((l) => JSON.parse(l)).filter((r) => LABELS.includes(r.label));

/** 墙钟按"发送 → 最后一条事件"算 (跑分器的 wallMs 含 8s 判停窗) */
function wall(r) {
  const t0 = Number(r.runId.split('__').pop());
  const f = path.join(RES, 'events', r.runId + '.jsonl');
  if (!fs.existsSync(f) || !t0) return r.wallMs;
  const last = Math.max(...fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l).ts || 0; } catch { return 0; } }));
  return last > t0 ? last - t0 : r.wallMs;
}

function waste(r) {
  const f = path.join(RES, 'events', r.runId + '.jsonl');
  const out = { toolSearch: 0, stub: 0, force: 0, failed: 0, tools: 0 };
  if (!fs.existsSync(f)) return out;
  const args = new Map();
  for (const l of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type === 'tool_call_start') args.set(e.data.toolId, String(e.data.argsPreview || ''));
    if (e.type !== 'tool_call_end') continue;
    out.tools++;
    if (e.data.name === 'tool_search') out.toolSearch++;
    if (e.data.success === false) out.failed++;
    if (e.data.name === 'readfile') {
      if (/未变化/.test(String(e.data.outputPreview || ''))) out.stub++;
      if (/"force":true/.test(args.get(e.data.toolId) || '')) out.force++;
    }
  }
  return out;
}

const tasks = [...new Set(runs.map((r) => r.task))].sort();
console.log('任务'.padEnd(15) + LABELS.map((l) => l.padEnd(22)).join(''));
for (const task of tasks) {
  let line = task.padEnd(15);
  for (const label of LABELS) {
    const r = runs.find((x) => x.label === label && x.task === task);
    line += (r
      ? `${r.ok ? '✓' : '✗'} ${String(Math.round(wall(r) / 1000) + 's').padStart(4)} ${String(r.usage?.requests ?? r.iterations).padStart(3)}轮 ${String(waste(r).tools).padStart(3)}工具`
      : '-').padEnd(22);
  }
  console.log(line);
}
console.log('');
for (const label of LABELS) {
  const g = runs.filter((r) => r.label === label);
  const w = g.map(waste);
  const sum = (k) => w.reduce((n, x) => n + x[k], 0);
  console.log(`${label.padEnd(10)} 通过 ${g.filter((r) => r.ok).length}/${g.length}`
    + ` · 墙钟合计 ${Math.round(g.reduce((n, r) => n + wall(r), 0) / 1000)}s`
    + ` · 往返合计 ${g.reduce((n, r) => n + (r.usage?.requests ?? r.iterations ?? 0), 0)}`
    + ` · 工具 ${sum('tools')}`
    + ` · 白花的: 找工具 ${sum('toolSearch')} / 短答 ${sum('stub')} / 强制重读 ${sum('force')} / 失败 ${sum('failed')}`);
}
