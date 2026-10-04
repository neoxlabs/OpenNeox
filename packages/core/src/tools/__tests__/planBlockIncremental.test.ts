/**
 * 战略块使用增量更新，不要求每次调用传递完整计划。
 *
 * 这个用例固定以下性质:
 *   · 一次 plan_block 只说一个块, 输入里**不含**其它块
 *   · 几百个块时单次调用的成本不随规模涨
 *   · 返回只给摘要, 不回全量清单 (否则输出端又爆了)
 *   · complete 必须给证据; drop 必须给理由 (不许默默跳过工作)
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  activateTargetFromCommand, planTargetTool, planBlockTool, checkTargetDoneTool,
  grantTargetConsent, runWithTargetSession, resetTargetMode, getCurrentTargetPlan,
} from '../targetModeTools.js';

const SID = 'test-session-plan-block';
const call = <T>(fn: () => T): T => runWithTargetSession(SID, fn);
const parse = (s: string) => JSON.parse(s) as Record<string, any>;

/** 造一个"几百个需求"的初始计划 */
const bigPlan = (n: number) => ({
  target: '把这个系统按需求文档全部实现',
  sub_missions: Array.from({ length: n }, (_, i) => ({
    id: `b${i + 1}`,
    description: `需求模块 ${i + 1}: 实现并测试`,
    status: 'pending' as const,
  })),
});

describe('plan_block 增量更新', () => {
  beforeEach(async () => {
    await call(() => resetTargetMode());
    grantTargetConsent(SID);
    call(() => activateTargetFromCommand('把这个系统按需求文档全部实现'));
    await call(() => planTargetTool.function(bigPlan(300), undefined as any));
  });

  it('300 个块建起来了', () => {
    expect(getCurrentTargetPlan(SID)?.sub_missions.length).toBe(300);
  });

  it('推进一个块只需要说这一个 —— 入参里没有其它块', async () => {
    const started = parse(await call(() => planBlockTool.function({ op: 'start', id: 'b7' }, undefined as any)));
    expect(started.ok).toBe(true);
    const completed = parse(await call(() => planBlockTool.function(
      { op: 'complete', id: 'b7', evidence: 'test/mod7.test.ts 12 个用例全绿' }, undefined as any)));
    expect(completed.ok).toBe(true);
    expect(completed.progress).toBe('1/300');
    const plan = getCurrentTargetPlan(SID)!;
    expect(plan.sub_missions.find((b) => b.id === 'b7')?.status).toBe('completed');
    /* 其它 299 个块不受影响 —— 全量替换时代最容易在这里丢东西 */
    expect(plan.sub_missions.filter((b) => b.status === 'pending').length).toBe(299);
  });

  it('返回的是摘要, 不是全量清单 (否则输出端照样爆)', async () => {
    const r = parse(await call(() => planBlockTool.function({ op: 'start', id: 'b3' }, undefined as any)));
    expect(r.progress).toBeDefined();
    expect(r.remaining).toBe(300);
    /* nextPending 只给几个开胃菜, 不是 300 条 */
    expect(Array.isArray(r.nextPending) ? r.nextPending.length : 0).toBeLessThanOrEqual(3);
    expect(JSON.stringify(r).length).toBeLessThan(1200);
  });

  it('计划可以长大 —— 中途发现的新需求直接 add', async () => {
    const r = parse(await call(() => planBlockTool.function({
      op: 'add',
      blocks: [{ description: '新发现: 导出 CSV' }, { description: '新发现: 审计日志' }],
    }, undefined as any)));
    expect(r.ok).toBe(true);
    expect(getCurrentTargetPlan(SID)?.sub_missions.length).toBe(302);
  });

  it('同一时刻只允许一个 in_progress', async () => {
    await call(() => planBlockTool.function({ op: 'start', id: 'b1' }, undefined as any));
    await call(() => planBlockTool.function({ op: 'start', id: 'b2' }, undefined as any));
    const inProgress = getCurrentTargetPlan(SID)!.sub_missions.filter((b) => b.status === 'in_progress');
    expect(inProgress.map((b) => b.id)).toEqual(['b2']);
  });

  it('complete 不给证据就不算完成', async () => {
    const r = parse(await call(() => planBlockTool.function({ op: 'complete', id: 'b1' }, undefined as any)));
    expect(r.error).toMatch(/evidence/i);
    expect(getCurrentTargetPlan(SID)!.sub_missions.find((b) => b.id === 'b1')?.status).not.toBe('completed');
  });

  it('drop 必须说清为什么 —— 默默跳过工作正是要防的', async () => {
    const r = parse(await call(() => planBlockTool.function({ op: 'drop', id: 'b2' }, undefined as any)));
    expect(r.error).toMatch(/why/i);
    expect(getCurrentTargetPlan(SID)!.sub_missions.length).toBe(300);
  });

  /* schema 约束不替代运行时校验；空 description 必须由代码层拒绝。 */
  it('块的描述不能是空的 —— 只剩一串 b1/b2 等于没有计划', async () => {
    await call(() => resetTargetMode());
    grantTargetConsent(SID);
    call(() => activateTargetFromCommand('随便什么目标'));
    const r = parse(await call(() => planTargetTool.function({
      target: '随便什么目标',
      sub_missions: [
        { id: 'b1', description: '实现存储层', status: 'pending' },
        { id: 'b2', description: '', status: 'pending' },
        { id: 'b3', status: 'pending' },
      ],
    }, undefined as any)));
    expect(r.error).toMatch(/empty description/i);
    expect(r.blankIds).toEqual(['b2', 'b3']);
    expect(getCurrentTargetPlan(SID)?.sub_missions ?? []).toHaveLength(0);
  });

  it('add 进来的新块同样不许空描述 (静默过滤会让模型以为加成功了)', async () => {
    const r = parse(await call(() => planBlockTool.function({
      op: 'add', blocks: [{ description: '导出 CSV' }, { description: '   ' }],
    }, undefined as any)));
    expect(r.error).toMatch(/empty description/i);
  });

  it('还有块没完成就不许宣布目标达成', async () => {
    const r = parse(await call(() => checkTargetDoneTool.function({ done: true, reason: '差不多了' }, undefined as any)));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not marked completed/i);
    expect(Array.isArray(r.openBlocks)).toBe(true);
  });
});
