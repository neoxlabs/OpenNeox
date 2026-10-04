/**
 * processTree — 跨平台子孙 pid 枚举与存活检测。
 *
 * 用途:
 *   ProcessManager.killProcessGroup 不再依赖 OS 进程组级联 (`kill -pgid`),
 *   因为 node-pty / execa detached 默认 setsid 让 PTY 子进程跳出父进程 group,
 *   pgid 级联打不到. 改成主动枚举子孙树, 倒序 SIGTERM, 1.5s 兜底 SIGKILL —
 *   跟 IntelliJ IDEA 的 OSProcessUtil.killProcessTree (ProcessHandle.descendants())
 *   是同一套思路.
 *
 * 实现一次读取全系统的 `(pid, ppid)` 表，再在内存中完成祖先和后代遍历。同步 API 服务于
 * 注册等同步路径，异步 API 服务于清理和端口探测，避免系统调用阻塞事件循环。
 *
 * 实现:
 *   · macOS / Linux: `ps -Ao pid=,ppid=`
 *   · Windows:       `wmic process get ProcessId,ParentProcessId` → 失败回落 PowerShell CIM
 *                    (wmic 在 Win11 已被弃用, 不能只押它一个)
 *   · 失败一律返回空表, 调用方自行决策 (至少能杀 root)
 */

import { execSync, execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * 把一个工程根路径归一成可比较的 key。
 *
 * 服务归属按规范化路径比较。实现使用 `resolve`、`realpath` 解开软链接，并去掉尾部分隔符；
 * 目标不存在或不可访问时保留 `resolve` 的结果，确保同一来源仍可比较。
 */
const workspaceKeyCache = new Map<string, string>();

export function normalizeWorkspaceRoot(input: string): string {
  if (!input) return '';
  const cached = workspaceKeyCache.get(input);
  if (cached !== undefined) return cached;
  let out = resolve(input);
  try {
    out = realpathSync.native ? realpathSync.native(out) : realpathSync(out);
  } catch { /* 目录不存在 / 无权限: 用 resolve 的结果 */ }
  while (out.length > 1 && out.endsWith(sep)) out = out.slice(0, -1);
  /* 缓存上限, 防长跑进程里无限增长 (工程路径本来就没几个) */
  if (workspaceKeyCache.size > 256) workspaceKeyCache.clear();
  workspaceKeyCache.set(input, out);
  return out;
}

/* ── 全系统 (pid → ppid) 表 ─────────────────────────────────────────────────
 *
 * 一次取回, 内存建索引。TTL 很短 (500ms): 进程树在清场/探测的那一小段里是稳定的,
 * 但绝不能久缓存 —— 缓存一张过时的进程表去发 SIGKILL 就是误杀别人的进程。
 */
interface ProcessTable {
  /** pid → ppid */
  parentOf: Map<number, number>;
  /** ppid → 直接子 pid 列表 */
  childrenOf: Map<number, number[]>;
}

const EMPTY_TABLE: ProcessTable = { parentOf: new Map(), childrenOf: new Map() };
/**
 *  这里**没有** TTL 缓存, 是刻意的。
 *
 * 第一版加了个 500ms TTL, 想让一轮清场里 N 个服务共享一次 fork。既有的集成测试当场
 * 抓出问题: 刚 spawn 出来的孙进程在缓存表里根本不存在, 于是 killProcessGroup 漏杀 ——
 * 一个"性能优化"换来的是杀不干净, 而症状是残留孤儿进程, 极难追。
 *
 * 现在只保留 **in-flight 去重**: 同一瞬间并发的调用方共享同一次 fork (fork 是在请求
 * 那一刻发起的, 没有陈旧问题)。真正需要"一张一致快照"的扫描 (killAllTracked 遍历
 * N 个目标) 显式调 loadProcessTree() 拿一次表自己用 —— 那里要的正是快照语义。
 */
let tableInflight: Promise<ProcessTable> | null = null;

const PS_ARGS = ['-Ao', 'pid=,ppid='];
const WMIC_ARGS = ['process', 'get', 'ProcessId,ParentProcessId'];
/* wmic 在 Win11 已弃用 —— 必须有 PowerShell 回落, 否则新系统上整棵树枚举直接哑掉
 * (症状是"服务杀不干净"而不是报错, 极难联想)。 */
const PWSH_ARGS = [
  '-NoProfile', '-NonInteractive', '-Command',
  'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
];

/** 解析 "pid ppid" 逐行文本 (ps / PowerShell 同款形状) */
function parsePidPpidLines(out: string): ProcessTable {
  const parentOf = new Map<number, number>();
  const childrenOf = new Map<number, number[]>();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const ppid = parseInt(m[2], 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || pid <= 0) continue;
    parentOf.set(pid, ppid);
    const arr = childrenOf.get(ppid);
    if (arr) arr.push(pid);
    else childrenOf.set(ppid, [pid]);
  }
  return { parentOf, childrenOf };
}

/** 解析 wmic 表格输出 —— 表头是 "ParentProcessId  ProcessId" (列序固定, 但要按表头认) */
function parseWmicTable(out: string): ProcessTable {
  const lines = out.split('\n').map(l => l.trimEnd()).filter(l => l.trim());
  if (lines.length === 0) return EMPTY_TABLE;
  const header = lines[0];
  const ppidFirst = header.indexOf('ParentProcessId') < header.indexOf('ProcessId');
  const rows: string[] = [];
  for (const line of lines.slice(1)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    rows.push(ppidFirst ? `${m[2]} ${m[1]}` : `${m[1]} ${m[2]}`);
  }
  return parsePidPpidLines(rows.join('\n'));
}

function tableFromRawOutput(out: string, kind: 'ps' | 'wmic'): ProcessTable {
  return kind === 'wmic' ? parseWmicTable(out) : parsePidPpidLines(out);
}

/** 同步取全表 —— 只给还没法改成 async 的调用方 (register / killProcessGroup) 用。 */
function loadProcessTableSync(): ProcessTable {
  const opts = {
    encoding: 'utf8' as const,
    stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
    timeout: 4000,
  };
  try {
    let table: ProcessTable;
    if (process.platform === 'win32') {
      try {
        table = tableFromRawOutput(execSync(`wmic ${WMIC_ARGS.join(' ')}`, opts), 'wmic');
        if (table.parentOf.size === 0) throw new Error('wmic empty');
      } catch {
        table = tableFromRawOutput(
          execSync(`powershell ${PWSH_ARGS.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ')}`, opts), 'ps');
      }
    } else {
      table = tableFromRawOutput(execSync(`ps ${PS_ARGS.join(' ')}`, opts), 'ps');
    }
    return table;
  } catch {
    return EMPTY_TABLE;
  }
}

/** 异步读取进程表，避免在异步调用方阻塞事件循环。 */
export async function loadProcessTree(): Promise<ProcessTree> {
  const table = await loadProcessTable();
  return {
    descendantsOf: (pid: number) =>
      (Number.isFinite(pid) && pid > 0) ? descendantsFromTable(table, pid) : [],
  };
}

async function loadProcessTable(): Promise<ProcessTable> {
  if (tableInflight) return tableInflight;   /* 同一瞬间多个调用方共享一次 fork */
  tableInflight = (async (): Promise<ProcessTable> => {
    const opts = { encoding: 'utf8' as const, timeout: 4000, windowsHide: true };
    try {
      let table: ProcessTable;
      if (process.platform === 'win32') {
        try {
          const { stdout } = await execFileAsync('wmic', WMIC_ARGS, opts);
          table = tableFromRawOutput(String(stdout), 'wmic');
          if (table.parentOf.size === 0) throw new Error('wmic empty');
        } catch {
          const { stdout } = await execFileAsync('powershell', PWSH_ARGS, opts);
          table = tableFromRawOutput(String(stdout), 'ps');
        }
      } else {
        const { stdout } = await execFileAsync('ps', PS_ARGS, opts);
        table = tableFromRawOutput(String(stdout), 'ps');
      }
      return table;
    } catch {
      return EMPTY_TABLE;
    } finally {
      tableInflight = null;
    }
  })();
  return tableInflight;
}

/**
 * 一次取好的进程树快照 —— 给「遍历 N 个目标」的扫描用 (killAllTracked)。
 * 扫描要的正是快照语义: 整轮基于同一时刻的进程关系, 而不是每个目标各看各的。
 */
export interface ProcessTree {
  descendantsOf(pid: number): number[];
}

/** 测试用: 清掉进程信息缓存。 */
export function __resetProcessTableCache(): void {
  tableInflight = null;
  infoCache = null;
}

/** 从一张已建好的表上 BFS 拿子孙 (纯内存, 零 fork) */
function descendantsFromTable(table: ProcessTable, rootPid: number): number[] {
  const result: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    const kids = table.childrenOf.get(pid);
    if (!kids) continue;
    for (const n of kids) {
      if (seen.has(n)) continue;  /* 防 cycle (理论不存在但稳一手) */
      seen.add(n);
      result.push(n);
      queue.push(n);
    }
  }
  return result;
}

/** 给定 root pid, 递归拿所有后代 (不含 root 自身, 按 BFS 顺序). */
export function getDescendantPids(rootPid: number): number[] {
  if (!Number.isFinite(rootPid) || rootPid <= 0) return [];
  try {
    return descendantsFromTable(loadProcessTableSync(), rootPid);
  } catch {
    return [];
  }
}

/** async 版 —— 已经在 async 上下文里的调用方用这个, 不阻塞事件循环。 */
export async function getDescendantPidsAsync(rootPid: number): Promise<number[]> {
  if (!Number.isFinite(rootPid) || rootPid <= 0) return [];
  try {
    return descendantsFromTable(await loadProcessTable(), rootPid);
  } catch {
    return [];
  }
}

/** 给定 pid, 向上找它的祖先链 (不含自身, 按由近到远顺序, 到 init/launchd 停).
 *
 *   ProcessManager 用它识别已跟踪进程的后代，避免父进程和子进程被重复登记。
 *   `maxDepth` 防止异常父链造成无限循环。
 */
export function getAncestorPids(pid: number, maxDepth = 20): number[] {
  if (!Number.isFinite(pid) || pid <= 0) return [];
  try {
    return ancestorsFromTable(loadProcessTableSync(), pid, maxDepth);
  } catch {
    return [];
  }
}

/** async 版 —— 同 getDescendantPidsAsync 的理由。 */
export async function getAncestorPidsAsync(pid: number, maxDepth = 20): Promise<number[]> {
  if (!Number.isFinite(pid) || pid <= 0) return [];
  try {
    return ancestorsFromTable(await loadProcessTable(), pid, maxDepth);
  } catch {
    return [];
  }
}

/** 从表上顺 ppid 往上走 (纯内存)。到 init/launchd (ppid<=1) 或断链为止。 */
function ancestorsFromTable(table: ProcessTable, rootPid: number, maxDepth: number): number[] {
  const result: number[] = [];
  const seen = new Set<number>([rootPid]);
  let cur = table.parentOf.get(rootPid);
  while (cur !== undefined && cur > 1 && result.length < maxDepth) {
    if (seen.has(cur)) break; /* 防 cycle */
    seen.add(cur);
    result.push(cur);
    cur = table.parentOf.get(cur);
  }
  return result;
}

/**
 * 取一个 pid 的真实启动时间，用于识别 pid 复用。只有 pid 和启动时间都匹配时才认定为
 * 同一进程；无法取得启动时间时返回 `undefined`，调用方应采取保守策略。
 *
 * 实现: `ps -o lstart=` 给的是本地时间字符串 (e.g. "Thu Jul 31 01:05:42 2026"),
 * Date.parse 能吃; 精度到秒, 所以调用方比对要留容差。
 */
export function getProcessStartTimeMs(pid: number): number | undefined {
  return getProcessInfoBatch([pid]).get(pid)?.startTimeMs;
}

export interface LiveProcessInfo {
  startTimeMs?: number;
  /** SIGTSTP 挂起中 (ps STAT 含 'T')。用户点了"暂停"按钮的那个状态。 */
  stopped: boolean;
}

/**
 * 一次 `ps` 拿一批 pid 的启动时间 + 运行状态。
 *
 * 为什么是批量: snapshot tick 每 2s 要给每个在跑的进程做 pid 复用校验, 逐个 fork ps
 * 就是 N 次进程创建 (每次 5-10ms)。批量之后无论多少个服务都只有一次, tick 的成本
 * 跟进程数脱钩。
 *
 * 顺带把 STAT 一起取了 —— 暂停态 (SIGTSTP) 靠它识别, 不需要在 UI 侧再维护一个
 * "我点过暂停" 的状态位。又少一份要对账的状态。
 */
/* ── 进程信息的短 TTL 缓存 ──────────────────────────────────────────────────
 *
 * buildSnapshot 是**每个订阅者**都调一次的 (每个工程窗口一个订阅者), 而它每次都要一份
 * 在跑进程的 STAT。不缓存的话, 2s 的 tick × N 个窗口 = 每 2 秒 N 次同步 fork。
 *
 * TTL 只有 1s: 这份数据用来判活和判暂停, 陈旧一点点无害 (快照本来就是"最多晚 2 秒"),
 * 但绝不能久缓存 —— 它同时是 pid 复用校验的依据, 拿旧启动时间去比对会放过一个已经
 * 被复用的 pid。请求里只要有一个 pid 不在缓存里就重取, 保证新进程立刻可见。
 */
const INFO_TTL_MS = 1_000;
let infoCache: { at: number; map: Map<number, LiveProcessInfo> } | null = null;

function infoFromCache(pids: number[]): Map<number, LiveProcessInfo> | null {
  if (!infoCache || Date.now() - infoCache.at > INFO_TTL_MS) return null;
  for (const p of pids) if (!infoCache.map.has(p)) return null;
  return infoCache.map;
}

function rememberInfo(map: Map<number, LiveProcessInfo>): Map<number, LiveProcessInfo> {
  infoCache = { at: Date.now(), map };
  return map;
}

export function getProcessInfoBatch(pids: number[]): Map<number, LiveProcessInfo> {
  const valid = pids.filter(p => Number.isFinite(p) && p > 0);
  if (valid.length === 0) return new Map();
  const cached = infoFromCache(valid);
  if (cached) return cached;
  try {
    if (process.platform === 'win32') {
      const out = execSync(`wmic process get ProcessId,CreationDate`, {
        encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      return rememberInfo(parseWindowsProcessInfo(out, valid));
    }
    const out = execSync(`ps -o pid=,stat=,lstart= -p ${valid.join(',')}`, {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return rememberInfo(parseUnixProcessInfo(out));
  } catch {
    /* ps / wmic 不可用 / 全部 pid 都已消失 —— 返回空表, 调用方按"拿不到信息"保守处理 */
    return new Map();
  }
}

/** async 版 —— 2s 的快照 tick 用它, 别每轮都同步 fork 一次 ps 卡住 runtime。 */
export async function getProcessInfoBatchAsync(pids: number[]): Promise<Map<number, LiveProcessInfo>> {
  const valid = pids.filter(p => Number.isFinite(p) && p > 0);
  if (valid.length === 0) return new Map();
  const cached = infoFromCache(valid);
  if (cached) return cached;
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('wmic', ['process', 'get', 'ProcessId,CreationDate'],
        { encoding: 'utf8', timeout: 4000, windowsHide: true });
      return rememberInfo(parseWindowsProcessInfo(String(stdout), valid));
    }
    const { stdout } = await execFileAsync('ps', ['-o', 'pid=,stat=,lstart=', '-p', valid.join(',')],
      { encoding: 'utf8', timeout: 2000 });
    return rememberInfo(parseUnixProcessInfo(String(stdout)));
  } catch {
    return new Map();
  }
}

function parseUnixProcessInfo(out: string): Map<number, LiveProcessInfo> {
  const result = new Map<number, LiveProcessInfo>();
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    /* "12345 S+   Thu Jul 31 01:05:42 2026" —— pid, STAT, 然后整段 lstart */
    const m = t.match(/^(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const ms = Date.parse(m[3]);
    result.set(pid, {
      startTimeMs: Number.isFinite(ms) ? ms : undefined,
      stopped: m[2].includes('T'),
    });
  }
  return result;
}

/**
 * Windows: 从 `wmic process get ProcessId,CreationDate` 解析启动时间。
 *
 *  补: 这里以前直接 `return result` (空表) —— 也就是 **Windows 上完全没有
 * pid 复用防线**。而 stillAlive / boot 收尸 都是"拿不到启动时间就保守当活着", 于是一个
 * 早就死掉、pid 被系统分配给别人的记录会一直判活; 更糟的是清场路径按 pid 发 SIGKILL,
 * 打的可能是用户的无关进程。Windows 的 pid 回绕比 macOS 更快, 这个洞不能留。
 *
 * CreationDate 形如 `20260805013045.123456+480` (末尾是相对 UTC 的分钟偏移)。
 */
function parseWindowsProcessInfo(out: string, wanted: number[]): Map<number, LiveProcessInfo> {
  const result = new Map<number, LiveProcessInfo>();
  const want = new Set(wanted);
  const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return result;
  const dateFirst = lines[0].indexOf('CreationDate') < lines[0].indexOf('ProcessId');
  for (const line of lines.slice(1)) {
    const m = line.match(/^(\S+)\s+(\S+)$/);
    if (!m) continue;
    const rawDate = dateFirst ? m[1] : m[2];
    const rawPid = dateFirst ? m[2] : m[1];
    const pid = parseInt(rawPid, 10);
    if (!Number.isFinite(pid) || !want.has(pid)) continue;
    result.set(pid, { startTimeMs: parseWmicDate(rawDate), stopped: false });
  }
  return result;
}

/** `20260805013045.123456+480` → epoch ms。解析不了返回 undefined (调用方按保守处理)。 */
function parseWmicDate(raw: string): number | undefined {
  const m = raw?.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{1,6})([+-]\d{1,4})$/);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, frac, tz] = m;
  const ms = Math.floor(parseInt(frac.padEnd(6, '0'), 10) / 1000);
  const offsetMin = parseInt(tz, 10);          /* wmic 给的是分钟偏移, 不是 ±HHMM */
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, ms) - offsetMin * 60_000;
  return Number.isFinite(utc) ? utc : undefined;
}

/** process.kill(pid, 0) 不发信号只测进程是否存在. 死了抛 ESRCH; EPERM 算活 (跨 user 看不到). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code !== 'ESRCH';
  }
}
