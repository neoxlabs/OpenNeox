/**
 * 两批 A/B 并排比: node compare.mjs <labelA> <labelB>
 *   每个任务×模型: 通过 / 往返中位 / 墙钟中位 / 输入 token 中位 (sessionUsage);
 *   全局: 读短答次数、短答后 force 次数、首字延迟中位。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const RES = path.join(ROOT, 'results');
const [A, B] = process.argv.slice(2);
const all = fs.readFileSync(path.join(RES, 'desktop-runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((r) => r.wsOk !== false && r.modelOk !== false);
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const sum = (a) => a.reduce((n, x) => n + x, 0);

function stats(label) {
  const runs = all.filter((r) => r.label === label);
  let stub = 0; let forceAfterStub = 0; const ttft = []; const modelMs = [];
  for (const r of runs) {
    const f = path.join(RES, 'events', r.runId + '.jsonl'); if (!fs.existsSync(f)) continue;
    const ev = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const args = new Map(); const lastStub = new Map();
    for (const e of ev) {
      if (e.type === 'tool_call_start') { try { args.set(e.data.toolId, JSON.parse(e.data.argsPreview || '{}')); } catch { args.set(e.data.toolId, {}); } }
      if (e.type === 'tool_call_end' && e.data?.name === 'readfile') {
        const a = args.get(e.data.toolId) || {}; const p = a.path || '';
        const isStub = /未变化/.test(String(e.data.outputPreview || '')) && Number(e.data.resultLength || 0) < 600;
        if (isStub) stub++;
        if (a.force && lastStub.get(p)) forceAfterStub++;
        lastStub.set(p, isStub);
      }
      if (e.type === 'run_result') for (const it of e.data?.iterationPerf ?? []) { modelMs.push(it.durationMs - (it.toolMs || 0)); if (it.ttftMs != null) ttft.push(it.ttftMs); }
    }
  }
  return { runs, stub, forceAfterStub, ttft, modelMs };
}

const sa = stats(A); const sb = stats(B);
const keys = [...new Set([...sa.runs, ...sb.runs].map((r) => `${r.task}|${r.model}`))].sort();
const row = (g) => g.length
  ? `${g.filter((r) => r.ok).length}/${g.length} ${String(med(g.map((r) => r.iterations))).padStart(3)} ${(med(g.map((r) => r.wallMs)) / 1000).toFixed(1).padStart(6)}s ${String(Math.round(med(g.map((r) => r.usage?.inputTokens || 0)) / 1000)).padStart(4)}K`
  : '-'.padEnd(22);
console.log(`${'任务'.padEnd(14)}${'模型'.padEnd(14)}  ${A.padEnd(24)}  ${B}`);
console.log(`${''.padEnd(28)}  通过 往返 墙钟   输入         通过 往返 墙钟   输入`);
for (const k of keys) {
  const [task, model] = k.split('|');
  console.log(`${task.padEnd(14)}${model.replace('opencode-zen:', '').padEnd(14)}  ${row(sa.runs.filter((r) => `${r.task}|${r.model}` === k)).padEnd(24)}  ${row(sb.runs.filter((r) => `${r.task}|${r.model}` === k))}`);
}
for (const [l, s] of [[A, sa], [B, sb]]) {
  const r = s.runs;
  console.log(`\n${l}: ${r.filter((x) => x.ok).length}/${r.length} 通过 · 往返合计 ${sum(r.map((x) => x.iterations))} · 墙钟合计 ${(sum(r.map((x) => x.wallMs)) / 1000).toFixed(0)}s · 输入合计 ${(sum(r.map((x) => x.usage?.inputTokens || 0)) / 1e6).toFixed(2)}M · 输出合计 ${sum(r.map((x) => x.usage?.outputTokens || 0))}`
    + ` · 读短答 ${s.stub} (后接 force ${s.forceAfterStub}) · 等模型中位 ${(med(s.modelMs) / 1000).toFixed(1)}s 首字中位 ${(med(s.ttft) / 1000).toFixed(1)}s`);
}
