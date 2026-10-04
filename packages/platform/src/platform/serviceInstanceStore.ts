/**
 * serviceInstanceStore — ProcessManager 状态的 sqlite 持久化层.
 *
 * 用途:
 *   Neox server (detached daemon) 重启后, OS 上的实际进程 (PTY 子进程) 因为 detached+unref
 *   仍在跑, 但 ProcessManager 内存丢了. 这一层把每个 TrackedProcess 状态变更 upsert 到
 *   service_instances 表, server boot 时 reconcileFromDb 读出来 + 用 process.kill(pid, 0)
 *   探活, 活的接管, 死的标记 killed 留作历史.
 *
 * 写入策略:
 *   - 同步 upsert (better-sqlite3 是 sync, 单条 < 1ms, 不阻塞事件循环热路径)
 *   - 失败 silently warn (dev 环境 db 未初始化等)
 *
 * 模块解耦:
 *   ProcessManager 不直接 import sqlite — 通过 getDatabase().getRawDb() 拿原始 db,
 *   单测 / CI / 工具脚本里 ProcessManager 跑得起来, 只是不持久化 (db init 失败时 silent).
 */

import { getDatabase } from './database.js';
import type { TrackedProcess } from './processManager.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import type { TrackedProcessKind } from './processManager.js';

export interface PersistedServiceInstance {
  pid: number;
  startTime: number;
  workspaceRoot: string;
  command: string;
  cwd: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
  exitCode?: number;
  endTime?: number;
  port?: number;
  displayName?: string;
  configId?: string;
  kind?: TrackedProcessKind;
  background: boolean;
  /** 'adopted' = 用户自己起的进程, 只是被纳管; boot 收尸绝不碰它. 见 TrackedProcess.origin. */
  origin: 'spawned' | 'adopted';
  logFilePath?: string;
  userKilled: boolean;
  restartCount: number;
  healthy?: boolean;
  healthCheckedAt?: number;
}

let dbAvailable = true;

function getRawDb() {
  if (!dbAvailable) return null;
  try {
    return getDatabase().getRawDb();
  } catch (err: any) {
    if (dbAvailable) {
      cliLogger.warn('SVC_PERSIST', `db unavailable, persistence disabled: ${err?.message}`);
      dbAvailable = false;
    }
    return null;
  }
}

/** 同步 upsert. ProcessManager mutator 末尾调, < 1ms. */
export function upsertInstance(proc: TrackedProcess, workspaceRoot: string): void {
  const db = getRawDb();
  if (!db) return;
  try {
    db.prepare(`
      INSERT INTO service_instances (
        pid, start_time, workspace_root, command, cwd, status, exit_code, end_time,
        port, display_name, config_id, kind, background, log_file_path,
        user_killed, restart_count, healthy, health_checked_at, origin, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pid, start_time) DO UPDATE SET
        status = excluded.status,
        exit_code = excluded.exit_code,
        end_time = excluded.end_time,
        port = excluded.port,
        display_name = excluded.display_name,
        config_id = excluded.config_id,
        kind = excluded.kind,
        log_file_path = excluded.log_file_path,
        user_killed = excluded.user_killed,
        restart_count = excluded.restart_count,
        healthy = excluded.healthy,
        health_checked_at = excluded.health_checked_at,
        origin = excluded.origin,
        updated_at = excluded.updated_at
    `).run(
      proc.pid,
      proc.startTime.getTime(),
      workspaceRoot,
      proc.command,
      proc.cwd,
      proc.status,
      proc.exitCode ?? null,
      proc.endTime?.getTime() ?? null,
      proc.port ?? null,
      proc.name ?? null,
      proc.configId ?? null,
      proc.kind ?? 'background-task',
      proc.background ? 1 : 0,
      proc.logFilePath ?? null,
      proc.userKilled ? 1 : 0,
      proc.restartCount ?? 0,
      typeof proc.healthy === 'boolean' ? (proc.healthy ? 1 : 0) : null,
      proc.healthCheckedAt ?? null,
      proc.origin ?? 'spawned',
      Date.now(),
    );
  } catch (err: any) {
    cliLogger.warn('SVC_PERSIST', `upsert pid=${proc.pid} failed: ${err?.message}`);
  }
}

export function listRunningInstances(): PersistedServiceInstance[] {
  const db = getRawDb();
  if (!db) return [];
  try {
    const rows = db.prepare(
      `SELECT * FROM service_instances WHERE status = 'running' ORDER BY start_time ASC`,
    ).all() as Array<Record<string, any>>;
    return rows.map(rowToInstance);
  } catch (err: any) {
    cliLogger.warn('SVC_PERSIST', `listRunningInstances failed: ${err?.message}`);
    return [];
  }
}

/** 拉某 workspace 历史 (任意状态). 给 "this workspace 的历史服务" UI 用. */
export function listInstancesByWorkspace(workspaceRoot: string): PersistedServiceInstance[] {
  const db = getRawDb();
  if (!db) return [];
  try {
    const rows = db.prepare(
      `SELECT * FROM service_instances WHERE workspace_root = ? ORDER BY start_time DESC`,
    ).all(workspaceRoot) as Array<Record<string, any>>;
    return rows.map(rowToInstance);
  } catch (err: any) {
    cliLogger.warn('SVC_PERSIST', `listInstancesByWorkspace failed: ${err?.message}`);
    return [];
  }
}

/** 直接标记一条记录为已退出 (server reconcile 探活后, 死掉的 pid 走这里). */
export function markInstanceExited(
  pid: number,
  startTime: number,
  reason: 'killed' | 'completed' | 'failed' = 'killed',
): void {
  const db = getRawDb();
  if (!db) return;
  try {
    db.prepare(
      `UPDATE service_instances SET status = ?, end_time = ?, updated_at = ? WHERE pid = ? AND start_time = ?`,
    ).run(reason, Date.now(), Date.now(), pid, startTime);
  } catch (err: any) {
    cliLogger.warn('SVC_PERSIST', `markInstanceExited pid=${pid} failed: ${err?.message}`);
  }
}

/** GC: 已退出 + end_time 超过 retentionMs (默认 24h) 的删. server boot 时跑一次. */
export function gcInstances(retentionMs: number = 24 * 60 * 60 * 1000): number {
  const db = getRawDb();
  if (!db) return 0;
  try {
    const cutoff = Date.now() - retentionMs;
    const r = db.prepare(
      `DELETE FROM service_instances WHERE status != 'running' AND end_time IS NOT NULL AND end_time < ?`,
    ).run(cutoff);
    return r.changes ?? 0;
  } catch (err: any) {
    cliLogger.warn('SVC_PERSIST', `gcInstances failed: ${err?.message}`);
    return 0;
  }
}

function rowToInstance(row: Record<string, any>): PersistedServiceInstance {
  return {
    pid: row.pid,
    startTime: row.start_time,
    workspaceRoot: row.workspace_root,
    origin: row.origin === 'adopted' ? 'adopted' : 'spawned',
    command: row.command,
    cwd: row.cwd,
    status: row.status,
    exitCode: row.exit_code ?? undefined,
    endTime: row.end_time ?? undefined,
    port: row.port ?? undefined,
    displayName: row.display_name ?? undefined,
    configId: row.config_id ?? undefined,
    kind: row.kind ?? undefined,
    background: !!row.background,
    logFilePath: row.log_file_path ?? undefined,
    userKilled: !!row.user_killed,
    restartCount: row.restart_count ?? 0,
    healthy: row.healthy == null ? undefined : !!row.healthy,
    healthCheckedAt: row.health_checked_at ?? undefined,
  };
}
