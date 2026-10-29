import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { BackgroundTask } from '../backgroundTasksStore';

/* 渲染端测试的既有做法: useI18n 会把 @neoxlabs/platform 拉进来 (node 下没构建产物),
 * 这里只需要它给个语言, mock 掉。 */
vi.mock('../../hooks/useI18n', () => ({ getGlobalLanguage: () => 'zh' }));

const mod = await import('../serviceAutoShow');
const {
  applySnapshot,
  buildAutoShowEvents,
  createAutoShowTracker,
  planAutoShow,
  DEFAULT_SERVICE_AUTO_SHOW_MODE,
  getServiceAutoShowMode,
  setServiceAutoShowMode,
  resetServiceAutoShowForTest,
} = mod;

const T0 = 1_000_000;

function task(over: Partial<BackgroundTask> = {}): BackgroundTask {
  const pid = over.pid ?? 4242;
  return {
    taskId: pid,
    pid,
    command: 'python -m http.server 8123',
    startedAtMs: T0,
    status: 'running',
    ...over,
  } as BackgroundTask;
}

function collector() {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    deps: {
      mode: 'push' as const,
      panelHasOtherSurfaces: false,
      dispatch: (d: Record<string, unknown>) => { events.push(d); },
    },
  };
}

beforeEach(() => {
  resetServiceAutoShowForTest();
  setServiceAutoShowMode(DEFAULT_SERVICE_AUTO_SHOW_MODE);
});

describe('planAutoShow — 该弹谁', () => {
  it('第一份快照是基线: 已经在跑的服务不弹', () => {
    const tracker = createAutoShowTracker();
    const due = planAutoShow(tracker, [task({ configId: 'backend', port: 3000 })], T0 + 1000);
    expect(due).toEqual([]);
    expect(tracker.primed).toBe(true);
  });

  it('基线之后新起的服务弹, 同一个 pid 只弹一次', () => {
    const tracker = createAutoShowTracker();
    planAutoShow(tracker, [], T0);                       /* 空快照 = 明确基线 */
    const due1 = planAutoShow(tracker, [task({ pid: 77, port: 3000 })], T0 + 2000);
    expect(due1.map(t => t.pid)).toEqual([77]);
    /* 下一份快照里同一个 pid 还在跑 —— 不能再弹 */
    expect(planAutoShow(tracker, [task({ pid: 77, port: 3000 })], T0 + 4000)).toEqual([]);
  });

  it('先起的进程后来才探到端口 → 这时弹 (有可访问端口 / 预览 URL 的时机)', () => {
    const tracker = createAutoShowTracker();
    planAutoShow(tracker, [], T0);
    /* 起来那一刻既没 config 也没端口, 还不够 15 秒 */
    expect(planAutoShow(tracker, [task({ pid: 88 })], T0 + 1000)).toEqual([]);
    /* 2 秒后端口探到了 */
    const due = planAutoShow(tracker, [task({ pid: 88, port: 5173 })], T0 + 3000);
    expect(due.map(t => t.pid)).toEqual([88]);
  });

  it('长跑命令活过门槛也弹 (没有端口也要看得见)', () => {
    const tracker = createAutoShowTracker();
    planAutoShow(tracker, [], T0);
    expect(planAutoShow(tracker, [task({ pid: 99 })], T0 + 1000)).toEqual([]);
    const due = planAutoShow(tracker, [task({ pid: 99 })], T0 + 20_000);
    expect(due.map(t => t.pid)).toEqual([99]);
  });

  it('已经结束的服务不弹, free-shell / 子 agent 任务也不弹', () => {
    const tracker = createAutoShowTracker();
    planAutoShow(tracker, [], T0);
    const due = planAutoShow(tracker, [
      task({ pid: 1, status: 'completed', endedAtMs: T0 + 900, configId: 'x' }),
      task({ pid: 2, status: 'failed', endedAtMs: T0 + 900 }),
      task({ pid: 3, kind: 'free-shell', port: 4000 }),
      task({ pid: 4, kind: 'agent-task', configId: 'x' }),
    ], T0 + 2000);
    expect(due).toEqual([]);
  });
});

describe('buildAutoShowEvents — 开什么', () => {
  it('有端口: 先预览页, 后服务面板; 服务面板带 selectedPid 且展开右栏', () => {
    const evs = buildAutoShowEvents(task({ pid: 12, port: 8123 }), { includePreview: true, zh: true });
    expect(evs).toHaveLength(2);
    expect(evs[0]).toMatchObject({ kind: 'web', source: { type: 'url', url: 'http://localhost:8123' }, revealPanel: false });
    expect(evs[1]).toMatchObject({ kind: 'services', revealPanel: true, metadata: { selectedPid: 12 } });
  });

  it('没有端口只开服务面板 (日志)', () => {
    const evs = buildAutoShowEvents(task({ pid: 13 }), { includePreview: true, zh: true });
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ kind: 'services' });
  });

  it('面板里已经开着别的产出时不额外开预览页 (只多一个标签, 不打扰)', () => {
    const evs = buildAutoShowEvents(task({ pid: 14, port: 9000 }), { includePreview: false, zh: true });
    expect(evs.map(e => e.kind)).toEqual(['services']);
  });
});

describe('applySnapshot — 自动显示方式', () => {
  it('push: 新服务 → 派事件, 不动版面', () => {
    const tracker = createAutoShowTracker();
    planAutoShow(tracker, [], T0);
    const { events, deps } = collector();
    let floatCalled = 0;
    const due = applySnapshot([task({ pid: 21, port: 3000 })], {
      ...deps, mode: 'push', now: T0 + 1000, enterFloatLayout: () => { floatCalled++; },
    }, tracker);
    expect(due.map(t => t.pid)).toEqual([21]);
    expect(events.map(e => e.kind)).toEqual(['web', 'services']);
    expect(floatCalled).toBe(0);
  });

  it('float: 先切悬浮版面, 再派事件', () => {
    const tracker = createAutoShowTracker();
    planAutoShow(tracker, [], T0);
    const { events, deps } = collector();
    let floatCalled = 0;
    applySnapshot([task({ pid: 22, configId: 'web' })], {
      ...deps, mode: 'float', now: T0 + 1000, enterFloatLayout: () => { floatCalled++; },
    }, tracker);
    expect(floatCalled).toBe(1);
    expect(events.map(e => e.kind)).toEqual(['services']);
  });

  it('off: 一个事件都不派, 但照样推进基线 —— 重新打开不会补弹历史', () => {
    const tracker = createAutoShowTracker();
    planAutoShow(tracker, [], T0);
    const { events, deps } = collector();
    applySnapshot([task({ pid: 23, port: 3000 })], { ...deps, mode: 'off', now: T0 + 1000 }, tracker);
    expect(events).toEqual([]);
    /* 用户把开关打开, 下一份快照里同一个服务还在跑 —— 不补弹 */
    const after = applySnapshot([task({ pid: 23, port: 3000 })], { ...deps, mode: 'push', now: T0 + 3000 }, tracker);
    expect(after).toEqual([]);
    expect(events).toEqual([]);
  });

  it('服务退出: 什么都不做 (面板停在已停止, 不自动关)', () => {
    const tracker = createAutoShowTracker();
    planAutoShow(tracker, [], T0);
    const { events, deps } = collector();
    const due = applySnapshot([
      task({ pid: 24, port: 3000, status: 'completed', endedAtMs: T0 + 5000, exitCode: 0 }),
    ], { ...deps, mode: 'push', now: T0 + 6000 }, tracker);
    expect(due).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe('自动显示方式偏好', () => {
  it('默认右侧推开', () => {
    expect(DEFAULT_SERVICE_AUTO_SHOW_MODE).toBe('push');
    expect(getServiceAutoShowMode()).toBe('push');
  });

  it('可以切到悬浮 / 关掉, 非法值忽略', () => {
    setServiceAutoShowMode('float');
    expect(getServiceAutoShowMode()).toBe('float');
    setServiceAutoShowMode('off');
    expect(getServiceAutoShowMode()).toBe('off');
    setServiceAutoShowMode('nonsense' as any);
    expect(getServiceAutoShowMode()).toBe('off');
  });
});

describe('接线: 快照进来 → 真的派 neox:open-surface', () => {
  it('新服务起来派事件, 服务退出后不再派任何事件', async () => {
    const store = await import('../backgroundTasksStore');
    store._resetBackgroundTasksStoreForTest();
    const origWindow = (globalThis as any).window;
    const seen: Array<Record<string, any>> = [];
    (globalThis as any).window = {
      dispatchEvent: (e: any) => { seen.push(e.detail); return true; },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const off = mod.initServiceAutoShow({ getSessionId: () => 'S1' });
    try {
      /* 第一份空快照 = 基线 */
      store.ingestServiceSnapshot({ generatedAt: T0, processes: [] });
      expect(seen).toEqual([]);

      /* agent 起了一个 dev server */
      store.ingestServiceSnapshot({
        generatedAt: T0 + 1000,
        processes: [{
          pid: 501, command: 'python -m http.server 8123',
          startTime: T0 + 900, status: 'running', port: 8123,
        }],
      });
      expect(seen.map(d => d.kind)).toEqual(['web', 'services']);
      expect(seen[1]).toMatchObject({ metadata: { selectedPid: 501 }, revealPanel: true });

      /* 服务退出: 面板要停在"已停止", 这里不派关闭 / 重开 */
      store.ingestServiceSnapshot({
        generatedAt: T0 + 3000,
        processes: [{
          pid: 501, command: 'python -m http.server 8123',
          startTime: T0 + 900, status: 'completed', endTime: T0 + 2900, exitCode: 0,
        }],
      });
      expect(seen).toHaveLength(2);
    } finally {
      off();
      (globalThis as any).window = origWindow;
      store._resetBackgroundTasksStoreForTest();
    }
  });
});
