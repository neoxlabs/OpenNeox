
import { beforeEach, describe, expect, test } from 'vitest';
import {
  applyTeamEvent,
  ingestTeamRunEvent,
  getTeamRunSnapshot,
  _resetTeamRunStoreForTest,
  type TeamRunStartEvent,
  type TeamLaneUpdateEvent,
  type TeamBlackboardPostEvent,
  type TeamRunCompleteEvent,
} from '../teamRunStore';

const SID = 'session-a';
const TEAM = 'team-1';

function startEvent(overrides?: Partial<TeamRunStartEvent>): TeamRunStartEvent {
  return {
    type: 'team_run_start',
    teamId: TEAM,
    goal: '重构结算模块',
    lanes: [
      {
        laneId: 'lane-plan', role: 'planner', agentName: 'Planner', model: 'claude-sonnet',
        scope: ['docs/**'],
        milestones: [{ id: 'm1', title: '接口定型' }, { id: 'm2', title: '规划完成' }],
      },
      {
        laneId: 'lane-impl', role: 'implementer', agentName: 'Implementer', model: 'grok-code',
        scope: ['src/billing/**'],
        milestones: [{ id: 'm3', title: '实现完成' }],
      },
    ],
    timestamp: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  _resetTeamRunStoreForTest();
});

describe('team_run_start', () => {
  test('建 Team: goal / 泳道初始 running / 里程碑未达 / 进度归零', () => {
    expect(applyTeamEvent(SID, startEvent())).toBe(true);
    const t = getTeamRunSnapshot(SID);
    expect(t).not.toBeNull();
    expect(t!.teamId).toBe(TEAM);
    expect(t!.goal).toBe('重构结算模块');
    expect(t!.status).toBe('running');
    expect(t!.startedAt).toBe(1000);
    expect(t!.lanes).toHaveLength(2);
    expect(t!.lanes[0]).toMatchObject({
      laneId: 'lane-plan', role: 'planner', agentName: 'Planner', model: 'claude-sonnet',
      status: 'running', toolCount: 0, changedFiles: 0,
    });
    expect(t!.lanes[0].milestones).toEqual([
      { id: 'm1', title: '接口定型', reached: false },
      { id: 'm2', title: '规划完成', reached: false },
    ]);
    expect(t!.blackboard).toEqual([]);
  });

  test('新一轮 start 直接替换旧 Team (一个 session 一个活跃 Team)', () => {
    applyTeamEvent(SID, startEvent());
    applyTeamEvent(SID, startEvent({ teamId: 'team-2', goal: '第二轮', lanes: [] }));
    const t = getTeamRunSnapshot(SID);
    expect(t!.teamId).toBe('team-2');
    expect(t!.goal).toBe('第二轮');
    expect(t!.lanes).toEqual([]);
  });

  test('per-session 隔离: 别的 session 不受影响', () => {
    applyTeamEvent(SID, startEvent());
    expect(getTeamRunSnapshot('session-b')).toBeNull();
  });

  test('缺 teamId / 缺 sessionId 拒绝', () => {
    expect(applyTeamEvent('', startEvent())).toBe(false);
    expect(applyTeamEvent(SID, { ...startEvent(), teamId: undefined as unknown as string })).toBe(false);
  });
});

describe('team_lane_update', () => {
  const update = (overrides?: Partial<TeamLaneUpdateEvent>): TeamLaneUpdateEvent => ({
    type: 'team_lane_update',
    teamId: TEAM,
    laneId: 'lane-impl',
    status: 'running',
    timestamp: 2000,
    ...overrides,
  });

  test('更新 status / currentAction / progress', () => {
    applyTeamEvent(SID, startEvent());
    applyTeamEvent(SID, update({
      status: 'blocked',
      currentAction: '等折扣口径',
      progress: { toolCount: 7, changedFiles: 3 },
    }));
    const lane = getTeamRunSnapshot(SID)!.lanes.find((l) => l.laneId === 'lane-impl')!;
    expect(lane.status).toBe('blocked');
    expect(lane.currentAction).toBe('等折扣口径');
    expect(lane.toolCount).toBe(7);
    expect(lane.changedFiles).toBe(3);
  });

  test('缺省字段不回退已有值 (currentAction / progress 保持)', () => {
    applyTeamEvent(SID, startEvent());
    applyTeamEvent(SID, update({ currentAction: '写引擎', progress: { toolCount: 5, changedFiles: 2 } }));
    applyTeamEvent(SID, update({ status: 'running' }));
    const lane = getTeamRunSnapshot(SID)!.lanes.find((l) => l.laneId === 'lane-impl')!;
    expect(lane.currentAction).toBe('写引擎');
    expect(lane.toolCount).toBe(5);
    expect(lane.changedFiles).toBe(2);
  });

  test('lane done → 该泳道全部里程碑点亮', () => {
    applyTeamEvent(SID, startEvent());
    applyTeamEvent(SID, update({ laneId: 'lane-plan', status: 'done' }));
    const lane = getTeamRunSnapshot(SID)!.lanes.find((l) => l.laneId === 'lane-plan')!;
    expect(lane.milestones.every((m) => m.reached)).toBe(true);
  });

  test('reachedMilestones (前向兼容字段) 点亮指定里程碑', () => {
    applyTeamEvent(SID, startEvent());
    applyTeamEvent(SID, update({ laneId: 'lane-plan', status: 'running', reachedMilestones: ['m1'] }));
    const lane = getTeamRunSnapshot(SID)!.lanes.find((l) => l.laneId === 'lane-plan')!;
    expect(lane.milestones.find((m) => m.id === 'm1')!.reached).toBe(true);
    expect(lane.milestones.find((m) => m.id === 'm2')!.reached).toBe(false);
  });

  test('未知 laneId 兜底建条 (SSE 漏帧场景)', () => {
    applyTeamEvent(SID, startEvent());
    applyTeamEvent(SID, update({ laneId: 'lane-ghost', status: 'running', currentAction: '干活中' }));
    const lane = getTeamRunSnapshot(SID)!.lanes.find((l) => l.laneId === 'lane-ghost');
    expect(lane).toBeDefined();
    expect(lane!.agentName).toBe('lane-ghost');
    expect(lane!.currentAction).toBe('干活中');
  });

  test('teamId 不匹配 (陈旧事件) 忽略; 没 start 先到的 update 忽略', () => {
    expect(applyTeamEvent(SID, update())).toBe(false);           // 没头
    applyTeamEvent(SID, startEvent());
    expect(applyTeamEvent(SID, update({ teamId: 'team-stale' }))).toBe(false);
    expect(getTeamRunSnapshot(SID)!.lanes.find((l) => l.laneId === 'lane-impl')!.status).toBe('running');
  });
});

describe('team_blackboard_post', () => {
  const post = (key: string, overrides?: Partial<TeamBlackboardPostEvent['entry']>): TeamBlackboardPostEvent => ({
    type: 'team_blackboard_post',
    teamId: TEAM,
    entry: { key, kind: 'note', summary: `摘要 ${key}`, author: 'Planner', ts: 3000, ...overrides },
  });

  test('追加条目 + 字段归一 (未知 kind 落 note)', () => {
    applyTeamEvent(SID, startEvent());
    applyTeamEvent(SID, post('k1', { kind: 'weird' as 'note' }));
    const bb = getTeamRunSnapshot(SID)!.blackboard;
    expect(bb).toHaveLength(1);
    expect(bb[0]).toMatchObject({ key: 'k1', kind: 'note', summary: '摘要 k1', author: 'Planner', ts: 3000 });
  });

  test('同 key upsert: 旧条目移除, 新条目在尾', () => {
    applyTeamEvent(SID, startEvent());
    applyTeamEvent(SID, post('k1'));
    applyTeamEvent(SID, post('k2'));
    applyTeamEvent(SID, post('k1', { summary: '更新后', ts: 4000 }));
    const bb = getTeamRunSnapshot(SID)!.blackboard;
    expect(bb.map((e) => e.key)).toEqual(['k2', 'k1']);
    expect(bb[1].summary).toBe('更新后');
  });

  test('key 命中里程碑 (milestone:<id> / 裸 id) → 点亮', () => {
    applyTeamEvent(SID, startEvent());
    applyTeamEvent(SID, post('milestone:m1', { kind: 'result' }));
    applyTeamEvent(SID, post('m3', { kind: 'result' }));
    const t = getTeamRunSnapshot(SID)!;
    const plan = t.lanes.find((l) => l.laneId === 'lane-plan')!;
    const impl = t.lanes.find((l) => l.laneId === 'lane-impl')!;
    expect(plan.milestones.find((m) => m.id === 'm1')!.reached).toBe(true);
    expect(plan.milestones.find((m) => m.id === 'm2')!.reached).toBe(false);
    expect(impl.milestones.find((m) => m.id === 'm3')!.reached).toBe(true);
  });

  test('缺 key 拒绝', () => {
    applyTeamEvent(SID, startEvent());
    expect(applyTeamEvent(SID, {
      type: 'team_blackboard_post',
      teamId: TEAM,
      entry: { kind: 'note', summary: 'x', author: 'a' } as TeamBlackboardPostEvent['entry'],
    })).toBe(false);
  });
});

describe('team_run_complete', () => {
  const complete = (overrides?: Partial<TeamRunCompleteEvent>): TeamRunCompleteEvent => ({
    type: 'team_run_complete',
    teamId: TEAM,
    status: 'success',
    report: '全部完成',
    laneSummaries: [
      { laneId: 'lane-plan', role: 'planner', status: 'done', changedFiles: 1 },
      { laneId: 'lane-impl', role: 'implementer', status: 'failed', branch: 'team/impl', changedFiles: 9 },
    ],
    timestamp: 9000,
    ...overrides,
  });

  test('终态: status / report / laneSummaries / completedAt', () => {
    applyTeamEvent(SID, startEvent());
    applyTeamEvent(SID, complete());
    const t = getTeamRunSnapshot(SID)!;
    expect(t.status).toBe('success');
    expect(t.report).toBe('全部完成');
    expect(t.completedAt).toBe(9000);
    expect(t.laneSummaries).toHaveLength(2);
    expect(t.laneSummaries![1]).toMatchObject({ branch: 'team/impl', changedFiles: 9 });
  });

  test('laneSummaries 回折泳道: status 映射 + changedFiles + done 点亮里程碑', () => {
    applyTeamEvent(SID, startEvent());
    applyTeamEvent(SID, complete());
    const t = getTeamRunSnapshot(SID)!;
    const plan = t.lanes.find((l) => l.laneId === 'lane-plan')!;
    const impl = t.lanes.find((l) => l.laneId === 'lane-impl')!;
    expect(plan.status).toBe('done');
    expect(plan.changedFiles).toBe(1);
    expect(plan.milestones.every((m) => m.reached)).toBe(true);
    expect(impl.status).toBe('failed');
    expect(impl.changedFiles).toBe(9);
  });

  test('无 summary 的 running 泳道: 整队 success 收敛 done, 非 success 保持', () => {
    applyTeamEvent(SID, startEvent());
    applyTeamEvent(SID, complete({ laneSummaries: [] }));
    expect(getTeamRunSnapshot(SID)!.lanes.every((l) => l.status === 'done')).toBe(true);

    _resetTeamRunStoreForTest();
    applyTeamEvent(SID, startEvent());
    applyTeamEvent(SID, complete({ status: 'aborted', laneSummaries: [] }));
    expect(getTeamRunSnapshot(SID)!.lanes.every((l) => l.status === 'running')).toBe(true);
    expect(getTeamRunSnapshot(SID)!.status).toBe('aborted');
  });

  test('teamId 不匹配忽略', () => {
    applyTeamEvent(SID, startEvent());
    expect(applyTeamEvent(SID, complete({ teamId: 'team-other' }))).toBe(false);
    expect(getTeamRunSnapshot(SID)!.status).toBe('running');
  });
});

describe('快照引用契约 (useSyncExternalStore)', () => {
  test('apply 后换新引用, 未变更泳道对象保持旧引用', () => {
    applyTeamEvent(SID, startEvent());
    const before = getTeamRunSnapshot(SID)!;
    applyTeamEvent(SID, {
      type: 'team_lane_update', teamId: TEAM, laneId: 'lane-impl', status: 'blocked',
    });
    const after = getTeamRunSnapshot(SID)!;
    expect(after).not.toBe(before);
    expect(after.lanes.find((l) => l.laneId === 'lane-plan'))
      .toBe(before.lanes.find((l) => l.laneId === 'lane-plan')); // 没动的泳道不换引用
    expect(after.lanes.find((l) => l.laneId === 'lane-impl'))
      .not.toBe(before.lanes.find((l) => l.laneId === 'lane-impl'));
  });

  test('无效事件不换引用', () => {
    applyTeamEvent(SID, startEvent());
    const before = getTeamRunSnapshot(SID)!;
    applyTeamEvent(SID, { type: 'team_lane_update', teamId: 'stale', laneId: 'lane-impl', status: 'done' });
    expect(getTeamRunSnapshot(SID)!).toBe(before);
  });
});

describe('ingestTeamRunEvent (stream 接入口)', () => {
  test('node 环境 (无 window) 走纯状态机, 不抛错', () => {
    expect(() => ingestTeamRunEvent(SID, startEvent())).not.toThrow();
    expect(getTeamRunSnapshot(SID)!.teamId).toBe(TEAM);
  });

  test('完整事件序列端到端 (mock 同款剧本收敛到正确终态)', () => {
    ingestTeamRunEvent(SID, startEvent());
    ingestTeamRunEvent(SID, { type: 'team_lane_update', teamId: TEAM, laneId: 'lane-plan', status: 'running', currentAction: '规划中', progress: { toolCount: 3, changedFiles: 0 } });
    ingestTeamRunEvent(SID, { type: 'team_blackboard_post', teamId: TEAM, entry: { key: 'milestone:m1', kind: 'result', summary: '接口定型', author: 'Planner', ts: 2000 } });
    ingestTeamRunEvent(SID, { type: 'team_lane_update', teamId: TEAM, laneId: 'lane-plan', status: 'done' });
    ingestTeamRunEvent(SID, { type: 'team_lane_update', teamId: TEAM, laneId: 'lane-impl', status: 'blocked', currentAction: '等口径' });
    ingestTeamRunEvent(SID, { type: 'team_blackboard_post', teamId: TEAM, entry: { key: 'blk-1', kind: 'blocker', summary: '负数折扣', author: 'Implementer', ts: 3000 } });
    ingestTeamRunEvent(SID, { type: 'team_lane_update', teamId: TEAM, laneId: 'lane-impl', status: 'done', progress: { toolCount: 20, changedFiles: 12 } });
    ingestTeamRunEvent(SID, {
      type: 'team_run_complete', teamId: TEAM, status: 'success', report: 'ok',
      laneSummaries: [
        { laneId: 'lane-plan', role: 'planner', status: 'done' },
        { laneId: 'lane-impl', role: 'implementer', status: 'done', changedFiles: 12 },
      ],
    });
    const t = getTeamRunSnapshot(SID)!;
    expect(t.status).toBe('success');
    expect(t.blackboard).toHaveLength(2);
    expect(t.lanes.every((l) => l.status === 'done')).toBe(true);
    expect(t.lanes.every((l) => l.milestones.every((m) => m.reached))).toBe(true);
  });
});
