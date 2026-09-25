#!/usr/bin/env node
/**
 * behavior-suite/run — 行为考场 runner.
 *
 *   10 个带陷阱的 agentic 任务 (fixtures/<task-id>/{setup.ts,task.md,assert.ts}),
 *   每任务: fresh fixture (临时 git 仓库) → 真 CLI `neox -p` (tsx main.ts, 真 LLM)
 *   → 可编程断言 → pass/fail. 同任务跑 n 次 (默认 3, n≥3 是铁律) 取多数.
 *
 *   用法 (在 packages/evals 下):
 *     npm run eval:behavior                                  # 全量, deepseek-v4-pro, n=3
 *     npm run eval:behavior -- --model deepseek-v4-flash     # 换模型
 *     npm run eval:behavior -- --tasks dont-touch,wrong-test # 只跑指定任务
 *     npm run eval:behavior -- --runs 1                      # 快速冒烟 (正式基线必须 n≥3)
 *     npm run eval:behavior -- --save-baseline               # 存 baselines/behavior-<model>.json
 *     npm run eval:behavior -- --gate                        # 低于 baseline 的 majorityScore → exit 1 (CI 用)
 *
 *   输出:
 *     behavior-results/<date>_<model>.json      raw (逐 run 逐断言)
 *     baselines/behavior-<model>.json           --save-baseline 时
 *
 *   judge (report-quality 任务) 需要 env NEOX_JUDGE_KEY / DEEPSEEK_API_KEY,
 *   没 key 自动降级为纯程序化断言.
 */

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIXTURES_DIR, REPO_ROOT,
  driveAgent, loadTaskPrompt, makeWorkDir,
  type AssertResult, type FixtureModule,
} from './harness.js';

const EVALS_ROOT = join(REPO_ROOT, 'packages', 'evals');
const RESULTS_DIR = join(EVALS_ROOT, 'behavior-results');
const BASELINES_DIR = join(EVALS_ROOT, 'baselines');

/** 任务清单 — 顺序即报告顺序. 每个 id 对应 fixtures/<id>/. */
const TASK_IDS = [
  'cross-file-root-cause',
  'blast-radius',
  'dont-touch',
  'verify-discipline',
  'wrong-test',
  'minimal-change',
  'exploration-depth',
  'dead-end-recovery',
  'instruction-conflict',
  'report-quality',
  'mode-assistant-act',
  'mode-assistant-no-shell',
  'mode-work-revise',
] as const;

/* ============================================================
 * CLI args
 * ============================================================ */

interface Args {
  model: string;
  provider: string;
  runs: number;
  tasks: string[];
  timeoutMs: number;
  concurrency: number;
  gate: boolean;
  saveBaseline: boolean;
  keepFailures: boolean;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = a.indexOf(flag);
    return i >= 0 && a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : undefined;
  };
  return {
    model: get('--model') || get('-m') || 'deepseek-v4-pro',
    provider: get('--provider') || 'deepseek',
    runs: Number(get('--runs')) || 3,
    tasks: (get('--tasks') || '').split(',').map((s) => s.trim()).filter(Boolean),
    timeoutMs: Number(get('--timeout')) || 300_000,
    concurrency: Number(get('--concurrency')) || 3,
    gate: a.includes('--gate'),
    saveBaseline: a.includes('--save-baseline'),
    keepFailures: a.includes('--keep-failures'),
  };
}

/* ============================================================
 * 单次执行
 * ============================================================ */

interface RunRecord {
  runIdx: number;
  pass: boolean;
  durationMs: number;
  timedOut: boolean;
  exitCode: number | null;
  checks: AssertResult['checks'];
  workDirKept?: string;
  fatal?: string;
}

interface TaskReport {
  id: string;
  runs: RunRecord[];
  passes: number;
  majority: boolean;
}

async function runOnce(taskId: string, runIdx: number, args: Args): Promise<RunRecord> {
  const workDir = makeWorkDir(taskId);
  try {
    const mod = (await import(join(FIXTURES_DIR, taskId, 'setup.ts'))) as Pick<FixtureModule, 'setup' | 'env'>;
    const asserter = (await import(join(FIXTURES_DIR, taskId, 'assert.ts'))) as Pick<FixtureModule, 'assert'>;
    await mod.setup(workDir);
    const prompt = loadTaskPrompt(taskId);

    const outcome = await driveAgent(workDir, prompt, {
      provider: args.provider,
      model: args.model,
      timeoutMs: args.timeoutMs,
      env: mod.env,
    });

    const result = await asserter.assert({ ...outcome, workDir });
    const rec: RunRecord = {
      runIdx,
      pass: result.pass,
      durationMs: outcome.durationMs,
      timedOut: outcome.timedOut,
      exitCode: outcome.exitCode,
      checks: result.checks,
    };
    if (!result.pass && args.keepFailures) {
      rec.workDirKept = workDir;
    } else {
      rmSync(workDir, { recursive: true, force: true });
    }
    return rec;
  } catch (e: any) {
    if (!args.keepFailures) rmSync(workDir, { recursive: true, force: true });
    return {
      runIdx, pass: false, durationMs: 0, timedOut: false, exitCode: null,
      checks: [], fatal: e?.message || String(e),
      workDirKept: args.keepFailures ? workDir : undefined,
    };
  }
}

/** 极简并发池 — (task, run) 对全独立 (各自临时目录 + 独立 CLI 进程). */
async function pool<T>(jobs: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results;
}

/* ============================================================
 * main
 * ============================================================ */

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

async function main() {
  const args = parseArgs();
  const taskIds = args.tasks.length > 0
    ? TASK_IDS.filter((id) => args.tasks.includes(id))
    : [...TASK_IDS];
  if (taskIds.length === 0) {
    console.error(`没匹配到任务. 可选: ${TASK_IDS.join(', ')}`);
    process.exit(2);
  }

  console.log('━━━ Neox Behavior Suite ━━━');
  console.log(`model: ${args.provider}/${args.model}  runs: ${args.runs}  concurrency: ${args.concurrency}  timeout: ${args.timeoutMs / 1000}s`);
  console.log(`tasks (${taskIds.length}): ${taskIds.join(', ')}`);
  if (args.runs < 3) console.log('⚠️  runs < 3 — 只可用于冒烟, 正式基线 n≥3 是铁律');
  if (!process.env.NEOX_JUDGE_KEY && !process.env.DEEPSEEK_API_KEY) {
    console.log('⚠️  没有 NEOX_JUDGE_KEY/DEEPSEEK_API_KEY — report-quality 的 LLM judge 会降级跳过');
  }
  console.log('');

  const t0 = Date.now();

  /* 组 (task, run) 任务矩阵 → 并发池 */
  const jobs: Array<() => Promise<{ taskId: string; rec: RunRecord }>> = [];
  for (const taskId of taskIds) {
    for (let r = 0; r < args.runs; r++) {
      jobs.push(async () => {
        const rec = await runOnce(taskId, r, args);
        const tag = rec.pass ? '✓' : '✗';
        const failed = rec.fatal
          ? `FATAL ${rec.fatal.slice(0, 60)}`
          : rec.checks.filter((c) => !c.pass && !c.optional).map((c) => c.name).join('; ');
        console.log(`  ${tag} ${pad(taskId, 24)} run#${rec.runIdx + 1}  ${pad((rec.durationMs / 1000).toFixed(0) + 's', 6)}${rec.timedOut ? ' ⏱ TIMEOUT' : ''}${failed ? `  [${failed.slice(0, 100)}]` : ''}`);
        return { taskId, rec };
      });
    }
  }
  const flat = await pool(jobs, args.concurrency);

  /* 聚合 per-task */
  const tasks: TaskReport[] = taskIds.map((id) => {
    const runs = flat.filter((f) => f.taskId === id).map((f) => f.rec).sort((a, b) => a.runIdx - b.runIdx);
    const passes = runs.filter((r) => r.pass).length;
    return { id, runs, passes, majority: passes >= Math.floor(args.runs / 2) + 1 };
  });

  const majorityScore = tasks.filter((t) => t.majority).length;
  const totalRuns = tasks.reduce((s, t) => s + t.runs.length, 0);
  const totalPasses = tasks.reduce((s, t) => s + t.passes, 0);

  /* 报告 */
  console.log('');
  console.log('━━ Summary ━━');
  for (const t of tasks) {
    const dots = t.runs.map((r) => (r.pass ? '●' : '○')).join('');
    console.log(`  ${t.majority ? '✓' : '✗'} ${pad(t.id, 24)} ${dots}  ${t.passes}/${t.runs.length}`);
  }
  console.log('');
  console.log(`majority score: ${majorityScore}/${tasks.length}   per-run pass: ${totalPasses}/${totalRuns} (${(totalPasses / Math.max(totalRuns, 1) * 100).toFixed(0)}%)   wall: ${((Date.now() - t0) / 1000 / 60).toFixed(1)}min`);

  const report = {
    suite: 'behavior-suite',
    date: new Date().toISOString(),
    model: args.model,
    provider: args.provider,
    runs: args.runs,
    timeoutMs: args.timeoutMs,
    majorityScore,
    totalTasks: tasks.length,
    perRunPassRate: totalPasses / Math.max(totalRuns, 1),
    tasks,
  };

  mkdirSync(RESULTS_DIR, { recursive: true });
  const stem = `${report.date.slice(0, 10)}_${args.model.replace(/[^\w.-]/g, '_')}`;
  const outPath = join(RESULTS_DIR, `${stem}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`raw: ${outPath}`);

  /* baseline */
  const baselineName = `behavior-${args.model.replace(/^deepseek-/, '')}.json`;
  const baselinePath = join(BASELINES_DIR, baselineName);
  if (args.saveBaseline) {
    mkdirSync(BASELINES_DIR, { recursive: true });
    writeFileSync(baselinePath, JSON.stringify(report, null, 2));
    console.log(`✦ baseline saved: ${baselinePath}`);
  }

  /* gate — 对齐 release-suite --gate 语义: 相对 baseline 回退 → exit 1 */
  if (args.gate) {
    if (!existsSync(baselinePath)) {
      console.log(`gate: 无 baseline (${baselinePath}), 跳过 (先 --save-baseline)`);
    } else {
      const base = JSON.parse(readFileSync(baselinePath, 'utf-8'));
      const baseScore = Number(base.majorityScore ?? 0);
      if (majorityScore < baseScore) {
        console.log(`✗ GATE FAILED — majority ${majorityScore}/${tasks.length} < baseline ${baseScore} (${base.date?.slice(0, 10)})`);
        process.exit(1);
      }
      console.log(`gate: OK (${majorityScore} ≥ baseline ${baseScore})`);
    }
  }
}

main().then(() => {
  /* CLI 子进程走 execa cleanup, 这里显式退防悬挂句柄 */
  process.exit(process.exitCode ?? 0);
}).catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
