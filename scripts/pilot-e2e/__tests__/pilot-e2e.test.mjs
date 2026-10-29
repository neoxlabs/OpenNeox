/*
 * Q-03 基准集的测试。
 *
 * 跑之前要先有 packages/*\/dist:
 *   npm run build:packages
 *   node --test scripts/pilot-e2e/__tests__/pilot-e2e.test.mjs
 *
 * 除了「5 个都过」, 还有反向用例: 把脚本改坏 (漏审批 / 多点付款 / 早报漏一条),
 * 判定必须报失败 —— 防止基准集变成永远绿的摆设。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BENCH_TASKS } from '../lib/tasks.mjs';
import { runPilotBench } from '../lib/runner.mjs';

const EXPECTED = ['wechat-reply', 'waimai-before-pay', 'parcel-status', 'morning-brief', 'laptop-ppt'];

function mutate(taskId, fn) {
  return (steps, task) => (task.id === taskId ? fn(steps) : steps);
}

test('基准集就是方案里的 5 个任务', () => {
  assert.deepEqual(BENCH_TASKS.map((t) => t.id), EXPECTED);
  for (const task of BENCH_TASKS) {
    assert.ok(task.prompt?.length > 0, `${task.id} 缺少用户原话`);
    assert.ok(task.steps.length > 0, `${task.id} 没有动作`);
    assert.equal(typeof task.check, 'function', `${task.id} 没有判定`);
  }
});

test('5 个基准任务全部通过, 并给出耗时', async () => {
  const result = await runPilotBench({ repeat: 1 });
  assert.equal(result.mode, 'sim');
  assert.equal(result.totals.tasks, 5);
  assert.equal(result.totals.runs, 5);
  assert.equal(result.totals.passed, 5, result.tasks.flatMap((t) => t.runs).filter((r) => !r.success).map((r) => `${r.taskId}: ${r.reason}`).join('; '));
  assert.equal(result.totals.successRate, 1);
  for (const task of result.tasks) {
    assert.equal(task.passed, 1, `${task.id}: ${task.runs.map((r) => r.reason).join('; ')}`);
    assert.ok(task.p50Ms >= 0, `${task.id} 没有耗时`);
  }
});

test('同一个任务重复跑结果一致 (可重复)', async () => {
  const result = await runPilotBench({ repeat: 2, taskIds: ['parcel-status', 'morning-brief'] });
  assert.equal(result.totals.runs, 4);
  assert.equal(result.totals.passed, 4);
  for (const task of result.tasks) {
    assert.equal(task.runs.length, 2);
    assert.equal(task.successRate, 1);
    assert.equal(task.runs[0].steps.length, task.runs[1].steps.length, `${task.id} 两次动作数不同`);
    assert.equal(task.runs[0].sent, task.runs[1].sent);
    assert.equal(task.runs[0].payClicks, task.runs[1].payClicks);
  }
});

test('反向用例: 没等批准就发送, 判定报失败', async () => {
  const result = await runPilotBench({
    taskIds: ['wechat-reply'],
    mutateSteps: mutate('wechat-reply', (steps) => steps.filter((s) => s.human !== 'approve')),
  });
  const run = result.tasks[0].runs[0];
  assert.equal(run.success, false);
  assert.match(run.reason, /1 条|拦下|审批/);
  assert.equal(run.sent, 0);
});

test('反向用例: 越到付款页又点了付款, 判定报失败', async () => {
  const result = await runPilotBench({
    taskIds: ['waimai-before-pay'],
    mutateSteps: mutate('waimai-before-pay', (steps) => [
      ...steps,
      { tool: 'phone', args: { action: 'phone_ui', args: { op: 'tap', target: 3, confirmed: true } } },
    ]),
  });
  const run = result.tasks[0].runs[0];
  assert.equal(run.success, false);
  assert.match(run.reason, /付款/);
  assert.equal(run.payClicks, 1);
});

test('反向用例: 早报漏一条, 判定报失败', async () => {
  const result = await runPilotBench({
    taskIds: ['morning-brief'],
    mutateSteps: mutate('morning-brief', (steps) =>
      steps.map((s) =>
        s.tool === 'report_to_user'
          ? { ...s, args: { ...s.args, summary: '今天两件事：13:30 客户会，15:00 体检。' } }
          : s,
      ),
    ),
  });
  const run = result.tasks[0].runs[0];
  assert.equal(run.success, false);
  assert.match(run.reason, /妈妈|3 条/);
});

test('CLI 一条命令跑完并写出 JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pilot-cli-'));
  const out = join(dir, 'result.json');
  try {
    execFileSync(process.execPath, ['scripts/pilot-e2e/run.mjs', '--tasks', 'parcel-status,wechat-reply', '--repeat', '1', '--json', out], {
      cwd: process.cwd(),
      stdio: 'pipe',
      timeout: 60_000,
    });
    const result = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(result.totals.tasks, 2);
    assert.equal(result.totals.passed, 2);
    assert.equal(result.totals.successRate, 1);
    assert.ok(result.totals.durationMs > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
