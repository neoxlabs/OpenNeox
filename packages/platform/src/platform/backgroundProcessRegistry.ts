/*
 * backgroundProcessRegistry — 后台命令的**跨进程登记**, 落在 `~/.neox/run/bg-procs/`。
 *
 * ── 为什么不是 sqlite ────────────────────────────────────────────────────────
 * ProcessManager 已经把进程状态写进了 service_instances, 但那张表**不知道是谁起的进程**:
 * 没有 owner pid, 就无法区分「上一次 Neox 崩溃留下的孤儿」和「另一个还活着的 Neox 实例
 * 正在跑的服务」。后者一旦被误杀, 用户损失的是正在跑的应用。
 *
 * 这份登记补的正是这一格: 每条记录带着 **owner 进程的 pid + 启动时间**。判断孤儿时
 * 先问 owner 还在不在, 在就一个都不碰。
 *
 * 为什么用目录里一个进程一个文件, 而不是单文件:
 *   CLI / 桌面 / daemon 可能同时在写。单文件要 read-modify-write, 并发写必然丢记录;
 *   一个进程一个文件, 各写各的, 不需要锁。文件名 `pid-startTime.json` 本身就是主键。
 *
 * 权限: 0600 + 目录 0700 —— 命令行里可能有 token / 连接串, 跟进程日志同一条线。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { neoxHome } from '@neoxlabs/kernel/platform/neoxHome.js';

/** 一条后台进程登记。字段足够回答两个问题: 是不是同一条进程? 是谁起的? */
export interface BackgroundProcessEntry {
  /** 进程 pid */
  pid: number;
  /** 进程真实启动时间 (epoch ms) —— pid 复用防线, 跟 OS 上的启动时间比对 */
  startTime: number;
  /** 启动命令 (原样记下, 收尸前要跟 live 命令行比对) */
  command: string;
  /** spawn 时的工作目录 */
  cwd: string;
  /** 归属工程根 (同 TrackedProcess.workspaceRoot) */
  workspaceRoot: string;
  /** 起这个进程的 Neox 进程 pid */
  ownerPid: number;
  /** owner 进程的启动时间 (epoch ms) —— 防 owner pid 被复用后误判「还活着」 */
  ownerStartTime: number;
  /** 所属会话 id (拿不到时不写) */
  sessionId?: string;
  /** 登记时刻 */
  createdAt: number;
}

export interface RegistryOptions {
  /** 覆盖 run 目录 (测试用)。默认 `~/.neox/run`。 */
  runDir?: string;
}

const ENTRY_RE = /^(\d+)-(\d+)\.json$/;

/** `~/.neox/run/bg-procs` (或 opts.runDir/bg-procs)。 */
export function backgroundRegistryDir(opts?: RegistryOptions): string {
  return path.join(opts?.runDir ?? neoxHome('run'), 'bg-procs');
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function entryPath(pid: number, startTime: number, opts?: RegistryOptions): string {
  return path.join(backgroundRegistryDir(opts), `${pid}-${startTime}.json`);
}

function isValidEntry(value: any): value is BackgroundProcessEntry {
  return !!value
    && Number.isFinite(value.pid) && value.pid > 0
    && Number.isFinite(value.startTime) && value.startTime > 0
    && typeof value.command === 'string'
    && Number.isFinite(value.ownerPid) && value.ownerPid > 0
    && Number.isFinite(value.ownerStartTime) && value.ownerStartTime > 0;
}

/**
 * 写入一条登记。覆盖写 (同一 pid+startTime 重复注册是幂等的)。
 * 先写临时文件再 rename —— 收尸进程可能正好在读, 不能让它看到半截 JSON。
 * 任何 IO 失败都只返回 false, 绝不影响命令本身。
 */
export function registerBackgroundProcess(entry: BackgroundProcessEntry, opts?: RegistryOptions): boolean {
  if (!isValidEntry(entry)) return false;
  const dir = backgroundRegistryDir(opts);
  const file = entryPath(entry.pid, entry.startTime, opts);
  try {
    ensureDir(dir);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(`${file}.${process.pid}.tmp`); } catch { /* ignore */ }
    return false;
  }
}

/** 删除一条登记 (进程正常退出 / 收尸之后)。不存在不算错。 */
export function removeBackgroundProcessEntry(pid: number, startTime: number, opts?: RegistryOptions): void {
  if (!Number.isFinite(pid) || !Number.isFinite(startTime)) return;
  try { fs.unlinkSync(entryPath(pid, startTime, opts)); } catch { /* ENOENT / 无权限: 下次启动会再清 */ }
}

/** 读出全部登记 (跳过不合法 / 半截文件, 不因一条坏记录漏掉其它)。 */
export function listBackgroundProcessEntries(opts?: RegistryOptions): BackgroundProcessEntry[] {
  const dir = backgroundRegistryDir(opts);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: BackgroundProcessEntry[] = [];
  for (const name of names) {
    const m = name.match(ENTRY_RE);
    if (!m) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (isValidEntry(parsed)) out.push(parsed);
    } catch { /* 坏文件: 跳过, 下次启动的清单里也不会再出现 */ }
  }
  return out;
}

/** 按 (pid, startTime) 找一条登记 —— server boot 收尸要拿 owner 信息时用。 */
export function findBackgroundProcessEntry(
  pid: number,
  startTime: number,
  opts?: RegistryOptions,
): BackgroundProcessEntry | undefined {
  return listBackgroundProcessEntries(opts).find(e => e.pid === pid && e.startTime === startTime);
}
