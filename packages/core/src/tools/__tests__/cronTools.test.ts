/**
 * cronTools — 触发链路回归测试.
 *
 *  前的 bug: setCronFireCallback 全仓库无人调用 → 调度器每 30s 算出到期
 * job 后 `if (onCronFire)` 恒 false 直接跳过, 却照常推进 lastFiredAt 并给用户返回
 * "Next run: ...". 定时任务完全不跑, 且因为 lastFiredAt 被推进, 连漏跑都查不出来.
 *
 * 这里钉死三件事:
 *   1. 注册了回调 → 到期真的调用 (并带上 dueAt/lateByMs)
 *   2. 没注册回调 → 不触发 **且不推进 lastFiredAt** (保持 pending), 回调接上后补跑
 *   3. 没注册回调时 cron_create 直接报错, 绝不返回假的 "Next run"
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  cronCreateTool,
  cronListTool,
  setCronFireCallback,
  isCronFireCallbackRegistered,
  runCronSchedulerTick,
  listAllCronJobs,
  nextCronRunMs,
  __resetCronToolsForTest,
  setCronWorkspaceRoot,
  type CronJob,
  type CronFireContext,
} from '../cronTools.js';
import { runWithChatSession } from '../../runtime/shell/chatSessionContext.js';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { computeNextFire } from '../../life/reminderScheduling.js';

const MINUTE = 60_000;

/** 建一个 session (非 durable) job — durable 会写 .neox/scheduled_tasks.json, 测试不碰盘. */
async function createJob(cron: string, prompt: string, recurring = true): Promise<any> {
  const raw = await runWithChatSession('sess-1', () =>
    cronCreateTool.function({ cron, prompt, recurring, durable: false }),
  );
  return JSON.parse(raw as string);
}

/* 所有用例固定使用临时工作区，避免 durable 任务写入仓库目录并污染其他用例。 */
let __tmpRoot: string;
beforeEach(() => {
  __tmpRoot = mkdtempSync(join(tmpdir(), 'neox-cron-root-'));
  setCronWorkspaceRoot(__tmpRoot);
});
afterEach(() => {
  setCronWorkspaceRoot(null);
  try { rmSync(__tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('cronTools fire path', () => {
  beforeEach(() => {
    __resetCronToolsForTest();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    __resetCronToolsForTest();
    vi.restoreAllMocks();
  });

  it('registered callback → a due job actually fires', async () => {
    const fires: Array<{ job: CronJob; ctx: CronFireContext }> = [];
    setCronFireCallback((job, ctx) => { fires.push({ job, ctx }); });
    expect(isCronFireCallbackRegistered()).toBe(true);

    const res = await createJob('* * * * *', 'check the build');
    expect(res.error).toBeUndefined();
    expect(res.id).toBeTruthy();

    /* 两分钟后扫一次 — "* * * * *" 早该跑了 */
    const fired = runCronSchedulerTick(Date.now() + 2 * MINUTE);

    expect(fired).toBe(1);
    expect(fires).toHaveLength(1);
    expect(fires[0].job.prompt).toBe('check the build');
    /* 派发要能找回原会话, 否则 prompt 无处投递 */
    expect(fires[0].job.sessionId).toBe('sess-1');
    expect(fires[0].ctx.dueAt).toBeLessThanOrEqual(fires[0].ctx.firedAt);
    expect(fires[0].ctx.lateByMs).toBeGreaterThanOrEqual(0);
  });

  it('recurring job keeps firing on later ticks; one-shot fires once then disappears', async () => {
    let count = 0;
    setCronFireCallback(() => { count++; });

    await createJob('* * * * *', 'recurring task', true);
    runCronSchedulerTick(Date.now() + 2 * MINUTE);
    runCronSchedulerTick(Date.now() + 4 * MINUTE);
    expect(count).toBe(2);
    expect(listAllCronJobs()).toHaveLength(1);

    __resetCronToolsForTest();
    count = 0;
    setCronFireCallback(() => { count++; });
    await createJob('* * * * *', 'one shot', false);
    runCronSchedulerTick(Date.now() + 2 * MINUTE);
    runCronSchedulerTick(Date.now() + 4 * MINUTE);
    expect(count).toBe(1);
    expect(listAllCronJobs()).toHaveLength(0);
  });

  it('fail-loud: no callback → does NOT fire, does NOT advance lastFiredAt, stays pending', async () => {
    /* 先用回调建 job (cron_create 现在会拒绝无回调的创建), 再把回调摘掉模拟未接线 runtime */
    setCronFireCallback(() => { throw new Error('should not be called'); });
    await createJob('* * * * *', 'must not be silently swallowed');
    setCronFireCallback(null);

    const fired = runCronSchedulerTick(Date.now() + 2 * MINUTE);
    expect(fired).toBe(0);

    /* job 必须保留，且 lastFiredAt 不因未执行的 tick 推进。 */
    const jobs = listAllCronJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].lastFiredAt).toBeUndefined();

    /* 而且要吵: 静默跳过正是原 bug */
    expect(console.error).toHaveBeenCalled();

    /* 回调接上 → 下一 tick 补跑 */
    const fires: CronJob[] = [];
    setCronFireCallback((job) => { fires.push(job); });
    expect(runCronSchedulerTick(Date.now() + 3 * MINUTE)).toBe(1);
    expect(fires).toHaveLength(1);
    expect(fires[0].prompt).toBe('must not be silently swallowed');
  });

  it('fail-loud: cron_create refuses (no fake "Next run") when no callback is registered', async () => {
    expect(isCronFireCallbackRegistered()).toBe(false);
    const res = await createJob('0 9 * * *', 'daily standup');

    expect(res.error).toBeTruthy();
    expect(res.nextRun).toBeUndefined();
    expect(res.message).toBeUndefined();
    /* 没有被偷偷收下 */
    expect(listAllCronJobs()).toHaveLength(0);
  });

  it('fail-loud: cron_create refuses when there is no session to dispatch into', async () => {
    setCronFireCallback(() => {});
    const raw = await cronCreateTool.function({ cron: '0 9 * * *', prompt: 'x', durable: false });
    const res = JSON.parse(raw as string);
    expect(res.error).toMatch(/active session/i);
    expect(listAllCronJobs()).toHaveLength(0);
  });

  it('cron_list reflects a scheduled job', async () => {
    setCronFireCallback(() => {});
    await createJob('30 14 * * *', 'afternoon report');
    const res = JSON.parse((await cronListTool.function({})) as string);
    expect(res.total).toBe(1);
    expect(res.jobs[0].humanSchedule).toBe('daily at 14:30');
  });

  it('late fire reports how late it is (machine was asleep)', async () => {
    const fires: CronFireContext[] = [];
    setCronFireCallback((_job, ctx) => { fires.push(ctx); });
    await createJob('* * * * *', 'late task');

    /* 模拟关机 3 小时后开机 */
    runCronSchedulerTick(Date.now() + 3 * 60 * MINUTE);
    expect(fires).toHaveLength(1);
    expect(fires[0].lateByMs).toBeGreaterThan(60 * MINUTE);
  });
});

describe('reminderScheduling cron recurrence (ESM require bug)', () => {
  it('computeNextFire({kind:"cron"}) returns a real next time, not null', () => {
    const from = new Date('2026-07-18T09:00:00').getTime();
    /* 使用 ESM 导入路径，避免动态 require 在 ESM 环境中被吞掉后导致循环提醒只执行一次。 */
    const next = computeNextFire({ kind: 'cron', spec: '0 9 * * *' } as any, from);

    expect(next).not.toBeNull();
    expect(next).toBe(nextCronRunMs('0 9 * * *', from + 1000));
    expect(next!).toBeGreaterThan(from);
  });
});

/* durable job 的契约：任务写入指定工作区；写入失败返回错误而不是成功；成功写入后可立即列出。 */
describe('durable cron 落盘', () => {
  let tmp: string;

  beforeEach(() => {
    __resetCronToolsForTest();
    setCronFireCallback(() => { /* 有回调才允许创建 */ });
    tmp = mkdtempSync(join(tmpdir(), 'neox-cron-'));
  });

  afterEach(() => {
    setCronWorkspaceRoot(null);
    __resetCronToolsForTest();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('钉了工作区就写进那个工作区, 不再跟着 process.cwd() 走', async () => {
    setCronWorkspaceRoot(tmp);
    const res = JSON.parse(await runWithChatSession('sess-d', () =>
      cronCreateTool.function({ cron: '0 9 * * *', prompt: '早报', recurring: true, durable: true }),
    ) as string);
    expect(res.error, res.error).toBeUndefined();
    expect(res.id).toBeTruthy();

    const file = join(tmp, '.neox', 'scheduled_tasks.json');
    expect(existsSync(file), '文件必须真的落在钉住的工作区里').toBe(true);
    const onDisk = JSON.parse(readFileSync(file, 'utf-8'));
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].prompt).toBe('早报');
    /* sessionId 必须一起存, 否则重启后 job 还在但无处投递 */
    expect(onDisk[0].sessionId).toBe('sess-d');
  });

  it('建完立刻 list 得到它 —— 用户实拍的正是这一步为空', async () => {
    setCronWorkspaceRoot(tmp);
    await runWithChatSession('sess-d', () =>
      cronCreateTool.function({ cron: '*/5 * * * *', prompt: '巡检', recurring: true, durable: true }),
    );
    const listed = JSON.parse(await cronListTool.function({}) as string);
    expect(listed.jobs).toHaveLength(1);
    expect(listed.jobs[0].durable).toBe(true);
    expect(listAllCronJobs()).toHaveLength(1);
  });

  it('写不进去必须报错, 不许回一个假的 id', async () => {
    /* 指向一个不可能建出来的路径: 用一个**文件**当工作区根 */
    const asFile = join(tmp, 'not-a-dir');
    writeFileSync(asFile, 'x', 'utf-8');
    setCronWorkspaceRoot(asFile);

    const res = JSON.parse(await runWithChatSession('sess-d', () =>
      cronCreateTool.function({ cron: '0 9 * * *', prompt: '早报', recurring: true, durable: true }),
    ) as string);
    expect(res.id, '失败时绝不能给 id —— 那正是"建了等于没建"的来源').toBeUndefined();
    expect(String(res.error)).toMatch(/Failed to persist durable cron job/);
    expect(String(res.hint)).toContain('durable=false');
  });

  it('session job 不落盘, 不受工作区影响', async () => {
    setCronWorkspaceRoot(tmp);
    await createJob('*/10 * * * *', '内存任务');
    expect(existsSync(join(tmp, '.neox', 'scheduled_tasks.json'))).toBe(false);
    expect(listAllCronJobs()).toHaveLength(1);
  });
});
