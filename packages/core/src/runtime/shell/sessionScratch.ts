/**
 * 会话级私有临时目录 —— 每会话一个独立的私有临时目录。
 *
 * 动机: Neox 原本所有会话共享 `os.tmpdir()`, 临时文件散在系统公共 tmp (per-调用随机后缀,
 * 不 scoped 到会话)。改成**每会话一个独立目录**:
 *   - 隔离: 会话 A 的临时文件不落进会话 B 能看到的地方。
 *   - 沙盒: 作为 sandbox 的可写 tmp writeRoot, 命令的 TMPDIR 指向它。
 *   - 自清理: 会话结束整块删。
 *
 * 单活跃会话模型 (与既有 process.env.NEOX_WORKDIR 一致): 当前会话的 scratch 路径挂在
 * process.env.NEOX_SESSION_TMP, 会话切换时 host.syncWorkspaceEnv 更新。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** 所有会话 scratch 的根 (Neox 拥有, 可整批清)。 */
function scratchBase(): string {
  return path.join(os.tmpdir(), 'neox-sessions');
}

/** sessionId → 目录路径 (仅本进程活跃会话记账, 用于清理)。 */
const known = new Map<string, string>();

/** 把 sessionId 规整成安全的目录名。 */
function safeSeg(sessionId: string): string {
  const s = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return s || 'default';
}

/** 确保会话 scratch 目录存在, 返回绝对路径 (幂等)。 */
export function ensureSessionScratch(sessionId: string): string {
  const dir = path.join(scratchBase(), safeSeg(sessionId));
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    /* 已存在/竞争, 忽略 */
  }
  known.set(sessionId, dir);
  return dir;
}

/** 当前活跃会话的 scratch (供 sandbox / shell env 读)。未设置回落系统 tmp。 */
export function getActiveSessionScratch(): string {
  const v = process.env.NEOX_SESSION_TMP;
  return v && v.length > 0 ? v : os.tmpdir();
}

/** 把某会话设为活跃 (建目录 + 挂 env), 供 host 在会话启动/切换时调。 */
export function activateSessionScratch(sessionId: string): string {
  const dir = ensureSessionScratch(sessionId);
  process.env.NEOX_SESSION_TMP = dir;
  return dir;
}

/** 会话结束清理 (整块删 + 摘 env)。 */
export function cleanupSessionScratch(sessionId: string): void {
  const dir = known.get(sessionId);
  if (dir) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
    known.delete(sessionId);
  }
  if (dir && process.env.NEOX_SESSION_TMP === dir) {
    delete process.env.NEOX_SESSION_TMP;
  }
}
