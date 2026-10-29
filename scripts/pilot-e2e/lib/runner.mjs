/*
 * Q-03 基准集 runner: 一条命令把 5 个任务跑完, 给出成功率与耗时。
 *
 * 跑的是 packages/core 里的真 PilotHome: instructions / 审批卡 / deliver_file /
 * 工具执行器都是生产代码; 只有云端控制面和手机屏幕是替身 (fakePilotBackend + deviceSim)。
 * 同一个任务重复 N 次, 每次用新的临时工作目录, 结果可重复。
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeServices } from '../../../packages/platform/dist/platform/nodeServices.js';
import { setToolServices } from '../../../packages/core/dist/tools/runtimeTools.js';
import { executeShell } from '../../../packages/core/dist/tools/runtimeTools.js';
import { reportToUserTool } from '../../../packages/core/dist/tools/reportTools.js';
import { listPendingTasksTool } from '../../../packages/core/dist/tools/reminderTools.js';
import { PilotHome, runInPilot } from '../../../packages/core/dist/cloud-runtime/pilotHome.js';
import { runWithWorkspaceRoot } from '../../../packages/kernel/dist/tools/workspaceContext.js';
import { createFakePilotBackend } from './fakePilotBackend.mjs';
import { createSimDevice } from './deviceSim.mjs';
import { BENCH_TASKS, FIXED_NOW, benchTaskById } from './tasks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PPTX_SCRIPT = join(HERE, 'make-pptx.mjs');
export const REPO_ROOT = join(HERE, '..', '..', '..');

const DATA_BASE = 'http://pilot-data.local/api/v1/pilot/data';
const PILOT_BASE = 'http://pilot.local';

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarizeRuns(runs) {
  const durations = runs.map((r) => r.durationMs);
  const passed = runs.filter((r) => r.success).length;
  return {
    runCount: runs.length,
    passed,
    successRate: runs.length ? passed / runs.length : 0,
    p50Ms: percentile(durations, 50),
    p90Ms: percentile(durations, 90),
    avgMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
  };
}

async function runOnce(task, options) {
  const startedAt = performance.now();
  const workspace = await mkdtemp(join(tmpdir(), 'neox-pilot-bench-'));

  let seq = 0;
  const tick = () => FIXED_NOW + (seq += 1);
  let savedNow;
  let backend;
  const steps = [];

  try {
    backend = createFakePilotBackend({
      now: tick,
      memories: task.fixture?.memories ?? [],
      reminders: task.fixture?.reminders ?? [],
      profileText: task.fixture?.profileText ?? '',
    });
    backend.install();
    process.env.PILOT_DATA_BASE_URL = DATA_BASE;

    const device = createSimDevice({
      now: tick,
      notifications: task.fixture?.notifications ?? [],
      sms: task.fixture?.sms ?? [],
      contacts: task.fixture?.contacts ?? [],
      isSendApproved: () => backend.state.reports.some((r) => r.status === 'approved'),
    });

    /* 固定「现在」: 提醒时间的格式化与窗口过滤都是按本地时间算的, 不钉住就不可重复 */
    savedNow = Date.now;
    Date.now = () => FIXED_NOW;

    const home = new PilotHome(
      { pilotId: 'p1', timezone: 'Asia/Shanghai' },
      PILOT_BASE,
      () => 'bench-jwt',
      null,
      workspace,
    );
    home.installExecutors(
      (req) => device.executor(req),
      async ({ tool }) => ({ ok: true, output: tool === 'calendar_events' ? '(今天没有别的日程)' : '(电脑替身: 没有可返回的内容)' }),
    );
    await home.refresh();

    const tools = new Map();
    for (const t of home.tools()) tools.set(t.name, t);
    tools.set('report_to_user', reportToUserTool);
    tools.set('list_pending_tasks', listPendingTasksTool);
    tools.set('execute_shell', executeShell);
    setToolServices(createNodeServices());

    const taskSteps = options.mutateSteps ? options.mutateSteps(task.steps, task) : task.steps;
    const ctx = { backend, device, workspace, pptxScript: PPTX_SCRIPT, results: steps, task };

    for (const step of taskSteps) {
      const t0 = performance.now();
      if (step.human === 'approve') {
        const card = backend.approveLatestBlocked();
        steps.push({ kind: 'human', tool: 'approve', ok: Boolean(card), ms: Math.round(performance.now() - t0), output: card ? `approved ${card.id}` : 'no blocked card' });
        continue;
      }
      const tool = tools.get(step.tool);
      const args = typeof step.args === 'function' ? step.args(ctx) : step.args;
      if (!tool) {
        steps.push({ kind: 'tool', tool: step.tool, ok: false, ms: 0, output: 'tool not found' });
        continue;
      }
      let output = '';
      let ok = false;
      try {
        output = String(await runInPilot(home, () => runWithWorkspaceRoot(workspace, () => tool.function(args))));
        try {
          const parsed = JSON.parse(output);
          ok = parsed?.success !== false && !parsed?.error;
        } catch {
          ok = !/error/i.test(output);
        }
      } catch (err) {
        output = `throw: ${err?.message ?? err}`;
        ok = false;
      }
      steps.push({ kind: 'tool', tool: step.tool, ok, ms: Math.round(performance.now() - t0), output: output.slice(0, 400) });
    }

    const verdict = task.check({ backend, device, workspace, steps });
    const fileSize = await stat(join(workspace, '周会.pptx')).then((s) => s.size).catch(() => 0);
    return {
      taskId: task.id,
      title: task.title,
      success: Boolean(verdict.ok),
      reason: verdict.reason,
      durationMs: Math.round(performance.now() - startedAt),
      steps,
      fileSizeBytes: fileSize,
      reports: backend.state.reports.map((r) => ({ status: r.status, title: r.title, summary: r.summary })),
      sent: device.state.sent.length,
      payClicks: device.state.payClicks,
      screen: device.snapshot(),
    };
  } finally {
    if (savedNow) Date.now = savedNow;
    backend?.restore();
    delete process.env.PILOT_DATA_BASE_URL;
    if (options.keepTemp) {
      process.stdout.write(`  [keep] ${workspace}\n`);
    } else {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

export async function runPilotBench(options = {}) {
  const repeat = Math.max(1, Number(options.repeat ?? 1));
  const ids = options.taskIds?.length ? options.taskIds : BENCH_TASKS.map((t) => t.id);
  const startedAt = new Date().toISOString();
  const tasks = [];

  for (const id of ids) {
    const task = benchTaskById(id);
    if (!task) throw new Error(`unknown benchmark task: ${id}`);
    const runs = [];
    for (let i = 0; i < repeat; i += 1) {
      const run = await runOnce(task, options);
      runs.push(run);
      if (options.onRun) options.onRun(task, run, i);
    }
    tasks.push({ id: task.id, title: task.title, kind: task.kind, ...summarizeRuns(runs), runs });
  }

  const allRuns = tasks.flatMap((t) => t.runs);
  const durations = allRuns.map((r) => r.durationMs);
  const passed = allRuns.filter((r) => r.success).length;
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    mode: 'sim',
    repeat,
    totals: {
      tasks: tasks.length,
      runs: allRuns.length,
      passed,
      failed: allRuns.length - passed,
      successRate: allRuns.length ? passed / allRuns.length : 0,
      p50Ms: percentile(durations, 50),
      p90Ms: percentile(durations, 90),
      avgMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
      durationMs: allRuns.reduce((n, r) => n + r.durationMs, 0),
    },
    tasks,
  };
}
