import { describe, expect, it } from 'vitest';
import { buildSnapshot, emptyTelemetry, renderSnapshotForAgent } from '../scheduler/telemetry.js';
import type { NodeTelemetry } from '../scheduler/telemetry.js';

/**
 * 埋点正确性 —— 断言覆盖进度、静默和越界判定。
 */

const T0 = 1_000_000;
const mk = (id: string, o: Partial<NodeTelemetry> = {}): NodeTelemetry =>
  ({ ...emptyTelemetry(id), lastActivityAt: T0, ...o });

describe('掉队者检测 — 墙钟由最慢节点决定', () => {
  /* 集群完成时间由最慢节点决定，因此运行中的节点需要与已完成节点的基线比较。 */
  it('基线用已完成节点的中位耗时, 不用在跑的', () => {
    const tel = [
      mk('done1', { status: 'done', startedAt: T0, finishedAt: T0 + 100_000 }),
      mk('done2', { status: 'done', startedAt: T0, finishedAt: T0 + 100_000 }),
      mk('slow', { status: 'running', startedAt: T0, lastActivityAt: T0 + 250_000 }),
    ];
    const s = buildSnapshot(tel, { used: 1, max: 4 }, T0, { now: T0 + 250_000 });
    expect(s.stragglers.map((g) => g.nodeId)).toEqual(['slow']);
    expect(s.stragglers[0].ratio).toBeCloseTo(2.5, 1);
  });

  it('没超阈值不报', () => {
    const tel = [
      mk('done1', { status: 'done', startedAt: T0, finishedAt: T0 + 100_000 }),
      mk('ok', { status: 'running', startedAt: T0, lastActivityAt: T0 + 150_000 }),
    ];
    const s = buildSnapshot(tel, { used: 1, max: 4 }, T0, { now: T0 + 150_000 });
    expect(s.stragglers).toEqual([]);
  });

  it('还没有节点完成时, 用在跑节点的中位数兜底 (否则一个都报不出来)', () => {
    const tel = [
      mk('a', { status: 'running', startedAt: T0, lastActivityAt: T0 + 10_000 }),
      mk('b', { status: 'running', startedAt: T0, lastActivityAt: T0 + 10_000 }),
      mk('c', { status: 'running', startedAt: T0 - 500_000, lastActivityAt: T0 + 10_000 }),
    ];
    const s = buildSnapshot(tel, { used: 3, max: 4 }, T0 - 500_000, { now: T0 + 10_000 });
    expect(s.stragglers.map((g) => g.nodeId)).toContain('c');
  });
});

describe('静默检测 — 判死按进展不按时长', () => {
  /* 与 core 侧 长任务预算同口径: 跑了很久 ≠ 卡住,
   * 零活动才是卡住的唯一可靠信号。 */
  it('长时间无活动才报, 跑得久但一直有活动不报', () => {
    const tel = [
      mk('busy', { status: 'running', startedAt: T0, lastActivityAt: T0 + 590_000 }),
      mk('stuck', { status: 'running', startedAt: T0, lastActivityAt: T0 }),
    ];
    const s = buildSnapshot(tel, { used: 2, max: 4 }, T0, { now: T0 + 600_000, silenceMs: 300_000 });
    expect(s.silent.map((g) => g.nodeId)).toEqual(['stuck']);
  });

  it('已完成节点不算静默', () => {
    const tel = [mk('done', { status: 'done', startedAt: T0, finishedAt: T0 + 1000, lastActivityAt: T0 })];
    const s = buildSnapshot(tel, { used: 0, max: 4 }, T0, { now: T0 + 999_999 });
    expect(s.silent).toEqual([]);
  });
});

describe('越界检测 — 领地划得对不对', () => {
  /* 节点只能修改声明的领地，越界路径必须被记录。 */
  it('碰了别人的路径就报', () => {
    const tel = [mk('auth', {
      status: 'running', startedAt: T0,
      changedFiles: new Map([['src/auth/a.ts', 1], ['src/org/b.ts', 2]]),
    })];
    const s = buildSnapshot(tel, { used: 1, max: 4 }, T0, {
      now: T0 + 1000,
      ownedPaths: new Map([['auth', ['src/auth']]]),
    });
    expect(s.trespass).toEqual([{ nodeId: 'auth', path: 'src/org/b.ts' }]);
  });

  it('自己领地内的子路径不算越界', () => {
    const tel = [mk('auth', {
      status: 'running', startedAt: T0,
      changedFiles: new Map([['src/auth/deep/nested/x.ts', 1], ['./src/auth/y.ts', 1]]),
    })];
    const s = buildSnapshot(tel, { used: 1, max: 4 }, T0, {
      now: T0 + 1000,
      ownedPaths: new Map([['auth', ['src/auth']]]),
    });
    expect(s.trespass).toEqual([]);
  });

  it('前缀相同但不是子路径的不算自己的 (src/auth 不覆盖 src/authz)', () => {
    const tel = [mk('auth', {
      status: 'running', startedAt: T0,
      changedFiles: new Map([['src/authz/x.ts', 1]]),
    })];
    const s = buildSnapshot(tel, { used: 1, max: 4 }, T0, {
      now: T0 + 1000,
      ownedPaths: new Map([['auth', ['src/auth']]]),
    });
    expect(s.trespass.map((t) => t.path)).toEqual(['src/authz/x.ts']);
  });

  it('没声明领地的节点不判越界', () => {
    const tel = [mk('free', { status: 'running', startedAt: T0, changedFiles: new Map([['anything.ts', 1]]) })];
    const s = buildSnapshot(tel, { used: 1, max: 4 }, T0, { now: T0 + 1000, ownedPaths: new Map() });
    expect(s.trespass).toEqual([]);
  });
});

describe('给协调 Agent 的投影 — 必须紧凑', () => {
  it('渲染出关键信息且不含原始事件流', () => {
    const tel = [
      mk('a', { status: 'done', startedAt: T0, finishedAt: T0 + 60_000, turns: 12, lastTool: 'write_file' }),
      mk('b', { status: 'running', startedAt: T0, lastActivityAt: T0, turns: 40, lastTool: 'shell' }),
    ];
    const s = buildSnapshot(tel, { used: 1, max: 3 }, T0, { now: T0 + 400_000, silenceMs: 300_000 });
    const text = renderSnapshotForAgent(s);
    expect(text).toContain('并发 1/3');
    expect(text).toContain('write_file');
    expect(text).toMatch(/掉队|静默/);
    /* 紧凑: 别把原始事件流塞进协调者上下文 */
    expect(text.length).toBeLessThan(2000);
  });
});
