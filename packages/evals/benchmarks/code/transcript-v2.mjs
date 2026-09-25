/**
 * 把每一轮的"操作记录"压成同一种格式, 给人工评分用 (聪不聪明看过程, 不只看结果)。
 *   node transcript-v2.mjs [--neox V2-neox] [--cli V2-cli] [--task v2-streak] [--out results/v2-transcripts.md]
 *
 *   Neox: 工具序列来自 action log 事件; 最终回答走 CDP getSession(sid) 拿全文 (desktop-run 只存了尾巴)。
 *   opencode / claude / codex: 从各自原始 JSON 流里抽工具调用 + 最终回答。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const RES = path.join(ROOT, 'results');
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const NL = argOf('--neox', 'V2-neox');
const CL = argOf('--cli', 'V2-cli');
const ONLY = argOf('--task', '');
const OUT = argOf('--out', path.join(RES, 'v2-transcripts.md'));
const rd = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
const short = (s, n = 110) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

/* Neox 全文回答: CDP 取会话 (没开 CDP 就退回 answerTail) */
async function neoxAnswers(sids) {
  const out = new Map();
  try {
    const { chromium } = createRequire('/Users/exampleuser/AI/OpenNeox/packages/core/package.json')('playwright-core');
    const app = await chromium.connectOverCDP('http://127.0.0.1:41777');
    let page; for (const c of app.contexts()) for (const p of c.pages()) if (p.url().includes(':5180')) page = p;
    for (const sid of sids) {
      const txt = await page.evaluate(async (id) => {
        const x = await window.neox.getSession(id); const s = x?.session ?? x;
        return (s?.timeline ?? []).filter((e) => e.type === 'assistant_message').map((e) => String(e.detail || '')).join('\n\n');
      }, sid).catch(() => '');
      out.set(sid, txt);
    }
    await app.close().catch(() => {});
  } catch { /* 没有 CDP */ }
  return out;
}

function neoxSteps(runId) {
  const ev = rd(path.join(RES, 'events', runId + '.jsonl'));
  return ev.filter((e) => e.type === 'tool_call_start').map((e) => {
    let a = {}; try { a = JSON.parse(e.data?.argsPreview || '{}'); } catch { a = { raw: e.data?.argsPreview }; }
    const key = a.command || a.path || a.file_path || a.pattern || a.query || a.url || (a.paths && a.paths.join(',')) || a.raw || JSON.stringify(a);
    return `${e.data?.name} ${short(key)}`;
  });
}

function cliSteps(tool, runId) {
  const ev = rd(path.join(RES, 'cli-raw', runId + '.out'));
  if (tool === 'opencode') {
    return {
      steps: ev.filter((e) => e.type === 'tool_use').map((e) => { const p = e.part || {}; const i = p.state?.input || {}; return `${p.tool} ${short(i.command || i.filePath || i.path || i.pattern || i.url || i.query || JSON.stringify(i))}`; }),
      answer: ev.filter((e) => e.type === 'text').map((e) => e.part?.text || '').join('\n'),
    };
  }
  if (tool === 'claude') {
    const uses = ev.filter((e) => e.type === 'assistant').flatMap((e) => e.message?.content || []).filter((c) => c.type === 'tool_use');
    return {
      steps: uses.map((u) => { const i = u.input || {}; return `${u.name} ${short(i.command || i.file_path || i.path || i.pattern || i.url || i.query || i.prompt || JSON.stringify(i))}`; }),
      answer: String(ev.find((e) => e.type === 'result')?.result || ''),
    };
  }
  if (tool === 'codex') {
    const items = ev.filter((e) => e.type === 'item.completed').map((e) => e.item || {});
    return {
      steps: items.filter((i) => i.type !== 'agent_message' && i.type !== 'reasoning').map((i) => `${i.type} ${short(i.command || (i.changes || []).map((c) => c.path).join(',') || i.query || JSON.stringify(i))}`),
      answer: items.filter((i) => i.type === 'agent_message').map((i) => i.text).join('\n'),
    };
  }
  return { steps: [], answer: '' };
}

const neoxRuns = rd(path.join(RES, 'desktop-runs.jsonl')).filter((r) => r.label === NL && (!ONLY || r.task === ONLY));
const cliRuns = rd(path.join(RES, 'cli-runs.jsonl')).filter((r) => r.label === CL && (!ONLY || r.task === ONLY));
const answers = await neoxAnswers(neoxRuns.map((r) => r.sid).filter(Boolean));

const blocks = [];
const tasks = [...new Set([...neoxRuns, ...cliRuns].map((r) => r.task))].sort();
for (const task of tasks) {
  blocks.push(`\n# ${task}\n`);
  for (const r of neoxRuns.filter((x) => x.task === task)) {
    const steps = neoxSteps(r.runId);
    blocks.push(`## neox · ${r.ok ? '✓' : '✗'} · ${(r.wallMs / 1000).toFixed(0)}s · 往返 ${r.usage?.requests ?? r.iterations} · 工具 ${steps.length}${r.why ? ` · ${short(r.why, 200)}` : ''}`);
    steps.forEach((s, i) => blocks.push(`${String(i + 1).padStart(3)}. ${s}`));
    blocks.push(`FINAL:\n${(answers.get(r.sid) || r.answerTail || '').slice(0, 2500)}\n`);
  }
  for (const r of cliRuns.filter((x) => x.task === task)) {
    const { steps, answer } = cliSteps(r.tool, r.runId);
    blocks.push(`## ${r.tool} · ${r.ok ? '✓' : '✗'} · ${(r.wallMs / 1000).toFixed(0)}s · 往返 ${r.requests ?? '-'} · 工具 ${steps.length}${r.why ? ` · ${short(r.why, 200)}` : ''}${r.timedOut ? ' · [超时]' : ''}`);
    steps.forEach((s, i) => blocks.push(`${String(i + 1).padStart(3)}. ${s}`));
    blocks.push(`FINAL:\n${String(answer).slice(0, 2500)}\n`);
  }
}
fs.writeFileSync(OUT, blocks.join('\n'));
console.log(`写到 ${OUT} · ${neoxRuns.length} 轮 Neox + ${cliRuns.length} 轮 CLI`);
