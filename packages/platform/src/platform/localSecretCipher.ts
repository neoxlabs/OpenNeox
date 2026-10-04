/**
 * platform/localSecretCipher — 本地小型敏感数据 (auth token / gateway key / install uuid)
 * 的 AES-256-GCM 自加密。**canonical 实现** —— CLI (auth/cipher.ts) 与桌面
 * (electron/services/localSecretCipher.ts) 的同款逻辑收口到 core 这一份, 让 server 进程
 * (neox-core) 也能按 identity-dir 解出本端凭据 (架构重构 阶段2,)。
 *
 *    MAGIC / SALT / APP_SALT / machineId 派生必须与 CLI/桌面那两份【逐字节一致】——
 *   否则跨端写的 auth.enc / gateway-key.enc 互相解不开。改动会让所有已登录用户失效。
 *
 *   key 只由 machineId 派生 (机器全局), 与文件所在目录无关 → 本机任一 configDir 下的
 *   .enc 都能解 (这正是 server 按 --identity-dir 读凭据的基础)。
 *
 *   blob layout:
 *     bytes[0..4]   magic "NXS1"
 *     bytes[4..16]  IV (12 bytes, AES-GCM nonce)
 *     bytes[16..32] auth tag (16 bytes)
 *     bytes[32..]   ciphertext (AES-256-GCM)
 *   key = scrypt(machineId || ":" || APP_SALT, SALT, 32, N=2^14, r=8, p=1)
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, scryptSync, randomBytes, createHash } from 'node:crypto';
import * as os from 'node:os';

const MAGIC = Buffer.from('NXS1', 'utf-8');
const SALT = Buffer.from('neox.local.secret.v1.salt', 'utf-8');
/* 必须与 CLI auth/cipher.ts、桌面 localSecretCipher.ts 一致, 改了会让所有已登录用户失效。 */
const APP_SALT = 'neox-desktop:2026:secret-cipher:v1';

let cachedKey: Buffer | null = null;

/** Neox 数据目录 (machine-id 所在; CLI/桌面/server 必须算出一致路径)。 */
export function neoxSecretDataDir(): string {
  if (process.platform === 'darwin') return join(os.homedir(), 'Library', 'Application Support', 'Neox');
  if (process.platform === 'win32') return join(process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming'), 'Neox');
  return join(process.env.XDG_CONFIG_HOME || join(os.homedir(), '.config'), 'neox');
}

function deriveMachineIdRaw(): { id: string; stable: boolean } {
  try {
    if (process.platform === 'darwin') {
      const out = execSync('ioreg -rd1 -c IOPlatformExpertDevice', { encoding: 'utf-8', timeout: 8000 });
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (m) return { id: m[1], stable: true };
    } else if (process.platform === 'linux') {
      for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        if (existsSync(p)) { const v = readFileSync(p, 'utf-8').trim(); if (v) return { id: v, stable: true }; }
      }
    } else if (process.platform === 'win32') {
      const out = execSync('reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid', { encoding: 'utf-8', timeout: 8000 });
      const m = out.match(/MachineGuid\s+REG_SZ\s+([a-fA-F0-9-]+)/);
      if (m) return { id: m[1], stable: true };
    }
  } catch { /* fallthrough */ }
  const macs = Object.values(os.networkInterfaces())
    .flat()
    .filter(Boolean)
    .map((n: any) => n?.mac as string)
    .filter((m) => m && m !== '00:00:00:00:00:00')
    .sort()
    .join('|');
  return { id: createHash('sha256').update(`${os.hostname()}|${macs}|neox-fallback`).digest('hex'), stable: false };
}

/** machineId — 与 CLI auth/cipher.ts getStableMachineId 同源, 供 deviceFingerprint 复用。 */
export function getStableMachineId(): string {
  return readMachineId();
}

/** machineId — 首次派生即持久化到 <dataDir>/machine-id, 之后永远复用 (跨进程/端同源)。 */
function readMachineId(): string {
  const idFile = join(neoxSecretDataDir(), 'machine-id');
  try {
    if (existsSync(idFile)) {
      const cached = readFileSync(idFile, 'utf-8').trim();
      if (cached) return cached;
    }
  } catch { /* 现派生 */ }
  const { id } = deriveMachineIdRaw();
  try {
    mkdirSync(neoxSecretDataDir(), { recursive: true, mode: 0o700 });
    const tmp = `${idFile}.tmp.${process.pid}`;
    writeFileSync(tmp, id, { mode: 0o600 });
    renameSync(tmp, idFile);
  } catch { /* 持久化失败不阻塞 */ }
  return id;
}

function deriveKey(): Buffer {
  if (cachedKey) return cachedKey;
  const material = `${readMachineId()}:${APP_SALT}`;
  cachedKey = scryptSync(material, SALT, 32, { N: 1 << 14, r: 8, p: 1 });
  return cachedKey;
}

/** 加密任意字符串, 返回 NXS1 blob, 可直接落盘。 */
export function encryptLocalSecret(plaintext: string): Buffer {
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, ct]);
}

/** 是否新格式 NXS1 blob。 */
export function isLocalSecretBlob(buf: Buffer): boolean {
  return buf.length >= MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

/** 解密 NXS1 blob。失败抛错 (auth tag mismatch / 短包 / 非 magic)。 */
export function decryptLocalSecret(buf: Buffer): string {
  if (!isLocalSecretBlob(buf)) {
    throw new Error('localSecretCipher: not a NXS1 blob (salt 不一致或文件损坏)');
  }
  if (buf.length < MAGIC.length + 12 + 16) {
    throw new Error('localSecretCipher: blob too short (corrupt)');
  }
  const key = deriveKey();
  const iv = buf.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = buf.subarray(MAGIC.length + 12, MAGIC.length + 12 + 16);
  const ct = buf.subarray(MAGIC.length + 12 + 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8');
}
