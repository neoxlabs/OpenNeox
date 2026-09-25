import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { TASKS, reset, loginViaApi } from '../tasks/tasks.mjs';

const CLI = '/Users/exampleuser/AI/OpenNeox/packages/neox-cli/dist/cli/main.js';
const WORKDIR = '/Users/exampleuser/AI/MK/neox-webbench';
const TIMEOUT_S = Number(process.env.BENCH_TIMEOUT || 240);
const MODEL = process.env.BENCH_MODEL || 'deepseek-v4.1-flash-expires-on-0910';
const PROVIDER = process.env.BENCH_PROVIDER || 'deepseekmk';

const want = process.argv.slice(2);
const list = want.length ? TASKS.filter((t) => want.includes(t.id)) : TASKS;

function run(args, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile('node', [CLI, ...args], { cwd: WORKDIR, maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs },
      (err, stdout, stderr) => resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), ms: Date.now() - started, err: err?.message }));
  });
}

/** 同 agent.mjs: 往返看 run_result.data.iterations */
function iterationsFromLog(from, to) {
  const root = join(homedir(), '.neox', 'workspaces');
  let iterations = 0;
  if (!existsSync(root)) return iterations;
  for (const dir of readdirSync(root)) {
    const ev = join(root, dir, 'events');
    if (!existsSync(ev)) continue;
    for (const f of readdirSync(ev).filter((x) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)).slice(-2)) {
      for (const line of readFileSync(join(ev, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.ts < from || e.ts > to) continue;
        if (e.type === 'run_result') iterations += Number(e.data?.iterations ?? 0);
      }
    }
  }
  return iterations;
}

const recipeName = (id) => `bench-${id}`;
const recipeDir = (id) => join(homedir(), '.neox', 'skills', recipeName(id));

const results = [];
for (const task of list) {
  rmSync(recipeDir(task.id), { recursive: true, force: true });

  /* ① 首跑 + 录制 */
  await reset();
  if (task.needsLogin) await loginViaApi();
  const prompt = `${task.prompt}\n\n做完之后, 把完整流程作为**一条** browser_run 脚本重新跑一遍并录制: `
    + `record:"${recipeName(task.id)}", 脚本从 navigate 开始, 结尾用 expect 步骤断言结果。录制只在整段成功时保存。`;
  const from = Date.now();
  const first = await run(['-p', prompt, '-m', MODEL, '--provider', PROVIDER, '--yolo', '--timeout', String(TIMEOUT_S)], (TIMEOUT_S + 30) * 1000);
  await new Promise((s) => setTimeout(s, 1200));
  const iterations = iterationsFromLog(from, Date.now() + 2000);
  const recorded = existsSync(join(recipeDir(task.id), 'SKILL.md'));

  /* ② 回放: 重置靶站, 不给模型 */
  let replay = null; let replayOk = false; let why = '';
  if (recorded) {
    await reset();
    if (task.needsLogin) await loginViaApi();
    const r = await run(['browser', 'replay', recipeName(task.id), '--json', '--timeout', '60000'], 90_000);
    try { replay = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { why = 'replay 输出不是 JSON: ' + r.stdout.slice(-120); }
    if (replay) {
      const row = replay.rows?.[0];
      const v = await task.verify();
      replayOk = !!row?.ok && v.ok;
      if (!row?.ok) why = `回放第 ${row?.failedAt} 步失败: ${row?.error ?? ''}`.slice(0, 160);
      else if (!v.ok) why = `回放说过了但服务端没变: ${v.why}`;
      else if (v.expectNumbers) why = '(统计类: 服务端无状态可核, 只看回放跑完)';
    }
  } else {
    why = '首跑没录下来 (脚本没整段成功, 或模型没按要求 record)';
  }

  results.push({
    id: task.id, level: task.level,
    firstMs: first.ms, iterations, recorded,
    replayMs: replay?.rows?.[0]?.ms ?? null, replayOk, why,
  });
  console.error(`· ${task.id} 首跑 ${(first.ms / 1000).toFixed(1)}s/${iterations}往返 · 录制 ${recorded ? '✓' : '✗'} · 回放 ${replay ? `${replay.rows?.[0]?.ms}ms ${replayOk ? '✓' : '✗'}` : '—'}`);
}

console.log('\n任务'.padEnd(16) + '档   首跑墙钟  首跑往返   录制   回放耗时   回放结果');
console.log('─'.repeat(96));
for (const r of results) {
  console.log(
    r.id.padEnd(16) + r.level.padEnd(5)
    + `${(r.firstMs / 1000).toFixed(1)}s`.padStart(8)
    + String(r.iterations).padStart(9)
    + (r.recorded ? '✓' : '✗').padStart(8)
    + (r.replayMs !== null ? `${r.replayMs}ms` : '—').padStart(11)
    + '   ' + (r.replayOk ? '✓' : '✗') + (r.why ? ` ${r.why}` : ''),
  );
}
console.log('─'.repeat(96));
const passed = results.filter((r) => r.replayOk).length;
const totalReplay = results.reduce((n, r) => n + (r.replayMs ?? 0), 0);
console.log(`首跑合计 ${(results.reduce((n, r) => n + r.firstMs, 0) / 1000).toFixed(1)}s · ${results.reduce((n, r) => n + r.iterations, 0)} 往返 → 回放合计 ${totalReplay}ms · 0 往返 · ${passed}/${results.length} 回放通过`);
console.log(`模型: ${MODEL} @ ${PROVIDER}`);
process.exit(0);
