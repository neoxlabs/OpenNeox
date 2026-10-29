
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import {
  getAncestorPids,
  getProcessCommandLinesAsync,
  getProcessInfoBatchAsync,
  isPidAlive,
  loadProcessTree,
} from './processTree.js';
import {
  listBackgroundProcessEntries,
  removeBackgroundProcessEntry,
  type BackgroundProcessEntry,
  type RegistryOptions,
} from './backgroundProcessRegistry.js';

/** 本进程的身份 —— 收尸时绝不碰自己, 也不碰自己的祖先 (registry 被写坏时的保险)。 */
const SELF_PID = process.pid;

/* 自己的祖先表只取一次: 运行中的进程不可能再长出新祖先 (父死了只会被 reparent 到 1),
 * 而一次扫描里有几十条登记时, 每条都 fork 一次 ps 就纯属浪费。 */
let cachedSelfAncestors: number[] | null = null;
function selfAncestors(): number[] {
  if (cachedSelfAncestors === null) {
    try { cachedSelfAncestors = getAncestorPids(SELF_PID); } catch { cachedSelfAncestors = []; }
  }
  return cachedSelfAncestors;
}

/** 一条登记在 OS 侧对不上时的判定。 */
export type RecordedProcessVerdict =
  /** 三样全对上, 且 owner 已不在 → 可以清 */
  | 'reap'
  /** 三样全对上, 但 owner 还活着 → 别人正在用, 不碰 */
  | 'owner-alive'
  /** pid 不在了 */
  | 'dead'
  /** pid 被系统复用给了别的进程 */
  | 'pid-reused'
  /** pid+启动时间对得上, 但命令行对不上 — 不是我们记的那条 */
  | 'command-mismatch'
  /** 信息拿不全 / 是我们自己或祖先 → 保守放过 */
  | 'unverifiable';

export interface RecordedProcessIdentity {
  pid: number;
  startTime: number;
  command: string;
  ownerPid?: number;
  ownerStartTime?: number;
}

/** 命令行比较: 折叠空白 + 去掉结尾 `&`, 允许一侧是另一侧的前缀形态 (shell 包装)。 */
function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ').replace(/\s*&\s*$/, '');
}

function commandMatches(recorded: string, live: string): boolean {
  const a = normalizeCommand(recorded);
  const b = normalizeCommand(live);
  if (!a || !b) return false;
  return a === b || b.includes(a) || a.includes(b);
}

/**
 * 判断一条登记现在是什么状态。
 *
 * 这是收尸的唯一判据 —— CLI 启动清扫和 server boot 收尸都走这里, 避免两处规则漂移。
 */
export async function classifyRecordedProcess(rec: RecordedProcessIdentity): Promise<RecordedProcessVerdict> {
  const { pid } = rec;
  if (!Number.isFinite(pid) || pid <= 1) return 'unverifiable';
  /* 绝不对自己 / 自己的祖先动手 —— 正常登记不会有, 但一份被写坏的文件不该能杀掉 runtime。 */
  if (pid === SELF_PID) return 'unverifiable';
  if (selfAncestors().includes(pid)) return 'unverifiable';

  if (!isPidAlive(pid)) return 'dead';

  /* 1) pid 复用防线 */
  const liveInfo = await getProcessInfoBatchAsync([pid]);
  const actualStart = liveInfo.get(pid)?.startTimeMs;
  if (actualStart === undefined) return 'unverifiable';
  if (Math.abs(actualStart - rec.startTime) > 2_000) return 'pid-reused';

  /* 2) 命令行防线 —— pid + 启动时间都对上了, 再加一道「确实是那条命令」 */
  const commands = await getProcessCommandLinesAsync([pid]);
  const liveCommand = commands.get(pid);
  if (!liveCommand) return 'unverifiable';
  if (!commandMatches(rec.command, liveCommand)) return 'command-mismatch';

  /* 3) owner 判活 —— 还活着说明是另一个 Neox 实例的进程, 不是孤儿 */
  if (rec.ownerPid && rec.ownerPid > 0 && isPidAlive(rec.ownerPid)) {
    if (rec.ownerStartTime === undefined) return 'owner-alive';
    const ownerStart = (await getProcessInfoBatchAsync([rec.ownerPid])).get(rec.ownerPid)?.startTimeMs;
    if (ownerStart === undefined) return 'owner-alive';
    if (Math.abs(ownerStart - rec.ownerStartTime) <= 2_000) return 'owner-alive';
  }

  return 'reap';
}

export interface OrphanProcessInfo {
  pid: number;
  command: string;
  startTime: number;
  sessionId?: string;
  ownerPid: number;
}

export interface OrphanReapResult {
  /** 认出来的孤儿 (keep=true 时也存在, 只是没杀) */
  orphans: OrphanProcessInfo[];
  /** 发了信号并删掉登记的孤儿数 */
  reaped: number;
  /** 已死 / pid 被复用 / 命令行对不上, 直接删掉的登记数 */
  removed: number;
  /** 活着但属于另一个 Neox, 或信息拿不全 → 放过 */
  skipped: number;
}

export interface ReapOptions extends RegistryOptions {
  /** 只列不杀 (--keep-orphans) */
  keep?: boolean;
  /** SIGTERM → SIGKILL 的宽限期, 默认 1.5s */
  graceMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms).unref?.(); });
}

/**
 * 读 `~/.neox/run/bg-procs/`, 清掉死登记, 结束孤儿进程。
 *
 * 不杀: owner 还活着的、信息对不上的、自己/祖先。
 */
export async function reapOrphanBackgroundProcesses(opts?: ReapOptions): Promise<OrphanReapResult> {
  const entries = listBackgroundProcessEntries(opts);
  const result: OrphanReapResult = { orphans: [], reaped: 0, removed: 0, skipped: 0 };
  const orphanEntries: BackgroundProcessEntry[] = [];

  for (const entry of entries) {
    let verdict: RecordedProcessVerdict;
    try {
      verdict = await classifyRecordedProcess(entry);
    } catch (err: any) {
      cliLogger.warn('ORPHAN_REAPER', `classify pid=${entry.pid} failed: ${err?.message ?? err}`);
      result.skipped++;
      continue;
    }

    if (verdict === 'dead' || verdict === 'pid-reused' || verdict === 'command-mismatch') {
      removeBackgroundProcessEntry(entry.pid, entry.startTime, opts);
      result.removed++;
      continue;
    }
    if (verdict !== 'reap') {
      result.skipped++;
      continue;
    }

    orphanEntries.push(entry);
    result.orphans.push({
      pid: entry.pid,
      command: entry.command,
      startTime: entry.startTime,
      sessionId: entry.sessionId,
      ownerPid: entry.ownerPid,
    });
  }

  if (opts?.keep || orphanEntries.length === 0) {
    if (orphanEntries.length > 0) {
      cliLogger.info('ORPHAN_REAPER', `keeping ${orphanEntries.length} orphan process(es) (--keep-orphans)`);
    }
    return result;
  }

  /* 先枚举整棵树再发信号 —— 父先死会让子进程被 reparent, 之后枚举就找不到它们了。 */
  const tree = await loadProcessTree();
  const signalPids: number[] = [];
  const seen = new Set<number>();
  for (const entry of orphanEntries) {
    const pids = [entry.pid, ...tree.descendantsOf(entry.pid)].reverse();
    for (const p of pids) {
      if (seen.has(p)) continue;
      seen.add(p);
      signalPids.push(p);
    }
  }

  for (const p of signalPids) {
    try { process.kill(p, 'SIGTERM'); } catch { /* 已死 / 无权限 */ }
  }
  await sleep(opts?.graceMs ?? 1_500);

  let hardKilled = 0;
  for (const p of signalPids) {
    if (!isPidAlive(p)) continue;
    try { process.kill(p, 'SIGKILL'); hardKilled++; } catch { /* 已死 */ }
  }

  for (const entry of orphanEntries) {
    removeBackgroundProcessEntry(entry.pid, entry.startTime, opts);
  }
  result.reaped = orphanEntries.length;

  cliLogger.info('ORPHAN_REAPER',
    `reaped ${result.reaped} orphan process(es)` +
    `${hardKilled > 0 ? ` (${hardKilled} pid survived grace, SIGKILL)` : ''}` +
    `, removed=${result.removed} skipped=${result.skipped}`);
  return result;
}
