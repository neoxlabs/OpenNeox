/**
 * teamRunValidator 单测 — 防拆碎硬规则各分支 (TEAM_MODE_DESIGN §3.2)
 */

import { describe, it, expect } from 'vitest';
import {
  validateTeamRun,
  estimateLaneMinutes,
  MIN_LANE_MINUTES,
  MAX_TEAM_LANES,
} from '../teamRunValidator.js';
import type { TeamLaneInput } from '../teamRunValidator.js';

function lane(overrides: Partial<TeamLaneInput> = {}): TeamLaneInput {
  return {
    role: 'implementer',
    goal: '实现模块 A 的全部功能',
    ownedScope: ['src/moduleA'],
    acceptance: '构建通过, 单测全绿',
    estimatedMinutes: 10,
    ...overrides,
  };
}

describe('validateTeamRun — 防拆碎硬规则', () => {
  it('合法输入通过并归一化 (缺省 model, 保留估时)', () => {
    const r = validateTeamRun({
      goal: '重构 X 系统',
      lanes: [
        lane({ ownedScope: ['src/moduleA'] }),
        lane({ role: 'reviewer', ownedScope: ['.'], estimatedMinutes: 8 }),
      ],
      milestones: [{ id: 'm1', title: '接口定型' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lanes).toHaveLength(2);
    expect(r.lanes[0].role).toBe('implementer');
    expect(r.lanes[0].model).toBeUndefined();
    expect(r.lanes[0].estimatedMinutes).toBe(10);
    expect(r.milestones).toEqual([{ id: 'm1', title: '接口定型' }]);
  });

  it('单 lane → TOO_FEW_LANES, advice 建议直接执行不开团', () => {
    const r = validateTeamRun({ goal: 'X', lanes: [lane()] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violations.some(v => v.code === 'TOO_FEW_LANES')).toBe(true);
    expect(r.advice).toContain('不要开团');
  });

  it('0 lane / 缺 lanes → TOO_FEW_LANES', () => {
    const r = validateTeamRun({ goal: 'X' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('TOO_FEW_LANES');
  });

  it(`超过 ${MAX_TEAM_LANES} lanes → TOO_MANY_LANES`, () => {
    const lanes = ['a', 'b', 'c', 'd', 'e'].map(s => lane({ ownedScope: [`src/${s}`] }));
    const r = validateTeamRun({ goal: 'X', lanes });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violations.some(v => v.code === 'TOO_MANY_LANES')).toBe(true);
  });

  it('非法 role → INVALID_ROLE', () => {
    const r = validateTeamRun({
      goal: 'X',
      lanes: [lane({ role: 'hacker' }), lane({ ownedScope: ['src/b'] })],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const v = r.violations.find(x => x.code === 'INVALID_ROLE');
    expect(v).toBeDefined();
    expect(v!.lanes).toEqual([0]);
  });

  it('lane 缺 goal/acceptance/ownedScope → LANE_INCOMPLETE (一次性全列)', () => {
    const r = validateTeamRun({
      goal: 'X',
      lanes: [{ role: 'implementer' }, lane({ ownedScope: ['src/b'] })],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const v = r.violations.find(x => x.code === 'LANE_INCOMPLETE');
    expect(v).toBeDefined();
    expect(v!.message).toContain('goal');
    expect(v!.message).toContain('acceptance');
    expect(v!.message).toContain('ownedScope');
  });

  it(`碎泳道 (estimatedMinutes < ${MIN_LANE_MINUTES}) → LANE_TOO_SMALL`, () => {
    const r = validateTeamRun({
      goal: 'X',
      lanes: [
        lane({ estimatedMinutes: 2 }),
        lane({ ownedScope: ['src/b'], estimatedMinutes: 20 }),
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const v = r.violations.find(x => x.code === 'LANE_TOO_SMALL');
    expect(v).toBeDefined();
    expect(v!.lanes).toEqual([0]);
  });

  it('estimatedMinutes 缺省时按 ownedScope 规模粗估 (不误杀正常泳道)', () => {
    expect(estimateLaneMinutes(['src/a'])).toBeGreaterThanOrEqual(MIN_LANE_MINUTES);
    const r = validateTeamRun({
      goal: 'X',
      lanes: [
        lane({ estimatedMinutes: undefined, ownedScope: ['src/a', 'src/a-utils'] }),
        lane({ estimatedMinutes: undefined, ownedScope: ['src/b'] }),
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lanes[0].estimatedMinutes).toBe(estimateLaneMinutes(['src/a', 'src/a-utils']));
  });

  it('写角色 ownedScope 重叠 (同路径) → SCOPE_OVERLAP', () => {
    const r = validateTeamRun({
      goal: 'X',
      lanes: [lane(), lane({ role: 'researcher' })], // 同 src/moduleA
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const v = r.violations.find(x => x.code === 'SCOPE_OVERLAP');
    expect(v).toBeDefined();
    expect(v!.lanes).toEqual([0, 1]);
  });

  it('写角色 ownedScope 目录前缀嵌套 → SCOPE_OVERLAP (含 ./ 与反斜杠归一化)', () => {
    const r = validateTeamRun({
      goal: 'X',
      lanes: [
        lane({ ownedScope: ['./src/moduleA/'] }),
        lane({ ownedScope: ['src\\moduleA\\sub'] }),
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violations.some(v => v.code === 'SCOPE_OVERLAP')).toBe(true);
  });

  it('reviewer 只读 — scope 覆盖全库也不参与互斥', () => {
    const r = validateTeamRun({
      goal: 'X',
      lanes: [
        lane({ ownedScope: ['src/moduleA'] }),
        lane({ role: 'reviewer', ownedScope: ['.'], estimatedMinutes: 6 }),
      ],
    });
    expect(r.ok).toBe(true);
  });

  it('整任务太小 (总量 < 10 分钟) → TASK_TOO_SMALL + 降级 advice', () => {
    const r = validateTeamRun({
      goal: 'X',
      lanes: [
        lane({ estimatedMinutes: 5 }),
        lane({ ownedScope: ['src/b'], estimatedMinutes: 4.5 }),
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violations.some(v => v.code === 'TASK_TOO_SMALL')).toBe(true);
    expect(r.advice).toContain('单 agent');
  });

  it('里程碑 >2 → TOO_MANY_MILESTONES', () => {
    const r = validateTeamRun({
      goal: 'X',
      lanes: [lane(), lane({ ownedScope: ['src/b'] })],
      milestones: [
        { id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violations.some(v => v.code === 'TOO_MANY_MILESTONES')).toBe(true);
  });

  it('goal 为空 → INVALID_ARGS', () => {
    const r = validateTeamRun({ goal: '  ', lanes: [lane(), lane({ ownedScope: ['src/b'] })] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violations.some(v => v.code === 'INVALID_ARGS')).toBe(true);
  });

  it('多个违规一次性全部返回 (不挤牙膏)', () => {
    const r = validateTeamRun({
      goal: '',
      lanes: [lane({ role: 'x', estimatedMinutes: 1 })],
      milestones: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const codes = r.violations.map(v => v.code);
    expect(codes).toContain('INVALID_ARGS');
    expect(codes).toContain('TOO_FEW_LANES');
    expect(codes).toContain('INVALID_ROLE');
    expect(codes).toContain('LANE_TOO_SMALL');
    expect(codes).toContain('TOO_MANY_MILESTONES');
  });
});
