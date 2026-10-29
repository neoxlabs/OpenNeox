import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('@neoxlabs/platform/platform/osNotifier.js', () => ({ sendOsNotification: async () => {} }));

const { MonitorRegistry, MAX_PER_SESSION } = await import('../monitorRegistry.js');
const { getBackgroundTaskNotifier } = await import('../backgroundTaskNotifier.js');

function fakeDeps() {
  const bus = new EventEmitter();
  const running = new Set<number>([101]);
  const watchers: Array<(f: string | null) => void> = [];
  let runResult: { exitCode: number; output: string } = { exitCode: 1, output: '' };
  const runCommand = vi.fn(async () => runResult);
  return {
    deps: {
      onProcessOutput: (cb: any) => { bus.on('out', cb); return () => bus.off('out', cb); },
      onProcessEnd: (cb: any) => { bus.on('end', cb); return () => bus.off('end', cb); },
      isProcessRunning: (pid: number) => running.has(pid),
      runCommand,
      watchPath: (_p: string, cb: any) => { watchers.push(cb); return { close: () => {} }; },
    },
    out: (pid: number, text: string) => bus.emit('out', pid, text),
    end: (pid: number) => { running.delete(pid); bus.emit('end', pid); },
    setRun: (r: { exitCode: number; output: string }) => { runResult = r; },
    runCommand,
    touch: (f: string) => watchers.forEach((w) => w(f)),
  };
}

const events: any[] = [];
const onNotif = (e: any) => events.push(e);

beforeEach(() => {
  vi.useFakeTimers();
  events.length = 0;
  getBackgroundTaskNotifier().on('notification', onNotif);
});
afterEach(() => {
  getBackgroundTaskNotifier().off('notification', onNotif);
  getBackgroundTaskNotifier().drainForSession('s1');
  vi.useRealTimers();
});

const base = { sessionId: 's1', label: '盯服务报错', prompt: '看日志修掉' };

describe('output', () => {
  it('跨 chunk 拼行, 2 秒内多行合成一条, 走总线 kind=monitor', async () => {
    const f = fakeDeps();
    const reg = new MonitorRegistry(f.deps);
    const r = reg.start({ ...base, trigger: { type: 'output', pid: 101, pattern: 'error' }, maxFires: 3 });
    expect('id' in r).toBe(true);
    f.out(101, 'ok line\nfirst ERR');
    f.out(101, 'OR here\nfine\nsecond error\n');
    expect(events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2100);
    expect(events).toHaveLength(1);
    expect(events[0].notif.kind).toBe('monitor');
    expect(events[0].notif.xml).toContain('first ERROR here');
    expect(events[0].notif.xml).toContain('second error');
    expect(events[0].notif.xml).toContain('1/3 (still watching)');
  });

  it('进程不在跑就不开', () => {
    const f = fakeDeps();
    const r = new MonitorRegistry(f.deps).start({ ...base, trigger: { type: 'output', pid: 999, pattern: 'x' } });
    expect('error' in r && r.error).toMatch(/not running/);
  });

  it('进程退出: 没发的先发掉, 然后监控结束', async () => {
    const f = fakeDeps();
    const reg = new MonitorRegistry(f.deps);
    reg.start({ ...base, trigger: { type: 'output', pid: 101, pattern: 'fatal' }, maxFires: 5 });
    f.out(101, 'boom fatal');
    f.end(101);
    expect(events).toHaveLength(1);
    expect(events[0].notif.xml).toContain('boom fatal');
    expect(reg.listForSession('s1')).toHaveLength(0);
  });

  it('非法正则直接报错', () => {
    const f = fakeDeps();
    const r = new MonitorRegistry(f.deps).start({ ...base, trigger: { type: 'output', pid: 101, pattern: '(' } });
    expect('error' in r && r.error).toMatch(/regular expression/);
  });
});

describe('poll', () => {
  it('只在由假变真时叫; 一直成立不重复叫', async () => {
    const f = fakeDeps();
    const reg = new MonitorRegistry(f.deps);
    reg.start({ ...base, trigger: { type: 'poll', command: 'curl -sf x', intervalSeconds: 10, until: 'success' }, maxFires: 5 });
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toHaveLength(0);
    f.setRun({ exitCode: 0, output: 'up' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(events).toHaveLength(1);
    f.setRun({ exitCode: 7, output: 'down' });
    await vi.advanceTimersByTimeAsync(10_000);
    f.setRun({ exitCode: 0, output: 'up again' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(events).toHaveLength(2);
  });

  it('change: 第一次是基线, 之后变了才叫', async () => {
    const f = fakeDeps();
    const reg = new MonitorRegistry(f.deps);
    f.setRun({ exitCode: 0, output: 'reviews: 0' });
    reg.start({ ...base, trigger: { type: 'poll', command: 'gh pr view', intervalSeconds: 10, until: 'change' } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).toHaveLength(0);
    f.setRun({ exitCode: 0, output: 'reviews: 1' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).toHaveLength(1);
    expect(events[0].notif.xml).toContain('reviews: 1');
    /* 次数用完 (默认 1) 就停, 不再跑 */
    const calls = f.runCommand.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.runCommand.mock.calls.length).toBe(calls);
  });

  it('间隔夹到下限 10 秒', () => {
    const f = fakeDeps();
    const r = new MonitorRegistry(f.deps).start({ ...base, trigger: { type: 'poll', command: 'x', intervalSeconds: 1, until: 'success' } });
    expect('info' in r && (r.info.trigger as any).intervalSeconds).toBe(10);
  });
});

describe('file', () => {
  it('1.5 秒内的改动合成一条, 忽略 node_modules', async () => {
    const f = fakeDeps();
    new MonitorRegistry(f.deps).start({ ...base, trigger: { type: 'file', path: '/w/src' } });
    f.touch('a.ts');
    f.touch('node_modules/x/index.js');
    f.touch('b.ts');
    await vi.advanceTimersByTimeAsync(1600);
    expect(events).toHaveLength(1);
    expect(events[0].notif.xml).toContain('a.ts\nb.ts');
    expect(events[0].notif.xml).not.toContain('node_modules');
  });

  it('路径盯不了 → 直接报错, 不假装在盯', () => {
    const f = fakeDeps();
    const reg = new MonitorRegistry({ ...f.deps, watchPath: () => { throw new Error('ENOENT'); } });
    const r = reg.start({ ...base, trigger: { type: 'file', path: '/nope' } });
    expect('error' in r && r.error).toMatch(/ENOENT/);
    expect(reg.listForSession('s1')).toHaveLength(0);
  });
});

describe('冷却: 两次触发至少隔 1 分钟 (每次触发 = 代用户起一整轮)', () => {
  it('持续报错的服务: 冷却期内的命中攒成下一条, 不是每 2 秒叫一次', async () => {
    const f = fakeDeps();
    new MonitorRegistry(f.deps).start({ ...base, trigger: { type: 'output', pid: 101, pattern: 'error' }, maxFires: 10 });
    f.out(101, 'error 1\n');
    await vi.advanceTimersByTimeAsync(2100);
    expect(events).toHaveLength(1);
    for (let i = 2; i <= 6; i++) { f.out(101, `error ${i}\n`); await vi.advanceTimersByTimeAsync(5000); }
    expect(events).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(events).toHaveLength(2);
    expect(events[1].notif.xml).toContain('error 2');
    expect(events[1].notif.xml).toContain('error 6');
  });

  it('poll change 每次都变: 冷却期内不叫, 过了按最新的补一条', async () => {
    const f = fakeDeps();
    let n = 0;
    f.runCommand.mockImplementation(async () => ({ exitCode: 0, output: `count ${n++}` }));
    new MonitorRegistry(f.deps).start({ ...base, trigger: { type: 'poll', command: 'c', intervalSeconds: 10, until: 'change' }, maxFires: 10 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(events).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).toHaveLength(2);
  });
});

describe('重启恢复 (桌面端有 store)', () => {
  function memStore() {
    let saved: any[] = [];
    return { load: () => saved, save: (all: any[]) => { saved = JSON.parse(JSON.stringify(all)); }, peek: () => saved };
  }

  it('poll / file 接着盯; output 接不回来 → 停掉并留一句, 不代用户起轮', async () => {
    const f = fakeDeps();
    const store = memStore();
    const reg1 = new MonitorRegistry({ ...f.deps, store });
    reg1.start({ ...base, trigger: { type: 'poll', command: 'curl', intervalSeconds: 10, until: 'success' }, cwd: '/w' });
    reg1.start({ ...base, trigger: { type: 'file', path: '/w/src' } });
    reg1.start({ ...base, trigger: { type: 'output', pid: 101, pattern: 'x' } });
    expect(store.peek()).toHaveLength(3);

    const enqueue = vi.spyOn(getBackgroundTaskNotifier(), 'enqueueMessageForSession');
    const reg2 = new MonitorRegistry({ ...fakeDeps().deps, store });
    const kinds = reg2.listForSession('s1').map((m) => m.trigger.type).sort();
    expect(kinds).toEqual(['file', 'poll']);
    expect(reg2.listForSession('s1').find((m) => m.trigger.type === 'poll')?.cwd).toBe('/w');
    const note = enqueue.mock.calls.find((c) => String(c[1]).includes('can no longer be followed'));
    expect(note?.[2]).toMatchObject({ kind: 'monitor', noAutoResume: true });
    expect(store.peek()).toHaveLength(2);
    enqueue.mockRestore();
  });

  it('停机期间到期、一次没命中: 留一句, 不代用户起轮, 不再盯', () => {
    const store = memStore();
    store.save([{ id: 'mon-old', sessionId: 's1', label: '等部署', prompt: 'p', trigger: { type: 'file', path: '/w' },
      fires: 0, maxFires: 1, createdAt: Date.now() - 7200_000, expiresAt: Date.now() - 60_000 }]);
    const enqueue = vi.spyOn(getBackgroundTaskNotifier(), 'enqueueMessageForSession');
    const reg = new MonitorRegistry({ ...fakeDeps().deps, store });
    expect(reg.listForSession('s1')).toHaveLength(0);
    expect(enqueue.mock.calls[0]?.[2]).toMatchObject({ noAutoResume: true });
    expect(String(enqueue.mock.calls[0]?.[1])).toContain('Expired while Neox was closed');
    enqueue.mockRestore();
  });

  it('列表一变就广播 (界面药丸靠它)', async () => {
    const { onMonitorsChanged } = await import('../monitorRegistry.js');
    const seen: number[] = [];
    const off = onMonitorsChanged((_sid, list) => seen.push(list.length));
    const reg = new MonitorRegistry(fakeDeps().deps);
    const r = reg.start({ ...base, trigger: { type: 'file', path: '/w' } }) as any;
    reg.stop(r.id);
    off();
    expect(seen).toEqual([1, 0]);
  });
});

describe('用户从界面停掉', () => {
  it('agent 要知道 (入收件箱, 不起轮); 别的会话的停不了', async () => {
    const { monitorBridgeMethods, setMonitorDepsFactory, __resetMonitorRegistryForTest } = await import('../monitorRegistry.js');
    __resetMonitorRegistryForTest();
    setMonitorDepsFactory(() => fakeDeps().deps as any);
    const { getMonitorRegistry } = await import('../monitorRegistry.js');
    const r = getMonitorRegistry()!.start({ ...base, trigger: { type: 'file', path: '/w' } }) as any;
    const enqueue = vi.spyOn(getBackgroundTaskNotifier(), 'enqueueMessageForSession');
    expect(monitorBridgeMethods.stopMonitor('other-session', r.id)).toBe(false);
    expect(monitorBridgeMethods.stopMonitor('s1', r.id)).toBe(true);
    expect(String(enqueue.mock.calls[0]![1])).toContain('<outcome>stopped</outcome>');
    expect(enqueue.mock.calls[0]![2]).toMatchObject({ noAutoResume: true, terminatedBy: 'user' });
    enqueue.mockRestore();
    __resetMonitorRegistryForTest();
  });
});

describe('尽头', () => {
  it('超时且一次没命中: 叫醒一次说明条件没出现', async () => {
    const f = fakeDeps();
    const reg = new MonitorRegistry(f.deps);
    reg.start({ ...base, trigger: { type: 'output', pid: 101, pattern: 'never' }, timeoutSeconds: 120 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(events).toHaveLength(1);
    expect(events[0].notif.xml).toContain('<outcome>timeout</outcome>');
    expect(reg.listForSession('s1')).toHaveLength(0);
  });

  it('每个会话有上限', () => {
    const f = fakeDeps();
    const reg = new MonitorRegistry(f.deps);
    for (let i = 0; i < MAX_PER_SESSION; i++) reg.start({ ...base, trigger: { type: 'file', path: `/w/${i}` } });
    const r = reg.start({ ...base, trigger: { type: 'file', path: '/w/x' } });
    expect('error' in r && r.error).toMatch(/already has/);
  });

  it('停掉后不再投递', async () => {
    const f = fakeDeps();
    const reg = new MonitorRegistry(f.deps);
    const r = reg.start({ ...base, trigger: { type: 'output', pid: 101, pattern: 'x' } }) as any;
    reg.stop(r.id);
    f.out(101, 'x\n');
    await vi.advanceTimersByTimeAsync(3000);
    expect(events).toHaveLength(0);
  });
});
