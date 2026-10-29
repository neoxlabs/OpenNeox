import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ingestServiceSnapshot,
  addOptimisticTask,
  getBackgroundTasks,
  worthSurfacing,
  isPersistentService,
  isSnapshotFresh,
  barFadeRemainMs,
  _resetBackgroundTasksStoreForTest,
  type BackgroundTask,
} from '../backgroundTasksStore';

const wire = (over: Record<string, any> = {}) => ({
  pid: 100,
  command: 'node -e "import(\'./src/server.js\')"',
  friendly_name: 'Node: -e',
  startTime: 1_000_000,
  status: 'running' as const,
  ...over,
});

describe('backgroundTasksStore — 快照投影', () => {
  beforeEach(() => { _resetBackgroundTasksStoreForTest(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('进程从快照里消失 = 它不存在了 (幽灵进程根治)', () => {
    ingestServiceSnapshot({ generatedAt: 1, processes: [wire({ pid: 100 }), wire({ pid: 200 })] });
    expect(getBackgroundTasks().map(t => t.pid).sort()).toEqual([100, 200]);

    /* 200 退出并被 server 的保留窗口清掉 —— 没有任何"退出事件", 它就是不在下一份快照里 */
    ingestServiceSnapshot({ generatedAt: 2, processes: [wire({ pid: 100 })] });
    expect(getBackgroundTasks().map(t => t.pid)).toEqual([100]);
  });

  it('乱序到达的旧快照直接丢弃, 不会把状态倒回去', () => {
    ingestServiceSnapshot({ generatedAt: 100, processes: [wire({ pid: 1 })] });
    ingestServiceSnapshot({ generatedAt: 50, processes: [wire({ pid: 1 }), wire({ pid: 2 })] });
    expect(getBackgroundTasks().map(t => t.pid)).toEqual([1]);
  });

  it('乐观占位让 UI 立刻有反馈, 下一份快照覆盖它', () => {
    addOptimisticTask(300, 'npm run dev');
    expect(getBackgroundTasks().map(t => t.pid)).toEqual([300]);
    /* 快照收录了 300 → 占位被真事实替换 (带上了端口) */
    ingestServiceSnapshot({ generatedAt: 1, processes: [wire({ pid: 300, port: 5173 })] });
    const t = getBackgroundTasks().find(x => x.pid === 300)!;
    expect(t.port).toBe(5173);
    /* 快照里彻底没有它了 → 占位也不该再赖着 */
    ingestServiceSnapshot({ generatedAt: 2, processes: [] });
    expect(getBackgroundTasks()).toEqual([]);
  });

  it('永远等不到快照收录的占位必须自己消失 —— 否则我就自己造了个新幽灵', () => {
    /* 会出现这种情况的真实场景: 该进程属于别的工程 (快照按 workspaceRoot 过滤)、
     * 是 free-shell、或者起来不到一个 tick 就退出并被保留窗口滤掉。 */
    const t0 = 1_000_000;
    vi.setSystemTime(t0);
    addOptimisticTask(777, 'npm run something');
    expect(getBackgroundTasks().map(t => t.pid)).toEqual([777]);
    /* 快照里一直没有它 —— 两个 tick 内还容忍 */
    vi.setSystemTime(t0 + 3_000);
    ingestServiceSnapshot({ generatedAt: t0 + 3_000, processes: [] });
    expect(getBackgroundTasks().map(t => t.pid)).toEqual([777]);
    /* 超过上限 → 丢弃, 不许变成常驻"运行中" */
    vi.setSystemTime(t0 + 9_000);
    ingestServiceSnapshot({ generatedAt: t0 + 9_000, processes: [] });
    expect(getBackgroundTasks()).toEqual([]);
  });

  it('status 由 endTime/exitCode 派生, 不是独立维护的枚举', () => {
    ingestServiceSnapshot({ generatedAt: 1, processes: [
      wire({ pid: 1, status: undefined, endTime: undefined }),
      wire({ pid: 2, status: undefined, endTime: 2_000_000, exitCode: 0 }),
      wire({ pid: 3, status: undefined, endTime: 2_000_000, exitCode: 1 }),
      wire({ pid: 4, status: undefined, endTime: 2_000_000 }),
    ] });
    const byPid = new Map(getBackgroundTasks().map(t => [t.pid, t.status]));
    expect(byPid.get(1)).toBe('running');
    expect(byPid.get(2)).toBe('completed');
    expect(byPid.get(3)).toBe('failed');
    expect(byPid.get(4)).toBe('killed');  /* 有 endTime 无 exitCode = 被杀 */
  });

  it('paused 是观测出来的 (ps STAT), 不是 UI 记着"我点过暂停"', () => {
    ingestServiceSnapshot({ generatedAt: 1, processes: [wire({ pid: 1, paused: true })] });
    expect(getBackgroundTasks()[0].status).toBe('paused');
    /* 用户点了恢复 → 下一份快照 paused=false, 不需要 UI 自己翻状态 */
    ingestServiceSnapshot({ generatedAt: 2, processes: [wire({ pid: 1, paused: false })] });
    expect(getBackgroundTasks()[0].status).toBe('running');
  });

  it('快照超过 10s 没更新 = 服务端失联, 不许假装一切正常', () => {
    ingestServiceSnapshot({ generatedAt: 1_000_000, processes: [] });
    expect(isSnapshotFresh(1_005_000)).toBe(true);
    expect(isSnapshotFresh(1_011_000)).toBe(false);
  });

  it('getSnapshot 返回 stable ref — 否则 useSyncExternalStore 无限重渲', () => {
    ingestServiceSnapshot({ generatedAt: 1, processes: [wire()] });
    const a = getBackgroundTasks();
    const b = getBackgroundTasks();
    expect(a).toBe(b);
  });
});

describe('worthSurfacing — 自动弹面板的注意力门槛 (启发式合适)', () => {
  const task = (over: Partial<BackgroundTask> = {}): BackgroundTask => ({
    taskId: 1, pid: 1, command: 'x', startedAtMs: 1_000_000, status: 'running', ...over,
  });
  const NOW = 1_000_000;

  it('端口是最硬证据', () => {
    expect(worthSurfacing(task({ port: 8080 }), NOW + 1_000)).toBe(true);
  });

  it('绑了 RunConfig 立刻算服务', () => {
    expect(worthSurfacing(task({ configId: 'c' }), NOW + 1_000)).toBe(true);
  });

  it('活过 15s 就算服务 —— 这是老 classification 正则永远打不中的那类命令', () => {
    const t = task({ command: `node -e "import('./src/server.js')"` });
    expect(worthSurfacing(t, NOW + 14_000)).toBe(false);
    expect(worthSurfacing(t, NOW + 16_000)).toBe(true);
  });

  it('free-shell 是用户的交互终端, 永远不是服务', () => {
    expect(worthSurfacing(task({ kind: 'free-shell', port: 8080 }), NOW + 60_000)).toBe(false);
  });
});

describe('barFadeRemainMs — 收起倒计时是算出来的, 不是 store 里的定时器', () => {
  const t = (over: Partial<BackgroundTask> = {}): BackgroundTask => ({
    taskId: 1, pid: 1, command: 'x', startedAtMs: 0, status: 'completed', ...over,
  });

  it('还在跑的永不收起', () => {
    expect(barFadeRemainMs(t({ status: 'running', endedAtMs: undefined }), 999)).toBe(Infinity);
  });

  it('成功的 5s 后收起, 失败的留久一点 (12s) 方便定位', () => {
    expect(barFadeRemainMs(t({ status: 'completed', endedAtMs: 1_000 }), 1_000 + 4_000)).toBe(1_000);
    expect(barFadeRemainMs(t({ status: 'completed', endedAtMs: 1_000 }), 1_000 + 6_000)).toBe(0);
    expect(barFadeRemainMs(t({ status: 'failed', endedAtMs: 1_000 }), 1_000 + 6_000)).toBe(6_000);
  });
});

describe('isPersistentService — 常驻身份只认人做过的决定', () => {
  const BASE = 1_000_000;
  const t = (over: Record<string, unknown>) =>
    ({ pid: 1, status: 'running', startedAtMs: BASE, ...over }) as any;

  it('绑了 RunConfig → 是常驻服务', () => {
    expect(isPersistentService(t({ configId: 'dev' }))).toBe(true);
  });

  it('用户显式转正 → 是常驻服务', () => {
    expect(isPersistentService(t({ persistent: true }))).toBe(true);
  });

  it('只是占了端口 → **不是** (跑三分钟的构建照样占端口)', () => {
    expect(isPersistentService(t({ port: 8080 }))).toBe(false);
  });

  it('只是活得久 → **不是** (这正是构建被焊成服务的老路)', () => {
    expect(isPersistentService(t({ startedAtMs: BASE - 60 * 60_000 }))).toBe(false);
  });

  it('派给外部 agent 的一次性委派 → 不是 (跑十几分钟很正常)', () => {
    expect(isPersistentService(t({ kind: 'agent-task', persistent: true }))).toBe(false);
  });
});
