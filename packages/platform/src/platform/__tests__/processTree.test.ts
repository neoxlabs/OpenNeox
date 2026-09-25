/**
 * processTree 解析层契约。
 * ═══════════════════════════════════════════════════════════════════════════
 * Windows 分支依赖固定的命令输出格式，当前平台无法直接执行这些分支，因此测试通过
 * 真实输出形状验证解析和建树逻辑。
 *
 * 样本全部取自真实输出格式:
 *   · `ps -Ao pid=,ppid=`                        (macOS / Linux)
 *   · `wmic process get ProcessId,ParentProcessId` (Windows, 表头列序会变)
 *   · `wmic process get ProcessId,CreationDate`    (Windows, pid 复用防线)
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

/* 这些内部函数不导出 —— 通过 mock child_process 让公开 API 吃到我们给的输出。 */
const execSyncMock = vi.fn();
vi.mock('node:child_process', () => ({
  execSync: (...a: any[]) => execSyncMock(...a),
  execFile: (_c: any, _a: any, _o: any, cb: any) => cb(null, { stdout: '' }, ''),
}));

const { getDescendantPids, getAncestorPids, getProcessInfoBatch, __resetProcessTableCache } =
  await import('../processTree.js');

beforeEach(() => {
  __resetProcessTableCache();
  execSyncMock.mockReset();
});

/* pid 100 ← 200 ← 300, 另有无关的 900 */
const PS_SAMPLE = `
  100     1
  200   100
  300   200
  900     1
`;

describe('Unix: ps 全表建树', () => {
  it('一次调用拿到整棵子孙树 (不再逐节点 fork)', () => {
    execSyncMock.mockReturnValue(PS_SAMPLE);
    expect(getDescendantPids(100).sort()).toEqual([200, 300]);
    /* 整棵树由一次系统查询提供。 */
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it('祖先链也走同一张表 (旧实现每往上一跳一次 ps)', () => {
    execSyncMock.mockReturnValue(PS_SAMPLE);
    expect(getAncestorPids(300)).toEqual([200, 100]);
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it('叶子节点没有子孙', () => {
    execSyncMock.mockReturnValue(PS_SAMPLE);
    expect(getDescendantPids(300)).toEqual([]);
  });

  /* 每次查询读取新表，保证刚创建的子进程可见；性能来自一次读取全表，而不是陈旧缓存。 */
  it('每次查都取新表 —— 刚 spawn 的子进程必须立刻可见', () => {
    execSyncMock.mockReturnValue(PS_SAMPLE);
    getDescendantPids(100);
    getDescendantPids(100);
    expect(execSyncMock).toHaveBeenCalledTimes(2);
  });

  it('ps 挂了 → 空表, 不抛 (调用方至少还能杀 root)', () => {
    execSyncMock.mockImplementation(() => { throw new Error('ps: command not found'); });
    expect(getDescendantPids(100)).toEqual([]);
    expect(getAncestorPids(100)).toEqual([]);
  });
});

describe('Windows: wmic 表格解析', () => {
  /* wmic 输出包含表头；解析器必须根据表头识别列序。 */
  const WMIC_TABLE = [
    'ParentProcessId  ProcessId',
    '1                100',
    '100              200',
    '200              300',
    '1                900',
  ].join('\r\n');

  it('按表头认列序, 不靠位置硬编码', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    execSyncMock.mockReturnValue(WMIC_TABLE);
    expect(getDescendantPids(100).sort()).toEqual([200, 300]);
    vi.unstubAllGlobals();
  });

  it('列序反过来 (ProcessId 在前) 也要对', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    execSyncMock.mockReturnValue([
      'ProcessId  ParentProcessId',
      '100        1',
      '200        100',
      '300        200',
    ].join('\r\n'));
    expect(getDescendantPids(100).sort()).toEqual([200, 300]);
    vi.unstubAllGlobals();
  });

  it('wmic 返回空 (Win11 已弃用) → 回落 PowerShell', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    execSyncMock
      .mockReturnValueOnce('ParentProcessId  ProcessId\r\n')   /* wmic 空表 */
      .mockReturnValueOnce('100 1\r\n200 100\r\n300 200\r\n'); /* PowerShell 输出 */
    expect(getDescendantPids(100).sort()).toEqual([200, 300]);
    expect(execSyncMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});

describe('Windows: pid 复用防线 (以前是空实现)', () => {
  it('解析 wmic CreationDate → epoch ms', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    /* 20260805013045.123456+480 =  01:30:45.123 UTC+8 */
    execSyncMock.mockReturnValue([
      'CreationDate               ProcessId',
      '20260805013045.123456+480  100',
    ].join('\r\n'));
    const info = getProcessInfoBatch([100]);
    const startedAt = info.get(100)?.startTimeMs;
    expect(startedAt).toBe(Date.UTC(2026, 7, 5, 1, 30, 45, 123) - 480 * 60_000);
    vi.unstubAllGlobals();
  });

  it('日期格式认不出来时返回 undefined —— 调用方按"拿不到信息"保守处理, 绝不误杀', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    execSyncMock.mockReturnValue('CreationDate  ProcessId\r\ngarbage  100');
    expect(getProcessInfoBatch([100]).get(100)?.startTimeMs).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe('Unix: ps STAT 暂停态', () => {
  it('STAT 含 T = 被 SIGTSTP 挂起', () => {
    execSyncMock.mockReturnValue('  100 T    Wed Aug  5 01:30:45 2026\n  200 S+   Wed Aug  5 01:30:45 2026');
    const info = getProcessInfoBatch([100, 200]);
    expect(info.get(100)?.stopped).toBe(true);
    expect(info.get(200)?.stopped).toBe(false);
  });
});
