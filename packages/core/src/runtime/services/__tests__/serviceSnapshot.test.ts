import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * serviceSnapshot —— 服务真源的行为约束。
 *
 * 这里守三件事:
 *   1. 快照只含事实, 不含结论 (isService 的判据不落进数据)
 *   2. 判活带 pid 复用防线 —— 光看 kill(pid,0) 会把一个被复用的 pid 当成老进程还在跑
 *   3. 探到端口后落 RunConfig 的**身份键是 (cwd, port)** —— 老实现按命令字符串比对,
 *      用户反复起同一个服务、命令差一个字就堆一条新配置
 */

const probeListeningPort = vi.fn(async (_pid: number): Promise<number | undefined> => undefined);
vi.mock('@neoxlabs/platform/platform/portProbe.js', () => ({
  probeListeningPort: (pid: number) => probeListeningPort(pid),
  isLikelyLongRunningCommand: () => false,
}));

const infoBatch = vi.fn((_pids: number[]) => new Map<number, { startTimeMs?: number; stopped: boolean }>());
const pidAlive = vi.fn((_pid: number) => true);
vi.mock('@neoxlabs/platform/platform/processTree.js', () => ({
  getProcessInfoBatch: (pids: number[]) => infoBatch(pids),
  getProcessInfoBatchAsync: async (pids: number[]) => infoBatch(pids),
  isPidAlive: (pid: number) => pidAlive(pid),
  getDescendantPids: () => [],
  getDescendantPidsAsync: async () => [],
  normalizeWorkspaceRoot: (p: string) => (p || '').replace(/\/+$/, ''),
}));

const storeList = vi.fn((): any[] => []);
const storeUpsert = vi.fn((input: any) => ({ ...input }));
const findByCommandCwd = vi.fn((): any => undefined);
vi.mock('../serviceConfigStoreCache.js', () => ({
  getServiceConfigStore: () => ({ list: storeList, upsert: storeUpsert, findByCommandCwd }),
}));

const procs: any[] = [];
const setPort = vi.fn();
const bindConfig = vi.fn();
const markVanished = vi.fn((pid: number) => {
  const p = procs.find(x => x.pid === pid);
  if (p) { p.status = 'killed'; p.endTime = new Date(2_000_000); }
});
const markCompleted = vi.fn((pid: number) => {
  const p = procs.find(x => x.pid === pid);
  if (p) { p.status = 'completed'; p.endTime = new Date(2_000_000); }
});
vi.mock('@neoxlabs/platform/platform/processManager.js', () => ({
  processManager: {
    getAll: () => procs,
    setPort: (...a: any[]) => setPort(...a),
    bindConfig: (...a: any[]) => bindConfig(...a),
    markCompleted: (...a: any[]) => markCompleted(a[0] as number),
    markVanished: (pid: number) => markVanished(pid),
    get: (pid: number) => procs.find(p => p.pid === pid),
  },
}));

import { buildSnapshot, isService, startServiceSnapshotTick, stopServiceSnapshotTick } from '../serviceSnapshot.js';

function makeProc(over: Record<string, any> = {}) {
  return {
    pid: 100,
    command: 'node -e "boot()"',
    cwd: '/ws',
    workspaceRoot: '/ws',
    origin: 'spawned',
    kind: 'background-task',
    background: true,
    status: 'running',
    startTime: new Date(1_000_000),
    outputBuffer: [],
    ...over,
  };
}

describe('buildSnapshot', () => {
  beforeEach(() => {
    procs.length = 0;
    infoBatch.mockReset().mockReturnValue(new Map());
    pidAlive.mockReset().mockReturnValue(true);
  });

  it('快照只带事实, 不带 classification/adoptable 这类结论', () => {
    procs.push(makeProc());
    const f = buildSnapshot().processes[0];
    expect(f).not.toHaveProperty('classification');
    expect(f).not.toHaveProperty('adoptable');
    expect(f.pid).toBe(100);
    expect(f.status).toBe('running');
  });

  it('按 workspaceRoot 过滤 —— 多项目窗口不该互相看到对方的服务', () => {
    procs.push(makeProc({ pid: 1, workspaceRoot: '/a' }), makeProc({ pid: 2, workspaceRoot: '/b' }));
    expect(buildSnapshot('/a').processes.map(p => p.pid)).toEqual([1]);
    expect(buildSnapshot().processes.map(p => p.pid).sort()).toEqual([1, 2]);
  });

  it('退出超过保留窗口的进程不再出现在活跃快照里 (但日志仍在盘上)', () => {
    const longAgo = new Date(Date.now() - 10 * 60 * 1000);
    procs.push(makeProc({ pid: 1, status: 'completed', endTime: longAgo }));
    expect(buildSnapshot().processes).toEqual([]);
  });

  it('带出最后一行 stdout 作为单行预览', () => {
    procs.push(makeProc({ outputBuffer: ['starting…', 'listening on 3000', ''] }));
    expect(buildSnapshot().processes[0].lastOutputLine).toBe('listening on 3000');
  });
});

describe('tick — 判活', () => {
  beforeEach(() => {
    procs.length = 0;
    infoBatch.mockReset().mockReturnValue(new Map());
    pidAlive.mockReset().mockReturnValue(true);
    markCompleted.mockClear();
    markVanished.mockClear();
    setPort.mockClear();
    probeListeningPort.mockReset().mockResolvedValue(undefined);
    vi.useFakeTimers();
  });
  afterEach(() => { stopServiceSnapshotTick(); vi.useRealTimers(); });

  it('进程没了 → 下一个 tick 就标记退出 (不依赖任何退出事件)', async () => {
    procs.push(makeProc());
    pidAlive.mockReturnValue(false);
    startServiceSnapshotTick(() => {});
    await vi.advanceTimersByTimeAsync(2_000);
    expect(markVanished).toHaveBeenCalledWith(100);
  });

  it('人间蒸发的进程绝不能记成 "completed exit 0" —— 那是往"一切正常"方向撒谎', async () => {
    procs.push(makeProc());
    pidAlive.mockReturnValue(false);
    startServiceSnapshotTick(() => {});
    await vi.advanceTimersByTimeAsync(2_000);
    /* 只能调 markVanished (status=killed, 无 exitCode), 不许调 markCompleted 编一个 0 出来 */
    expect(markCompleted).not.toHaveBeenCalled();
  });

  it('pid 被复用 → 启动时间对不上, 判定为已退出, 不会永远显示在跑', async () => {
    procs.push(makeProc());
    pidAlive.mockReturnValue(true);
    /* OS 上确实有个 pid=100, 但它是 5 分钟后才起的另一个进程 */
    infoBatch.mockReturnValue(new Map([[100, { startTimeMs: 1_000_000 + 300_000, stopped: false }]]));
    startServiceSnapshotTick(() => {});
    await vi.advanceTimersByTimeAsync(2_000);
    expect(markVanished).toHaveBeenCalledWith(100);
  });

  it('拿不到启动时间时保守当活着 —— 宁可晚一点标退出, 不误报死亡', async () => {
    procs.push(makeProc());
    pidAlive.mockReturnValue(true);
    infoBatch.mockReturnValue(new Map()); /* ps 不可用 */
    startServiceSnapshotTick(() => {});
    await vi.advanceTimersByTimeAsync(2_000);
    expect(markVanished).not.toHaveBeenCalled();
  });

  it('多个工程窗口各拿各的快照 —— 模块级单例守卫会静默吞掉第二个订阅者', async () => {
    procs.push(makeProc({ pid: 1, workspaceRoot: '/a' }), makeProc({ pid: 2, workspaceRoot: '/b' }));
    infoBatch.mockReturnValue(new Map());
    const pubA = vi.fn(); const pubB = vi.fn();
    startServiceSnapshotTick(pubA, '/a');
    startServiceSnapshotTick(pubB, '/b');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pubA).toHaveBeenCalled();
    expect(pubB).toHaveBeenCalled();  /* 老实现这里是 0 次 */
    expect(pubA.mock.calls[0][0].processes.map((p: any) => p.pid)).toEqual([1]);
    expect(pubB.mock.calls[0][0].processes.map((p: any) => p.pid)).toEqual([2]);
  });

  it('取消订阅后不再收到推送 (窗口关掉后往已销毁的 bus 推是内存泄漏)', async () => {
    procs.push(makeProc());
    infoBatch.mockReturnValue(new Map());
    const pub = vi.fn();
    const unsub = startServiceSnapshotTick(pub);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pub).toHaveBeenCalledTimes(1);
    unsub();
    procs.push(makeProc({ pid: 999 }));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(pub).toHaveBeenCalledTimes(1);
  });

  it('快照没变化就不推 —— 否则 renderer 每 2s 重渲整列表, xterm 会抖', async () => {
    procs.push(makeProc());
    infoBatch.mockReturnValue(new Map([[100, { startTimeMs: 1_000_000, stopped: false }]]));
    const publish = vi.fn();
    startServiceSnapshotTick(publish);
    await vi.advanceTimersByTimeAsync(2_000);
    const first = publish.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(publish.mock.calls.length).toBe(first);
  });
});

describe('tick — 端口探测与服务持久化', () => {
  beforeEach(() => {
    procs.length = 0;
    /* 空表 = ps 拿不到启动时间 → 判活走保守分支(当活着)。这里要测的是端口探测,
     * 不想被 pid 复用校验的时钟对齐干扰 (那条单独有用例)。 */
    infoBatch.mockReset().mockReturnValue(new Map());
    pidAlive.mockReset().mockReturnValue(true);
    setPort.mockClear(); bindConfig.mockClear();
    storeList.mockReset().mockReturnValue([]);
    storeUpsert.mockReset().mockImplementation((i: any) => ({ ...i }));
    findByCommandCwd.mockReset().mockReturnValue(undefined);
    probeListeningPort.mockReset().mockResolvedValue(undefined);
    vi.useFakeTimers();
  });
  afterEach(() => { stopServiceSnapshotTick(); vi.useRealTimers(); });

  it('慢启动服务也能探到端口 (JVM 类要十几秒)', async () => {
    procs.push(makeProc({ startTime: new Date(Date.now()) }));
    probeListeningPort.mockResolvedValueOnce(undefined).mockResolvedValue(8080);
    startServiceSnapshotTick(() => {});
    await vi.advanceTimersByTimeAsync(20_000);
    expect(setPort).toHaveBeenCalledWith(100, 8080);
  });

  it('探到端口**不再**自动写 RunConfig —— 那是 agent 主动改用户的工程', async () => {
    procs.push(makeProc({ startTime: new Date(Date.now()) }));
    probeListeningPort.mockResolvedValue(4321);
    startServiceSnapshotTick(() => {});
    await vi.advanceTimersByTimeAsync(3_000);
    expect(setPort).toHaveBeenCalledWith(100, 4321);   /* 端口该记还是记 —— 那是事实 */
    expect(storeUpsert).not.toHaveBeenCalled();        /* 但绝不替用户落盘配置 */
    expect(bindConfig).not.toHaveBeenCalled();
  });

  it('已有同端口配置时也不自动绑 —— 绑定同样是用户的决定', async () => {
    procs.push(makeProc({ startTime: new Date(Date.now()), command: 'node -e "boot({port:3000})"' }));
    storeList.mockReturnValue([{ id: 'api', name: 'API', command: 'node -e "boot()"', cwd: '/ws', port: 3000 }]);
    probeListeningPort.mockResolvedValue(3000);
    startServiceSnapshotTick(() => {});
    await vi.advanceTimersByTimeAsync(3_000);
    expect(storeUpsert).not.toHaveBeenCalled();
    expect(bindConfig).not.toHaveBeenCalled();
  });
});
