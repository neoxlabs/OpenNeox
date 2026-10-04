import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';


const probeListeningPort = vi.fn(async (_pid: number): Promise<number | undefined> => undefined);
const isLikelyLongRunningCommand = vi.fn((_cmd: string) => false);
vi.mock('@neoxlabs/platform/platform/portProbe.js', () => ({
  probeListeningPort: (pid: number) => probeListeningPort(pid),
  isLikelyLongRunningCommand: (cmd: string) => isLikelyLongRunningCommand(cmd),
}));

const findByCommandCwd = vi.fn((_cmd: string, _cwd: string): any => undefined);
const storeList = vi.fn((): any[] => []);
const storeUpsert = vi.fn((input: any) => ({ ...input, createdAt: 1, updatedAt: 1 }));
vi.mock('../../../runtime/services/serviceConfigStoreCache.js', () => ({
  getServiceConfigStore: () => ({ findByCommandCwd, list: storeList, upsert: storeUpsert }),
}));

const startHealthCheck = vi.fn();
vi.mock('../../../runtime/services/healthChecker.js', () => ({
  startHealthCheck: (...args: any[]) => startHealthCheck(...args),
}));

import { enrichBackgroundProcess, attachServiceEnrichment } from '../backgroundProcessEnrichment.js';

function makePm(overrides?: Partial<Record<string, any>>) {
  const tracked = { pid: 100, status: 'running', port: undefined as number | undefined };
  return {
    tracked,
    get: vi.fn((pid: number) => (pid === tracked.pid ? tracked : undefined)),
    bindConfig: vi.fn(),
    setPort: vi.fn((_pid: number, port: number) => { tracked.port = port; }),
    markAdoptable: vi.fn(),
    ...overrides,
  } as any;
}

const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as any;

describe('enrichBackgroundProcess', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    probeListeningPort.mockReset().mockResolvedValue(undefined);
    isLikelyLongRunningCommand.mockReset().mockReturnValue(false);
    findByCommandCwd.mockReset().mockReturnValue(undefined);
    storeList.mockReset().mockReturnValue([]);
    storeUpsert.mockReset().mockImplementation((input: any) => ({ ...input, createdAt: 1, updatedAt: 1 }));
    startHealthCheck.mockReset();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('binds matching RunConfig and starts healthcheck when configured', async () => {
    const pm = makePm();
    findByCommandCwd.mockReturnValue({
      id: 'cfg-1', name: 'backend',
      healthcheck: { kind: 'port', target: '8080' },
    });
    enrichBackgroundProcess({ pid: 100, command: 'mvn spring-boot:run', workspaceRoot: '/ws', processManager: pm, logger });
    await vi.advanceTimersByTimeAsync(0);
    expect(pm.bindConfig).toHaveBeenCalledWith(100, 'cfg-1', 'backend');
    expect(startHealthCheck).toHaveBeenCalledWith(pm, 100, expect.objectContaining({ id: 'cfg-1' }));
  });

  it('does not start healthcheck when config has none', async () => {
    const pm = makePm();
    findByCommandCwd.mockReturnValue({ id: 'cfg-2', name: 'web' });
    enrichBackgroundProcess({ pid: 100, command: 'npm run dev', workspaceRoot: '/ws', processManager: pm, logger });
    await vi.advanceTimersByTimeAsync(0);
    expect(pm.bindConfig).toHaveBeenCalled();
    expect(startHealthCheck).not.toHaveBeenCalled();
  });

  it('bind failure is swallowed (never breaks process startup)', async () => {
    const pm = makePm();
    findByCommandCwd.mockImplementation(() => { throw new Error('store corrupt'); });
    expect(() => enrichBackgroundProcess({ pid: 100, command: 'x', workspaceRoot: '/ws', processManager: pm, logger })).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('attachServiceEnrichment (订阅 process:start)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    probeListeningPort.mockReset().mockResolvedValue(undefined);
    isLikelyLongRunningCommand.mockReset().mockReturnValue(false);
    findByCommandCwd.mockReset().mockReturnValue(undefined);
    storeList.mockReset().mockReturnValue([]);
    startHealthCheck.mockReset();
  });
  afterEach(() => { vi.useRealTimers(); });

  /** 只实现 enrichment 用得到的那部分 ProcessManager 表面 + 一个能手动触发的事件总线 */
  function makeEmittingPm() {
    const listeners: Array<(p: any) => void> = [];
    const tracked = { pid: 100, status: 'running', port: undefined as number | undefined };
    return {
      tracked,
      on: vi.fn((evt: string, fn: (p: any) => void) => { if (evt === 'process:start') listeners.push(fn); }),
      emitStart: (proc: any) => { for (const fn of listeners) fn(proc); },
      get: vi.fn((pid: number) => (pid === tracked.pid ? tracked : undefined)),
      bindConfig: vi.fn(),
      setPort: vi.fn((_pid: number, port: number) => { tracked.port = port; }),
      markAdoptable: vi.fn(),
    } as any;
  }

  const baseProc = {
    pid: 100,
    command: 'node -e "require(\'./server.js\')"',
    cwd: '/ws/packages/api',
    workspaceRoot: '/ws',
    background: true,
    kind: 'background-task' as const,
    origin: 'spawned' as const,
  };

  it('后台进程一 register 就跑 enrichment — 不依赖 spawn 路径自己调用', async () => {
    const pm = makeEmittingPm();
    findByCommandCwd.mockReturnValue({ id: 'cfg-1', name: 'api' });
    attachServiceEnrichment(pm, logger);
    pm.emitStart(baseProc);
    await vi.advanceTimersByTimeAsync(0);
    /* auto-bind 跑了 = enrichment 确实被触发 —— 这正是"超时领养"路径以前完全拿不到的 */
    expect(pm.bindConfig).toHaveBeenCalledWith(100, 'cfg-1', 'api');
  });

  it('workspaceRoot 用于查 RunConfig, cwd 用于匹配 spawn 目录 — 两者不许混', async () => {
    const pm = makeEmittingPm();
    attachServiceEnrichment(pm, logger);
    pm.emitStart(baseProc);
    await vi.advanceTimersByTimeAsync(0);
    /* findByCommandCwd 拿到的第二个参数必须是 spawnCwd(子目录), 而 store 是按 workspaceRoot 取的 */
    expect(findByCommandCwd).toHaveBeenCalledWith(baseProc.command, '/ws/packages/api');
  });

  it('free-shell 不是服务, 不 enrich', async () => {
    const pm = makeEmittingPm();
    findByCommandCwd.mockReturnValue({ id: 'cfg-1', name: 'api' });
    attachServiceEnrichment(pm, logger);
    pm.emitStart({ ...baseProc, kind: 'free-shell' });
    await vi.advanceTimersByTimeAsync(0);
    expect(pm.bindConfig).not.toHaveBeenCalled();
  });

  it('adopted 进程由 service_adopt 自己填端口/配置, 不 enrich', async () => {
    const pm = makeEmittingPm();
    findByCommandCwd.mockReturnValue({ id: 'cfg-1', name: 'api' });
    attachServiceEnrichment(pm, logger);
    pm.emitStart({ ...baseProc, origin: 'adopted' });
    await vi.advanceTimersByTimeAsync(0);
    expect(pm.bindConfig).not.toHaveBeenCalled();
  });

  it('前台进程 (background=false) 不 enrich', async () => {
    const pm = makeEmittingPm();
    findByCommandCwd.mockReturnValue({ id: 'cfg-1', name: 'api' });
    attachServiceEnrichment(pm, logger);
    pm.emitStart({ ...baseProc, background: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(pm.bindConfig).not.toHaveBeenCalled();
  });
});
