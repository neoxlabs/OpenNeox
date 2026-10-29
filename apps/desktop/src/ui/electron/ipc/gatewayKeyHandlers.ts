/* 走桥的 ipcMain 替身 —— 顶层 import electron 会让整个 bundle 在纯 Node 里
 * 加载失败, 连累同包所有 handler。见 ipcMainBridged.ts / lazyElectron.ts。 */
import { ipcMain } from './ipcMainBridged.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { encryptLocalSecret, decryptLocalSecret, isLocalSecretBlob } from '../services/localSecretCipher.js';
import { tokenDirPath } from './authHandlers.js';
import { resolveCloudEndpoints } from '../services/cloudEndpoints.js';
import { getCurrentUserId } from '@neoxlabs/platform/utils/config.js';

export type StoredGatewayKey = {
  /** 完整 secret (nxk_<prefix>_<body>) — 直接当 Bearer 用 */
  secret: string;
  /** api_keys 表里的 id, 后续 revoke / list 用 */
  keyId: string;
  /** 显示用 */
  name: string;
  createdAt: string;
  /** 拥有者 userId — 切户时强制 re-mint 防 B 误用 A 的 key 扣 A 钱.
   *   anonymous (匿名 anonkey_) 时为 anonymous:fp:<fpHash>. */
  ownerUserId?: string;
  expiresAt?: string;
};

/* gateway-key.enc 与 auth.enc 同放 canonical 目录 tokenDirPath() (~/Library/.../Neox),
 * 不再用 app.getPath('userData') (dev 模式会落到 .../Electron/ 跟 auth.enc 错开)。
 * 这样 server 拿 --identity-dir=tokenDirPath() 能在同一目录读到这对凭据 (架构重构 阶段2)。 */
const filePath = () => join(tokenDirPath(), 'gateway-key.enc');

async function readKey(): Promise<StoredGatewayKey | null> {
  try {
    const buf = await fs.readFile(filePath());

    if (isLocalSecretBlob(buf)) {
      return JSON.parse(decryptLocalSecret(buf)) as StoredGatewayKey;
    }

    /* 历史 plaintext JSON (老 Linux 用户) — 升级到新 cipher 后返回. */
    const utf = buf.toString('utf-8');
    if (utf.trim().startsWith('{')) {
      const parsed = JSON.parse(utf) as StoredGatewayKey;
      try { await fs.writeFile(filePath(), encryptLocalSecret(utf), { mode: 0o600 }); } catch { /* ignore */ }
      return parsed;
    }

    /* 老 safeStorage 密文 — 不再调 safeStorage.decryptString 避免 Keychain 弹框.
     * 删旧文件; 下次登录后 auto-mint 一把新 key, 体验上一次性. */
    try { await fs.unlink(filePath()); } catch { /* ignore */ }
    return null;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    console.error('[gatewayKey] read failed:', err);
    return null;
  }
}

async function writeKey(value: StoredGatewayKey): Promise<void> {
  const json = JSON.stringify(value);
  await fs.writeFile(filePath(), encryptLocalSecret(json), { mode: 0o600 });
}

async function clearKey(): Promise<void> {
  try {
    await fs.unlink(filePath());
  } catch (err: any) {
    if (err?.code !== 'ENOENT') console.error('[gatewayKey] clear failed:', err);
  }
}

function isKeyUsableForActiveUser(k: StoredGatewayKey | null): boolean {
  if (!k?.secret) return false;
  const currentUserId = getCurrentUserId();
  const owner = String(k.ownerUserId ?? '');
  const secret = String(k.secret ?? '');
  if (secret.startsWith('anonkey_')) {
    return !currentUserId && owner.startsWith('anonymous:fp:');
  }
  if (!secret.startsWith('nxk_')) return false;
  return !!currentUserId && owner === currentUserId;
}

/** main 进程内部直接读 (含 secret) — neoxRoutingService 用. 不经 IPC, 不暴露 renderer. */
export async function getGatewayKey(): Promise<StoredGatewayKey | null> {
  const key = await readKey();
  return isKeyUsableForActiveUser(key) ? key : null;
}

/** main 进程内部清理 canonical gateway-key.enc. logoutBus/IPC 共用同一条路径. */
export async function clearGatewayKey(): Promise<void> {
  await clearKey();
}

/**
 * Renderer-facing redacted view — 不含 secret. renderer 只需要知道
 *   · 有没有 key (hasKey)
 *   · 是哪类 ('nxk' = 正式用户 key, 'anon' = 匿名试用 anonkey_, 'unknown' = 历史残留 / 其他前缀)
 *   · 元信息 (keyId / name / createdAt) 用来 UI 显示, 不能用来认证.
 *
 * 旧 IPC 直接返完整 secret → renderer XSS 一旦发生可直接窃 gateway 凭证. 新协议
 * 收紧了暴露面, 满足 P0 A.3 安全审计要求.
 */
export type RedactedGatewayKey = {
  hasKey: boolean;
  keyType: 'nxk' | 'anon' | 'unknown' | 'none';
  keyId: string;
  name: string;
  createdAt: string;
  /** S2: renderer 用它判 <4h 提前 re-mint. 非敏感数据 (ISO 时间) 可透传. */
  expiresAt?: string;
};

function redact(k: StoredGatewayKey | null): RedactedGatewayKey {
  if (!k) return { hasKey: false, keyType: 'none', keyId: '', name: '', createdAt: '' };
  const s = String(k.secret ?? '');
  let keyType: RedactedGatewayKey['keyType'] = 'unknown';
  if (s.startsWith('nxk_')) keyType = 'nxk';
  else if (s.startsWith('anonkey_')) keyType = 'anon';
  return {
    hasKey: !!s,
    keyType,
    keyId: String(k.keyId ?? ''),
    name: String(k.name ?? ''),
    createdAt: String(k.createdAt ?? ''),
    ...(k.expiresAt ? { expiresAt: String(k.expiresAt) } : {}),
  };
}

function cleanGatewayMeta(value: unknown, fallback: string, maxLength: number): string {
  const raw = typeof value === 'string' ? value : fallback;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (cleaned || fallback).slice(0, maxLength);
}

function cleanGatewayCreatedAt(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString() : new Date().toISOString();
}

export function registerGatewayKeyIpcHandlers(): void {
  /* 'gateway-key:get' 默认 redacted — renderer 一律拿不到 secret, 限制 XSS 后的二次窃取面. */
  ipcMain.handle('gateway-key:get', async (): Promise<RedactedGatewayKey> => {
    return redact(await getGatewayKey());
  });


  ipcMain.handle('gateway-key:set', async (_event, value: StoredGatewayKey): Promise<{ ok: true }> => {
    if (!value || typeof value.secret !== 'string' || !value.secret.trim()) {
      throw new Error('gateway-key:set — invalid payload (secret required)');
    }
    const secret = String(value.secret).trim();
    if (secret.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(secret)) {
      throw new Error('gateway-key:set — invalid gateway key format');
    }
    if (!secret.startsWith('nxk_')) {
      throw new Error('gateway-key:set — only nxk_ user gateway keys may be set from renderer');
    }
    const currentUserId = getCurrentUserId();
    if (!currentUserId) {
      throw new Error('gateway-key:set — login required before storing a user gateway key');
    }
    await writeKey({
      secret,
      keyId: cleanGatewayMeta(value.keyId, '', 256),
      name: cleanGatewayMeta(value.name, 'neox-desktop', 128),
      createdAt: cleanGatewayCreatedAt(value.createdAt),
      ownerUserId: currentUserId,
      ...(typeof value.expiresAt === 'string' && Date.parse(value.expiresAt) > 0
        ? { expiresAt: new Date(Date.parse(value.expiresAt)).toISOString() }
        : {}),
    });
    return { ok: true };
  });

  /**
   * gateway-key:check-owner — 校验当前 gateway key 跟传入 userId 是否匹配.
   *   不匹配时 renderer 应强制 re-mint 一把新 key, 防 B 沿用 A 的 nxk_ 扣 A 账户.
   *   返回 { matches, currentOwnerId } — currentOwnerId='' 表示老 key 无 owner 字段.
   */
  ipcMain.handle('gateway-key:check-owner', async (): Promise<{ matches: boolean; currentOwnerId: string }> => {
    const k = await readKey();
    const current = cleanGatewayMeta(k?.ownerUserId, '', 512);
    const activeUserId = getCurrentUserId();
    if (!k || !activeUserId) return { matches: false, currentOwnerId: current };
    /* 老 key 没 owner 字段 → 视为不匹配, 强制 re-mint 升级到带 owner 的新版.
     *   anonymous key (anonkey_) 跟匿名状态 ('anonymous') 比较, 也走 owner 字段. */
    return {
      matches: !!k.secret?.startsWith('nxk_') && current !== '' && current === activeUserId,
      currentOwnerId: current,
    };
  });
  ipcMain.handle('gateway-key:clear', async (): Promise<{ ok: true }> => {
    await clearGatewayKey();
    return { ok: true };
  });
}
