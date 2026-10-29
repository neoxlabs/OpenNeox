/**
 * Verify execution scheduling, concurrency queuing, scope enforcement, and
 * contract-ready notifications for team tasks.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TeamPlan } from '../teamPlanStore.js';
import {
  startTeamExec, getTeamExec, clearTeamExec, updateTask, advanceWave,
  runnableTasks, checkTerritory, execProgress, registerExecAgent,
} from '../teamExecStore.js';
import { runTeamExecution } from '../teamExecutor.js';
import { setTeamPlanPersistence } from '../teamPlanStore.js';

const SID = 'sess-exec';

/** 两批活: PLT-1/BIL-2 无前置 (第 1 批), PLT-2 等 PLT-1, BIL-1 等 PLT-2 */
function makePlan(): TeamPlan {
  const leaf = (id: string, member: string, deps: string[] = []) => ({
    id, title: `${id} 的活`, kind: 'leaf' as const, estimateDays: 2,
    acceptance: 'x', detail: 'y', dependsOn: deps, module: 'm', status: 'todo' as const,
  });
  return {
    teamId: 'team_x', sessionId: SID, goal: '做个东西', stage: 'ready',
    requirements: [leaf('PLT-1', 'M1'), leaf('PLT-2', 'M1', ['PLT-1']), leaf('BIL-1', 'M2', ['PLT-2']), leaf('BIL-2', 'M2')],
    roster: [
      { id: 'M1', role: 'implementer', title: '平台负责人', level: '资深' },
      { id: 'M2', role: 'implementer', title: '计费负责人' },
    ],
    reviews: [], meetings: [],
    claims: [
      { memberId: 'M1', requirementIds: ['PLT-1', 'PLT-2'], ownedScope: ['src/plt/'] },
      { memberId: 'M2', requirementIds: ['BIL-1', 'BIL-2'], ownedScope: ['src/bil/', 'test/bil.test.js'] },
    ],
    createdAt: 1, updatedAt: 1,
  };
}

beforeEach(() => { setTeamPlanPersistence(null); clearTeamExec(SID); });

describe('执行态: 批次展开', () => {
  it('按 (批次 × 叶子 × 领取人) 展开, 第 1 批 pending 其余 blocked', () => {
    const st = startTeamExec(makePlan());
    expect(st.totalWaves).toBe(3);
    expect(st.tasks.filter((t) => t.wave === 1).map((t) => t.id).sort()).toEqual(['BIL-2', 'PLT-1']);
    expect(st.tasks.filter((t) => t.state === 'pending').length).toBe(2);
    expect(st.tasks.filter((t) => t.state === 'blocked').length).toBe(2);
    /* 领取人跟着规划走 */
    expect(st.tasks.find((t) => t.id === 'BIL-1')!.memberId).toBe('M2');
  });

  it('已经在跑的会话重复 start 不重建 (免得重复派兵)', () => {
    const a = startTeamExec(makePlan());
    updateTask(SID, 'PLT-1', { state: 'running' });
    const b = startTeamExec(makePlan());
    expect(b).toBe(a);
    expect(b.tasks.find((t) => t.id === 'PLT-1')!.state).toBe('running');
  });

  it('前一批没收口, 下一批一个都不许起 (跨批串行)', () => {
    startTeamExec(makePlan());
    updateTask(SID, 'PLT-1', { state: 'done' });
    /* BIL-2 还在跑 → 不放行 */
    expect(advanceWave(SID)).toBe(1);
    expect(runnableTasks(SID).map((t) => t.id)).toEqual(['BIL-2']);
    updateTask(SID, 'BIL-2', { state: 'done' });
    expect(advanceWave(SID)).toBe(2);
    expect(runnableTasks(SID).map((t) => t.id)).toEqual(['PLT-2']);
  });

  it('全跑完 → done; 有失败 → failed', () => {
    startTeamExec(makePlan());
    for (const id of ['PLT-1', 'BIL-2']) updateTask(SID, id, { state: 'done' });
    advanceWave(SID);
    updateTask(SID, 'PLT-2', { state: 'failed', note: '测试红了' });
    advanceWave(SID);
    updateTask(SID, 'BIL-1', { state: 'done' });
    expect(advanceWave(SID)).toBe(0);
    expect(getTeamExec(SID)!.status).toBe('failed');
    expect(execProgress(getTeamExec(SID)!)).toEqual({ done: 3, failed: 1, running: 0, total: 4, pct: 100 });
  });
});

describe('领地闸: 隔离靠它, 配合靠它给的出路', () => {
  const plan = makePlan();
  it('自己领地内放行 (目录前缀 + 具体文件都认)', () => {
    expect(checkTerritory(plan, 'M1', 'src/plt/migrate.js').allowed).toBe(true);
    expect(checkTerritory(plan, 'M2', './test/bil.test.js').allowed).toBe(true);
    expect(checkTerritory(plan, 'M2', 'src/bil/engine/rate.js').allowed).toBe(true);
  });

  it('越界被拒, 并报出这块地是谁的 (agent 据此去要契约)', () => {
    const v = checkTerritory(plan, 'M2', 'src/plt/migrate.js');
    expect(v.allowed).toBe(false);
    expect((v as any).owner).toBe('M1');
    expect((v as any).scopes).toEqual(['src/bil/', 'test/bil.test.js']);
  });

  it('没人认领的路径也拒 —— 但报 owner 为空 (别自己扩张)', () => {
    const v = checkTerritory(plan, 'M1', 'src/unknown/x.js');
    expect(v.allowed).toBe(false);
    expect((v as any).owner).toBeUndefined();
  });

  it('前缀不许误伤兄弟目录 (src/bil 不能匹配 src/billing-old)', () => {
    const p2 = { ...plan, claims: [{ memberId: 'M2', requirementIds: [], ownedScope: ['src/bil'] }] };
    expect(checkTerritory(p2 as any, 'M2', 'src/bil/x.js').allowed).toBe(true);
    expect(checkTerritory(p2 as any, 'M2', 'src/billing-old/x.js').allowed).toBe(false);
  });
});

describe('调度器: 派兵 / 排队 / 契约通知', () => {
  const mkDeps = (over: Partial<Parameters<typeof runTeamExecution>[0]> = {}) => {
    const dispatched: string[] = [];
    const events: any[] = [];
    let active = 0;
    return {
      dispatched, events,
      deps: {
        sessionId: SID,
        plan: makePlan(),
        agentTool: {
          name: 'agent',
          async function(args: any) {
            dispatched.push(args.name);
            active++;
            await new Promise((r) => setTimeout(r, 5));
            active--;
            return `${args.name} 干完了`;
          },
        } as any,
        activeAgentCount: () => active,
        maxConcurrent: 4,
        emit: (e: any) => events.push(e),
        taskTimeoutMs: 5000,
        ...over,
      },
    };
  };

  it('全流程跑通: 3 批依序, agentId = 成员#活, 状态收 done', async () => {
    const { deps, dispatched, events } = mkDeps();
    startTeamExec(deps.plan);
    const st = await runTeamExecution(deps as any);
    expect(st!.status).toBe('done');
    /* 第 1 批两条并行 (顺序不保证), 之后严格依序 */
    expect(dispatched.slice(0, 2).sort()).toEqual(['M1#PLT-1', 'M2#BIL-2']);
    expect(dispatched.slice(2)).toEqual(['M1#PLT-2', 'M2#BIL-1']);
    expect(st!.tasks.every((t) => t.state === 'done')).toBe(true);
    expect(events.some((e) => e.reason === 'wave_advanced')).toBe(true);
    expect(events.at(-1).reason).toBe('finished');
  });

  it('并发满了 → 排队等位, 不判失败 (老实现死在这)', async () => {
    /* maxConcurrent=1: 第 1 批两条只能一条一条来, 两条都必须成功 */
    const { deps, dispatched } = mkDeps({ maxConcurrent: 1 });
    startTeamExec(deps.plan);
    const st = await runTeamExecution(deps as any);
    expect(st!.status).toBe('done');
    expect(dispatched.length).toBe(4);
    expect(st!.tasks.filter((t) => t.state === 'failed')).toEqual([]);
  });

  it('前置交付 → 给下游成员发 contract_ready (跨人才发, 自己的活不发)', async () => {
    const { deps } = mkDeps();
    startTeamExec(deps.plan);
    const st = await runTeamExecution(deps as any);
    const contracts = st!.messages.filter((m) => m.kind === 'contract_ready');
    /* PLT-2 (M1) 完成 → 通知 M2 (他的 BIL-1 等着); PLT-1→PLT-2 同一个人, 不发 */
    expect(contracts.map((m) => ({ from: m.from, to: m.to, taskId: m.taskId })))
      .toEqual([{ from: 'M1', to: 'M2', taskId: 'PLT-2' }]);
  });

  it('一条失败 → 记 blocker 消息, 同批其它活照跑, 后续批次照常放行', async () => {
    const { deps, dispatched } = mkDeps({
      agentTool: {
        name: 'agent',
        async function(args: any) {
          dispatched.push(args.name);
          if (args.name === 'M1#PLT-1') throw new Error('测试红了');
          return 'ok';
        },
      } as any,
    });
    startTeamExec(deps.plan);
    const st = await runTeamExecution(deps as any);
    expect(st!.status).toBe('failed');
    expect(st!.tasks.find((t) => t.id === 'PLT-1')!.note).toContain('测试红了');
    expect(st!.messages.some((m) => m.kind === 'blocker' && m.taskId === 'PLT-1')).toBe(true);
    /* 失败不阻塞后面的批次 —— 后果由主脑复核时判断 */
    expect(dispatched).toContain('M2#BIL-1');
  });

  it('超时按失败收 (不挂死整团)', async () => {
    const { deps } = mkDeps({
      taskTimeoutMs: 20,
      agentTool: { name: 'agent', function: () => new Promise((r) => setTimeout(() => r('late'), 400)) } as any,
    });
    startTeamExec(deps.plan);
    const st = await runTeamExecution(deps as any);
    expect(st!.tasks.every((t) => t.state === 'failed')).toBe(true);
    expect(st!.tasks[0].note).toContain('超时');
  });

  it('派兵时登记 agentId → 会话, 领地闸靠它反查方案', async () => {
    const { deps } = mkDeps();
    startTeamExec(deps.plan);
    await runTeamExecution(deps as any);
    const { lookupExecAgent } = await import('../teamExecStore.js');
    expect(lookupExecAgent('M1#PLT-1')).toEqual({ sessionId: SID, memberId: 'M1' });
  });
});

/* Invalid agent types and error-text responses must not produce false success. */
describe('假绿防线: 工具层返回错误文本也必须判失败', () => {
  const mk = (fn: (args: any) => any) => ({
    sessionId: SID,
    plan: makePlan(),
    agentTool: { name: 'agent', function: fn } as any,
    activeAgentCount: () => 0,
    maxConcurrent: 4,
    emit: () => {},
    taskTimeoutMs: 3000,
  });

  it('返回 [ERROR] 文本 → 判失败, 不是 done', async () => {
    startTeamExec(makePlan());
    const st = await runTeamExecution(mk(() => '[ERROR] Unknown agent type "implement". Available: code, shell') as any);
    expect(st!.status).toBe('failed');
    expect(st!.tasks.every((t) => t.state === 'failed')).toBe(true);
    expect(st!.tasks[0].note).toContain('Unknown agent type');
  });

  it('空返回 → 判失败 (没有产出就是没干活)', async () => {
    startTeamExec(makePlan());
    const st = await runTeamExecution(mk(() => '   ') as any);
    expect(st!.tasks.every((t) => t.state === 'failed')).toBe(true);
    expect(st!.tasks[0].note).toContain('空返回');
  });

  it('派兵用的 agent type 必须是注册表里真有的', async () => {
    const seen: string[] = [];
    startTeamExec(makePlan());
    await runTeamExecution(mk((args: any) => { seen.push(args.type); return 'ok 干完了'; }) as any);
    /* code/shell/plan/research/verify 是 agentTypes.ts 里的全集 */
    expect([...new Set(seen)]).toEqual(['code']);
  });
});

/* Retry, skip, and reassignment remain available while execution is active. */
describe('执行期改方案: 重派 / 跳过 / 改派', () => {
  beforeEach(() => { startTeamExec(makePlan()); });

  it('失败的活重派 → 回到待派, 清掉上一轮的产出和 agentId', async () => {
    const { retryTask } = await import('../teamExecStore.js');
    updateTask(SID, 'PLT-1', { state: 'failed', note: '测试红了', result: '半成品', agentId: 'M1#PLT-1', finishedAt: 1 });
    const st = retryTask(SID, 'PLT-1')!;
    const t = st.tasks.find((x) => x.id === 'PLT-1')!;
    expect(t.state).toBe('pending');
    expect(t.note).toBeUndefined();
    expect(t.result).toBeUndefined();
    expect(t.agentId).toBeUndefined();
  });

  it('已收工的团队重派某条 → 状态退回 running, 批次游标退回那一批', async () => {
    const { retryTask } = await import('../teamExecStore.js');
    for (const id of ['PLT-1', 'BIL-2']) updateTask(SID, id, { state: 'done' });
    advanceWave(SID);
    updateTask(SID, 'PLT-2', { state: 'done' }); advanceWave(SID);
    updateTask(SID, 'BIL-1', { state: 'done' }); advanceWave(SID);
    expect(getTeamExec(SID)!.status).toBe('done');
    const st = retryTask(SID, 'PLT-1')!;   // 第 1 批的活
    expect(st.status).toBe('running');
    expect(st.currentWave).toBe(1);
    expect(runnableTasks(SID).map((t) => t.id)).toEqual(['PLT-1']);
  });

  it('在跑的活不许重派/改派 (会起两个同 id 的 agent)', async () => {
    const { retryTask, reassignTask } = await import('../teamExecStore.js');
    updateTask(SID, 'PLT-1', { state: 'running', agentId: 'M1#PLT-1' });
    expect(retryTask(SID, 'PLT-1')).toBeNull();
    expect(reassignTask(SID, 'PLT-1', 'M2')).toBeNull();
  });

  it('跳过要留理由, 且不阻塞批次收口', async () => {
    const { skipTask } = await import('../teamExecStore.js');
    updateTask(SID, 'PLT-1', { state: 'done' });
    const st = skipTask(SID, 'BIL-2', '范围砍了, 这条不做')!;
    expect(st.tasks.find((t) => t.id === 'BIL-2')!.state).toBe('skipped');
    expect(st.tasks.find((t) => t.id === 'BIL-2')!.note).toContain('范围砍了');
    /* skipped 算收口 → 下一批放行 */
    expect(advanceWave(SID)).toBe(2);
  });

  it('改派换人 → 换 memberId 且重新开始 (原产出是上一个人的, 不算新主人的)', async () => {
    const { reassignTask } = await import('../teamExecStore.js');
    updateTask(SID, 'PLT-1', { state: 'failed', note: '他卡住了', result: '半成品', agentId: 'M1#PLT-1' });
    const st = reassignTask(SID, 'PLT-1', 'M2')!;
    const t = st.tasks.find((x) => x.id === 'PLT-1')!;
    expect(t.memberId).toBe('M2');
    expect(t.state).toBe('pending');
    expect(t.result).toBeUndefined();
    expect(t.agentId).toBeUndefined();
  });

  it('重派后调度器真的会再派一次', async () => {
    const dispatched: string[] = [];
    const deps = {
      sessionId: SID, plan: makePlan(),
      agentTool: { name: 'agent', function: (a: any) => { dispatched.push(a.name); return 'ok 干完了'; } } as any,
      activeAgentCount: () => 0, maxConcurrent: 4, emit: () => {}, taskTimeoutMs: 3000,
    };
    await runTeamExecution(deps as any);
    expect(dispatched.length).toBe(4);
    const { retryTask } = await import('../teamExecStore.js');
    retryTask(SID, 'PLT-1');
    await runTeamExecution(deps as any);
    /* 重派那条被再派了一次 (后面的批次已经 done, 不会重跑) */
    expect(dispatched.filter((n) => n === 'M1#PLT-1').length).toBe(2);
    expect(getTeamExec(SID)!.status).toBe('done');
  });
});

/* 用户叮嘱: 「一定要注意会话隔离, 一定要注意不要出现串会话的情况。
 * 不在运行团队的过程中, 可能要干其他的活, 去其他的项目」——
 * 审计发现的数据损坏级风险: agent 工具默认吃 runtime.config.workDir, 而 setWorkspace 会改它。
 * 团队跑十几分钟, 用户切去别的项目, 下一批派兵就把这个项目的代码写进别人家。 */
describe('会话隔离: 工作目录在开工那一刻钉死', () => {
  it('派兵时把开工目录传给每个子 agent (用户中途切项目也不漂)', async () => {
    const seen: Array<string | undefined> = [];
    startTeamExec(makePlan(), '/proj/A');
    await runTeamExecution({
      sessionId: SID, plan: makePlan(),
      agentTool: { name: 'agent', function: (a: any) => { seen.push(a.workDir); return 'ok 干完了'; } } as any,
      activeAgentCount: () => 0, maxConcurrent: 4, emit: () => {}, taskTimeoutMs: 3000,
      workDir: '/proj/A',
    } as any);
    expect(seen.length).toBe(4);
    expect([...new Set(seen)]).toEqual(['/proj/A']);
  });

  it('执行态记住开工目录 (落盘后重建也还在)', () => {
    const st = startTeamExec(makePlan(), '/proj/A');
    expect(st.workDir).toBe('/proj/A');
  });

  it('没给 workDir 就不传 (单机/测试场景保持老行为)', async () => {
    const seen: Array<any> = [];
    startTeamExec(makePlan());
    await runTeamExecution({
      sessionId: SID, plan: makePlan(),
      agentTool: { name: 'agent', function: (a: any) => { seen.push('workDir' in a); return 'ok 干完了'; } } as any,
      activeAgentCount: () => 0, maxConcurrent: 4, emit: () => {}, taskTimeoutMs: 3000,
    } as any);
    expect([...new Set(seen)]).toEqual([false]);
  });
});
