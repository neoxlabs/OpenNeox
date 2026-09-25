/**
 * Agent 跑分 —— 让真 agent 做同一批任务, 跟 floor.mjs 的下限比。
 *
 * 量三件事:
 *   · 墙钟时长      跟下限比 = "慢了多少倍"
 *   · 模型往返次数  这是真正的成本 (98% 的时间在这里)
 *   · 做成了没有    **查服务端状态**, 不看 agent 自述
 *
 * 往返次数从 action log 里数 —— agent 每轮 LLM 调用会落一条 run_attempt,
 * 每个工具调用落一对 tool_call_start/end。跑完按时间窗捞出来。
 *
 * 用法:
 *   node runner/agent.mjs                # 全部任务
 *   node runner/agent.mjs login report   # 指定几个
 */
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { TASKS, reset, loginViaApi } from '../tasks/tasks.mjs';

const CLI = '/Users/exampleuser/AI/OpenNeox/packages/neox-cli/dist/cli/main.js';
const WORKDIR = '/Users/exampleuser/AI/MK/neox-webbench';
const TIMEOUT_S = Number(process.env.BENCH_TIMEOUT || 240);
const MODEL = process.env.BENCH_MODEL || 'deepseek-v4-pro';
const PROVIDER = process.env.BENCH_PROVIDER || 'opencode-zen';

const want = process.argv.slice(2);
const list = want.length ? TASKS.filter((t) => want.includes(t.id)) : TASKS;

/** 跑一次 agent, 返回 { stdout, ms } */
function runAgent(prompt) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile('node', [CLI, '-p', prompt, '-m', MODEL, '--provider', PROVIDER,
      '--yolo', '--timeout', String(TIMEOUT_S)],
      { cwd: WORKDIR, maxBuffer: 32 * 1024 * 1024, timeout: (TIMEOUT_S + 30) * 1000 },
      (err, stdout, stderr) => {
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), ms: Date.now() - started, err: err?.message });
      });
  });
}

function countFromLog(from, to) {
  const root = join(homedir(), '.neox', 'workspaces');
  let iterations = 0, tools = 0, toolMs = 0, tokens = 0;
  const names = [];
  const open = new Map();   /* toolId → start ts */
  if (!existsSync(root)) return { iterations, tools, toolMs, tokens, names };
  for (const dir of readdirSync(root)) {
    const ev = join(root, dir, 'events');
    if (!existsSync(ev)) continue;
    for (const f of readdirSync(ev).filter((x) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)).slice(-2)) {
      for (const line of readFileSync(join(ev, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.ts < from || e.ts > to) continue;
        if (e.type === 'run_result') {
          iterations += Number(e.data?.iterations ?? 0);
          tokens += Number(e.data?.totalTokens ?? 0);
        }
        if (e.type === 'tool_call_start' && e.data?.toolId) open.set(e.data.toolId, e.ts);
        if (e.type === 'tool_call_end') {
          tools++;
          const n = e.data?.name; if (n) names.push(n);
          const s0 = e.data?.toolId ? open.get(e.data.toolId) : undefined;
          if (s0) { toolMs += e.ts - s0; open.delete(e.data.toolId); }
        }
      }
    }
  }
  return { iterations, tools, toolMs, tokens, names };
}

const results = [];
for (const task of list) {
  await reset();
  if (task.needsLogin) await loginViaApi();   /* 登录不是这个任务要考的, 直接给它 */

  const from = Date.now();
  const r = await runAgent(task.prompt);
  const to = Date.now() + 2000;
  await new Promise((s) => setTimeout(s, 1200));   /* 等 action log flush */
  const counts = countFromLog(from, to);

  const v = await task.verify();
  let ok = v.ok;
  const notes = [];

  /* 只查状态还不够: 有些任务考的是"说得对不对" */
  if (v.needsHonestReport) {
    const honest = v.needsHonestReport.some((w) => r.stdout.includes(w));
    if (!honest) { ok = false; notes.push('没有如实报告失败'); }
  }
  if (v.expectNumbers) {
    const missing = v.expectNumbers.filter((n) => !new RegExp(`\\b${n}\\b`).test(r.stdout));
    if (missing.length) { ok = false; notes.push(`回答里缺数字 ${missing.join('/')}`); }
  }
  if (r.err) notes.push(r.err.slice(0, 50));

  results.push({
    id: task.id, level: task.level, ok, why: v.why, notes,
    ms: r.ms, iterations: counts.iterations, tokens: counts.tokens, tools: counts.tools, toolMs: counts.toolMs,
    names: counts.names,
    tail: r.stdout.replace(/\s+/g, ' ').trim().slice(-160),
  });
  console.error(`· ${task.id} ${ok ? '✓' : '✗'} ${(r.ms / 1000).toFixed(1)}s 往返${counts.iterations} 工具${counts.tools}`);
}

console.log('\n任务'.padEnd(16) + '档   墙钟     往返  工具  工具耗时  等模型   token   结果');
console.log('─'.repeat(96));
for (const r of results) {
  console.log(
    r.id.padEnd(16) + r.level.padEnd(5) +
    `${(r.ms / 1000).toFixed(1)}s`.padStart(7) +
    String(r.iterations).padStart(6) + String(r.tools).padStart(6) +
    `${(r.toolMs / 1000).toFixed(1)}s`.padStart(9) +
    `${Math.round((1 - r.toolMs / r.ms) * 100)}%`.padStart(8) +
    String(r.tokens).padStart(8) + '   ' +
    (r.ok ? '✓' : `✗ ${[r.why, ...r.notes].filter(Boolean).join(' / ')}`),
  );
}
const T = (k) => results.reduce((n, r) => n + r[k], 0);
console.log('─'.repeat(96));
console.log(`合计 ${(T('ms') / 1000).toFixed(1)}s · 往返 ${T('iterations')} 次 · 工具 ${T('tools')} 次 (${(T('toolMs') / 1000).toFixed(1)}s)`
  + ` · 等模型 ${Math.round((1 - T('toolMs') / T('ms')) * 100)}% · ${T('tokens')} token · ${results.filter((r) => r.ok).length}/${results.length} 通过`);
console.log(`工具用了: ${[...new Set(results.flatMap((r) => r.names))].join(', ') || '(没记到)'}`);
console.log(`模型: ${MODEL} @ ${PROVIDER}`);
process.exit(0);
