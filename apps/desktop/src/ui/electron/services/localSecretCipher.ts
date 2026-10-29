import { execSync } from 'child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, chmodSync, statSync } from 'fs';
import { join } from 'path';
import { createCipheriv, createDecipheriv, scryptSync, randomBytes, createHash } from 'crypto';
import * as os from 'os';
import { DISTRIBUTION } from '@neoxlabs/kernel/platform/distribution.js';

const MAGIC = Buffer.from('NXS1', 'utf-8');
const SALT = Buffer.from('neox.local.secret.v1.salt', 'utf-8');
const APP_SALT = 'neox-desktop:2026:secret-cipher:v1';

let cachedKey: Buffer | null = null;

export function neoxDataDir(): string {
  if (process.platform === 'darwin') return join(os.homedir(), 'Library', 'Application Support', DISTRIBUTION.appName);
  if (process.platform === 'win32') return join(process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming'), DISTRIBUTION.appName);
  return join(process.env.XDG_CONFIG_HOME || join(os.homedir(), '.config'), DISTRIBUTION.appName.toLowerCase());
}

/** 派生 machineId。stable=true 来自稳定硬件源 (ioreg/machine-id/registry);
 *  false = 落到 MAC+hostname 兜底 (易变, 不可持久化)。 */
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
  } catch { /* fallthrough to fallback */ }
  /* 兜底: MAC + hostname — 易变 (AirDrop/VPN/Docker 网卡增减), 标记 unstable, 绝不持久化。 */
  const macs = Object.values(os.networkInterfaces())
    .flat()
    .filter(Boolean)
    .map((n: any) => n?.mac as string)
    .filter(m => m && m !== '00:00:00:00:00:00')
    .sort()
    .join('|');
  return { id: createHash('sha256').update(`${os.hostname()}|${macs}|neox-fallback`).digest('hex'), stable: false };
}

function readMachineId(): string {
  const idFile = join(neoxDataDir(), 'machine-id');
  try {
    if (existsSync(idFile)) {
      const cached = readFileSync(idFile, 'utf-8').trim();
      if (cached) return cached;
    }
  } catch { /* 读失败 → 现派生 */ }
  const { id } = deriveMachineIdRaw();
  try {
    mkdirSync(neoxDataDir(), { recursive: true, mode: 0o700 });
    const tmp = `${idFile}.tmp.${process.pid}`;
    writeFileSync(tmp, id, { mode: 0o600 });
    renameSync(tmp, idFile);
  } catch { /* 持久化失败不阻塞登录 */ }
  return id;
}

/**
 * 稳定 machineId 单一真相源 — 供任何需要"同一台机器稳定标识"的地方复用
 * (deviceStore 的 device_id、deviceFingerprint 的 fpHash 等)。
 *
 * 现在 readMachineId 无条件持久化首值 (含兜底值), 钉住后即稳定 (文件是唯一真源, 不再漂移)。
 * 返回非 null = 已落盘的固定 ID (CLI/桌面跨进程同源); 仅当落盘失败且无文件时返回 null。
 */
export function getStableMachineId(): string | null {
  const id = readMachineId(); // 顺便无条件持久化, 之后所有进程读同一文件
  try {
    const idFile = join(neoxDataDir(), 'machine-id');
    if (existsSync(idFile)) return id; // 文件存在 ⇒ 已钉住 ⇒ 稳定 (跨进程恒定)
  } catch { /* ignore */ }
  return null;
}

function deriveKey(): Buffer {
  if (cachedKey) return cachedKey;
  const material = `${readMachineId()}:${APP_SALT}`;
  /* scrypt cost N=2^14 — 100ms 级, 不阻塞启动. 解密 cache 之后只算一次. */
  cachedKey = scryptSync(material, SALT, 32, { N: 1 << 14, r: 8, p: 1 });
  return cachedKey;
}

/** 加密任意字符串, 返回带 magic header 的 buffer 直接落盘. */
export function encryptLocalSecret(plaintext: string): Buffer {
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, ct]);
}

/** 检查 buffer 是不是新格式 (有 NXS1 header). 用于读取时识别新旧格式. */
export function isLocalSecretBlob(buf: Buffer): boolean {
  return buf.length >= MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

/** 解密. 不是新格式抛错, 调用方应捕获 → 回落 safeStorage 兼容或当 plaintext. */
export function decryptLocalSecret(buf: Buffer): string {
  if (!isLocalSecretBlob(buf)) {
    throw new Error('localSecretCipher: not a NXS1 blob');
  }
  if (buf.length < MAGIC.length + 12 + 16) {
    throw new Error('localSecretCipher: blob too short');
  }
  const key = deriveKey();
  const iv = buf.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = buf.subarray(MAGIC.length + 12, MAGIC.length + 12 + 16);
  const ct = buf.subarray(MAGIC.length + 12 + 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8');
}

export function hardenLegacySecretPerms(): void {
  const dir = neoxDataDir();
  /* 这些都可能含凭据或身份信息 */
  const files = ['config.json', 'auth.enc', 'gateway-key.enc', 'machine-id', 'install.id', 'audit.log'];
  try { chmodSync(dir, 0o700); } catch { /* 目录不存在 / 非本人所有 */ }
  for (const name of files) {
    const p = join(dir, name);
    try {
      const st = statSync(p);
      /* 只在"比 0600 松"时动手 —— 已经是 0600 的不必写 inode */
      if ((st.mode & 0o077) !== 0) chmodSync(p, 0o600);
    } catch { /* 不存在就跳过 */ }
  }
}
