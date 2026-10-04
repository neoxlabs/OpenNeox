/**
 * plaintextBackupCleaner — 自动清理 P4 加密迁移留下的 .plaintext-backup.<ts> 文件 (SEC-1).
 *
 * 背景: P4 把明文 db 重写成加密版时, 会先把原文件改名 .plaintext-backup.<ts> 留作回滚兜底.
 *      这个文件是【纯明文】含 sessions/messages 全量数据, 如果用户没意识到要删,
 *      攻击者拿到磁盘镜像就能直接读光. 必须主动清理.
 *
 * 策略 (保守):
 *   - 文件存在 < 24h: 保留 (用户刚迁完, 留窗口验证主 db 没坏)
 *   - 文件存在 ≥ 24h: secure-delete (随机字节覆写 3 次 + unlink)
 *
 * Secure delete 算法 (best-effort, 不是 NIST 800-88, 但比纯 unlink 强):
 *   1. 同长度随机字节覆写
 *   2. fsync 强制落盘 (防 OS 缓存把 unlink 当成"释放页"略过物理写)
 *   3. unlink
 *
 *   SSD 有 wear leveling + over-provisioning, 同地址覆写不一定真覆盖原物理块.
 *   真正抹掉机密的标准做法是 ATA Secure Erase / SED 整盘擦, 不在应用层.
 *   这里做的是"挡住用 file undelete 类工具捞出来"的攻击.
 *
 * 调用方: Electron main app.whenReady 早期触发 (audit log init 之后, 用户感知不到).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

/* 保留窗口 (毫秒) — 24h. 调试可 env override. */
const RETENTION_MS = Number(process.env.NEOX_PLAINTEXT_BACKUP_RETENTION_MS) || 24 * 3600 * 1000;
const OVERWRITE_PASSES = 3;

function getConfigDir(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Neox');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Neox');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'neox');
}

function secureDelete(filePath: string): { ok: boolean; reason?: string } {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return { ok: false, reason: 'not a regular file' };
    const fd = fs.openSync(filePath, 'r+');
    try {
      const size = st.size;
      const chunkSize = 64 * 1024;
      const buf = Buffer.alloc(chunkSize);
      for (let pass = 0; pass < OVERWRITE_PASSES; pass++) {
        for (let off = 0; off < size; off += chunkSize) {
          const w = Math.min(chunkSize, size - off);
          crypto.randomFillSync(buf, 0, w);
          fs.writeSync(fd, buf, 0, w, off);
        }
        fs.fsyncSync(fd);
      }
    } finally {
      fs.closeSync(fd);
    }
    fs.unlinkSync(filePath);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, reason: err?.message ?? String(err) };
  }
}

/**
 * 扫 Neox config dir, 找所有 *.plaintext-backup.* 文件,
 * 凡是 24h 前的就 secure-delete.
 *
 * 返回处理结果数组, 喂给 audit log 用.
 */
export function cleanupPlaintextBackups(): Array<{ file: string; ageMs: number; action: 'kept' | 'deleted' | 'failed'; reason?: string }> {
  const dir = getConfigDir();
  const results: Array<{ file: string; ageMs: number; action: 'kept' | 'deleted' | 'failed'; reason?: string }> = [];
  if (!fs.existsSync(dir)) return results;
  const now = Date.now();
  let entries: string[] = [];
  try { entries = fs.readdirSync(dir); } catch { return results; }
  for (const name of entries) {
    /* 匹配 P4 迁移留下的格式: 任意.db.plaintext-backup.<digits> 或 (子用户目录下) */
    if (!/\.plaintext-backup\.\d+(\.bak)?$/.test(name)) continue;
    const fp = path.join(dir, name);
    let st: fs.Stats;
    try { st = fs.statSync(fp); } catch { continue; }
    const age = now - st.mtimeMs;
    if (age < RETENTION_MS) {
      results.push({ file: fp, ageMs: age, action: 'kept' });
      continue;
    }
    const r = secureDelete(fp);
    results.push({ file: fp, ageMs: age, action: r.ok ? 'deleted' : 'failed', reason: r.reason });
  }
  /* 顺手扫 per-user 子目录 (~/Library/.../Neox/users/<uid>/neox.db.plaintext-backup.*) */
  const usersDir = path.join(dir, 'users');
  if (fs.existsSync(usersDir)) {
    let userIds: string[] = [];
    try { userIds = fs.readdirSync(usersDir); } catch { /* ignore */ }
    for (const uid of userIds) {
      const userDir = path.join(usersDir, uid);
      try {
        for (const name of fs.readdirSync(userDir)) {
          if (!/\.plaintext-backup\.\d+(\.bak)?$/.test(name)) continue;
          const fp = path.join(userDir, name);
          const st = fs.statSync(fp);
          const age = now - st.mtimeMs;
          if (age < RETENTION_MS) {
            results.push({ file: fp, ageMs: age, action: 'kept' });
            continue;
          }
          const r = secureDelete(fp);
          results.push({ file: fp, ageMs: age, action: r.ok ? 'deleted' : 'failed', reason: r.reason });
        }
      } catch { /* user dir 读不了无所谓 */ }
    }
  }

  /* 写 audit log */
  try {
    const { appendEntry } = _require('./auditLog.js');
    void appendEntry('plaintext_backup.cleanup', { processed: results.length, results: results.map(r => ({ file: path.basename(r.file), age_h: Math.round(r.ageMs / 3600000), action: r.action })) });
  } catch { /* audit log 不可用就跳 */ }

  return results;
}
