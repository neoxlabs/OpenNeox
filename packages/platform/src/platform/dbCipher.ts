/**
 * dbCipher — SQLite encryption master key 派生
 *
 * 使用 machine-id 派生:
 * — scrypt(machine-id + APP_SALT) 32B
 * — 不调用 Electron safeStorage、keytar 或任何 OS Keychain API,
 *     避免 macOS 启动时弹出钥匙串密码框
 *
 * 现有数据库继续使用 machine-id 派生 key。Keychain 仅保留历史遗留条目,
 * 不在启动路径读取或写入。
 *
 * bootstrap 是 async, getMasterKeyHex 是 sync —— 调用方 (Electron main / CLI bootstrap)
 * 启动早期调一次 await bootstrapMasterKey(), 统一预热 machine-id key。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash, scryptSync } from 'node:crypto';

const APP_SALT = 'neox-db-cipher-v1-2026';

function getMachineIdPath(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Neox', 'machine-id');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Neox', 'machine-id');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'neox', 'machine-id');
}

function readMachineId(): string | null {
  try {
    const p = getMachineIdPath();
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf-8').trim();
    return raw || null;
  } catch { return null; }
}

let _cachedKey: Buffer | null = null;
let _cachedLegacyKey: Buffer | null = null;

/** 派生 machine-id key (32B scrypt). */
function deriveMachineIdKey(): Buffer | null {
  if (_cachedLegacyKey) return _cachedLegacyKey;
  const mid = readMachineId();
  if (!mid) return null;
  const seed = `${mid}|${APP_SALT}`;
  const salt = createHash('sha256').update('neox-db-cipher-v1-salt').digest();
  try {
    _cachedLegacyKey = scryptSync(seed, salt, 32, { N: 1 << 14, r: 8, p: 1 });
    return _cachedLegacyKey;
  } catch { return null; }
}

/**
 * 启动早期调一次 (Electron main / CLI bootstrap). 异步.
 * 只预热 machine-id 派生 key，不访问任何系统钥匙串。
 */
export async function bootstrapMasterKey(): Promise<void> {
  if (!_cachedKey) _cachedKey = deriveMachineIdKey();
}

/** 返回当前 master key. null = 完全没法派生. */
export function deriveDbMasterKey(): Buffer | null {
  if (_cachedKey) return _cachedKey;
  return deriveMachineIdKey();
}

/** 是否启用 DB 加密 —  起默认 ON. NEOX_DB_ENCRYPT=0 显式关. */
export function isDbEncryptionEnabled(): boolean {
  return process.env.NEOX_DB_ENCRYPT !== '0';
}

/** master key 的 hex 形式, 用作 sqlcipher pragma key="x'<hex>'" . */
export function getMasterKeyHex(): string | null {
  const key = deriveDbMasterKey();
  return key ? key.toString('hex') : null;
}

/** machine-id key 的 hex — 供数据库兼容检查使用. */
export function getLegacyMachineIdKeyHex(): string | null {
  const key = deriveMachineIdKey();
  return key ? key.toString('hex') : null;
}

/** 当前 master key 是从哪派生的 (诊断用). */
export function getMasterKeySource(): 'machine-id' | 'none' {
  if (deriveMachineIdKey()) return 'machine-id';
  return 'none';
}

/** 重置缓存 — 测试用. */
export function _resetMasterKeyCache(): void {
  _cachedKey = null;
  _cachedLegacyKey = null;
}
