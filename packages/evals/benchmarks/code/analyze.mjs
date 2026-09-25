/**
 * 从每一轮的原始 action log 事件算指标 —— 找工具层瓶颈。
 *
 *   输入: results/desktop-runs.jsonl (每轮一行) + results/events/<runId>.jsonl (原始事件)
 *   输出: 按任务 × 模型的中位数; 按工具的次数 / 失败 / 耗时 / 输出量; 读文件行为; 找工具行为;
 *        往返里"等模型"和"跑工具"的时间占比; 每次往返的 token。
 *
 *   用法: node analyze.mjs [--batch <label>]   (默认读全部轮次)
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const RES = path.join(ROOT, 'results');
const LABEL = (() => { const i = process.argv.indexOf('--label'); return i >= 0 ? process.argv[i + 1] : null; })();
const runs = fs.readFileSync(path.join(RES, 'desktop-runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((r) => r.wsOk !== false && r.modelOk !== false)
  .filter((r) => !LABEL || r.label === LABEL);
if (LABEL) console.log(`批次: ${LABEL}`);
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (n, d) => (d ? (n / d * 100).toFixed(1) + '%' : '-');

const READ = /^(readfile|read_file|read)$/;
const EDITS = /^(edit|edit_file|write_file|write|multi_edit)$/;
const argsOf = (e) => { try { return JSON.parse(e.data?.argsPreview || '{}'); } catch { return {}; } };

const perTool = new Map();
const readStats = { reads: 0, rereadSameRange: 0, rereadOtherRange: 0, stub: 0, forceAfterStub: 0, fullReads: 0, bytes: 0 };
const discovery = { toolSearch: 0, toolSearchChains: 0, runsWithSearch: 0 };
const timeSplit = { wall: 0, tool: 0 };
const iterTok = [];
const perRun = [];
const seqs = new Map();

for (const r of runs) {
  const f = path.join(RES, 'events', r.runId + '.jsonl');
  if (!fs.existsSync(f)) continue;
  const ev = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const open = new Map(); let toolMs = 0; let prevTool = null; let searchedHere = false;
  const readRanges = new Map(); let lastWasStub = new Map();
  const names = [];
  for (const e of ev) {
    if (e.type === 'tool_call_start') {
      open.set(e.data?.toolId, { ts: e.ts, name: e.data?.name, args: argsOf(e) });
      continue;
    }
    if (e.type !== 'tool_call_end') continue;
    const st = open.get(e.data?.toolId); const name = e.data?.name || st?.name || '?';
    const dur = st ? e.ts - st.ts : 0; toolMs += dur; names.push(name);
    const t = perTool.get(name) ?? { n: 0, fail: 0, ms: 0, out: 0 };
    t.n++; if (e.data?.success === false) t.fail++; t.ms += dur; t.out += Number(e.data?.resultLength || 0); perTool.set(name, t);
    if (prevTool) { const k = `${prevTool} → ${name}`; seqs.set(k, (seqs.get(k) ?? 0) + 1); }
    if (name === 'tool_search') { discovery.toolSearch++; searchedHere = true; if (prevTool === 'tool_search') discovery.toolSearchChains++; }
    const a = st?.args || {};
    const p = a.path || a.file_path || a.filePath || '';
    if (READ.test(name) && p) {
      readStats.reads++; readStats.bytes += Number(e.data?.resultLength || 0);
      const range = `${a.start_line ?? a.offset ?? ''}-${a.end_line ?? a.num_lines ?? a.limit ?? ''}${a.read_all ? 'ALL' : ''}${a.pattern ? 'P:' + a.pattern : ''}`;
      if (range === '-' || a.read_all) readStats.fullReads++;
      const seen = readRanges.get(p) ?? new Set();
      if (seen.size) { if (seen.has(range)) readStats.rereadSameRange++; else readStats.rereadOtherRange++; }
      seen.add(range); readRanges.set(p, seen);
      const out = String(e.data?.outputPreview || '');
      const isStub = /未变化|上次已读|unchanged/.test(out) && Number(e.data?.resultLength || 0) < 600;
      if (isStub) readStats.stub++;
      if (a.force && lastWasStub.get(p)) readStats.forceAfterStub++;
      lastWasStub.set(p, isStub);
    }
    if (EDITS.test(name) && p) readRanges.delete(p);
    prevTool = name;
  }
  if (searchedHere) discovery.runsWithSearch++;
  timeSplit.wall += r.wallMs; timeSplit.tool += toolMs;
  if (r.iterations) iterTok.push(r.tokens / r.iterations);
  perRun.push({ ...r, toolMs, names });
}

/* ── 任务 × 模型 ── */
const groups = new Map();
for (const r of perRun) { const k = `${r.task}|${r.model}`; const g = groups.get(k) ?? []; g.push(r); groups.set(k, g); }
console.log(`轮次 ${perRun.length} (剔除工作区/模型不符的)  通过 ${perRun.filter((r) => r.ok).length}\n`);
console.log('任务'.padEnd(15) + '模型'.padEnd(30) + '通过  墙钟中位  往返中位  工具中位  token中位  工具耗时占比');
for (const [k, g] of [...groups].sort()) {
  const [task, model] = k.split('|');
  const toolShare = g.reduce((n, r) => n + r.toolMs, 0) / Math.max(1, g.reduce((n, r) => n + r.wallMs, 0));
  console.log(task.padEnd(15) + model.padEnd(30) + `${g.filter((r) => r.ok).length}/${g.length}`.padEnd(6)
    + `${(med(g.map((r) => r.wallMs)) / 1000).toFixed(1)}s`.padStart(8) + String(med(g.map((r) => r.iterations))).padStart(9)
    + String(med(g.map((r) => r.toolCalls))).padStart(9) + String(med(g.map((r) => r.tokens))).padStart(11) + `${(toolShare * 100).toFixed(0)}%`.padStart(12));
}
console.log(`\n时间: 墙钟合计 ${(timeSplit.wall / 1000).toFixed(0)}s, 工具执行 ${(timeSplit.tool / 1000).toFixed(0)}s (${pct(timeSplit.tool, timeSplit.wall)}), 其余是等模型`);
{
  const dur = [], ttft = [], gen = [], kinds = new Map();
  for (const r of perRun) {
    const f = path.join(RES, 'events', r.runId + '.jsonl'); if (!fs.existsSync(f)) continue;
    for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!l.includes('"run_result"')) continue;
      const e = JSON.parse(l);
      for (const it of e.data?.iterationPerf ?? []) {
        const modelMs = it.durationMs - (it.toolMs || 0);
        dur.push(modelMs);
        if (it.ttftMs != null) { ttft.push(it.ttftMs); gen.push(Math.max(0, modelMs - it.ttftMs)); }
        kinds.set(it.firstKind, (kinds.get(it.firstKind) ?? 0) + 1);
      }
    }
  }
  if (dur.length) {
    const q = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
    console.log(`逐请求 (${dur.length} 次): 等模型 中位 ${(med(dur) / 1000).toFixed(1)}s p90 ${(q(dur, 0.9) / 1000).toFixed(1)}s · 首字延迟 中位 ${(med(ttft) / 1000).toFixed(1)}s p90 ${(q(ttft, 0.9) / 1000).toFixed(1)}s · 首字之后 中位 ${(med(gen) / 1000).toFixed(1)}s · 首字类型 ${JSON.stringify([...kinds])}`);
  }
}

/* 真实用量: 跑分器记的 usage, 或 backfill-usage.mjs 补的 */
const usageById = new Map();
const uf = path.join(RES, 'usage.jsonl');
if (fs.existsSync(uf)) for (const l of fs.readFileSync(uf, 'utf8').trim().split('\n').filter(Boolean)) { const u = JSON.parse(l); usageById.set(u.runId, u.usage); }
const U = { runs: 0, req: 0, input: 0, cache: 0, output: 0, sys: 0, toolDef: 0, toolResult: 0, toolCall: 0, user: 0 };
const reqPerRun = [];
for (const r of perRun) {
  const u = r.usage ?? usageById.get(r.runId); if (!u) continue;
  const d = u.breakdown?.details ?? {};
  U.runs++; U.req += u.requests || 0; U.input += u.inputTokens || 0; U.cache += u.cacheReadTokens || 0; U.output += u.outputTokens || 0;
  U.sys += d.systemPromptTokens || 0; U.toolDef += d.toolDefinitionsTokens || 0; U.toolResult += d.toolResultTokens || 0; U.toolCall += d.toolCallTokens || 0; U.user += d.userTextTokens || 0;
  reqPerRun.push(u.requests || 0);
}
if (U.runs) {
  console.log(`真实用量 (${U.runs} 轮): 请求 ${U.req} 次 (每轮中位 ${med(reqPerRun)}), 输入 ${U.input} (缓存命中 ${pct(U.cache, U.input)}), 输出 ${U.output}`);
  console.log(`  输入构成: 系统提示词 ${pct(U.sys, U.input)} · 工具定义 ${pct(U.toolDef, U.input)} · 工具结果 ${pct(U.toolResult, U.input)} · 工具调用 ${pct(U.toolCall, U.input)} · 用户输入 ${pct(U.user, U.input)}`);
  console.log(`  每次请求平均输入 ${Math.round(U.input / U.req)} token, 其中固定开销 (系统+工具定义) ${Math.round((U.sys + U.toolDef) / U.req)}`);
}
console.log(`\n读文件: ${readStats.reads} 次, 整文件读 ${readStats.fullReads}, 同一轮重读同段 ${readStats.rereadSameRange}, 换段再读 ${readStats.rereadOtherRange}, 命中「未变化」短答 ${readStats.stub}, 短答后又 force ${readStats.forceAfterStub}, 平均每次 ${Math.round(readStats.bytes / Math.max(1, readStats.reads))} 字符`);
console.log(`找工具: tool_search ${discovery.toolSearch} 次, 连着搜 ${discovery.toolSearchChains} 次, ${discovery.runsWithSearch}/${perRun.length} 轮用过`);
console.log('\n工具 (次数 / 失败率 / 平均耗时 / 平均输出字符):');
for (const [n, t] of [...perTool].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${n.padEnd(26)} ${String(t.n).padStart(4)}  ${pct(t.fail, t.n).padStart(6)}  ${Math.round(t.ms / t.n)}ms  ${Math.round(t.out / t.n)}`);
console.log('\n最常见的两步:', [...seqs].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${k} ×${n}`).join(' | '));
console.log('\n失败的轮次:'); for (const r of perRun.filter((x) => !x.ok)) console.log(`  ${r.task} ${r.model} r${r.rep}: ${r.why}${r.timedOut ? ' [超时]' : ''}`);
