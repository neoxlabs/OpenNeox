
import { encryptLocalSecret, decryptLocalSecret, isLocalSecretBlob } from '../platform/localSecretCipher.js';

const ENC_PREFIX = 'enc:v1:';
const NEOX_MANAGED = 'neox-managed';

/** 判断是否已加密封装 (`enc:v1:` 前缀). */
export function isWrappedApiKey(stored: string | undefined | null): boolean {
  return typeof stored === 'string' && stored.startsWith(ENC_PREFIX);
}

/** 判断是否 Neox Cloud sentinel 值. */
export function isNeoxManagedApiKey(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.trim() === NEOX_MANAGED;
}

/**
 * 加密明文 apiKey, 返回 `enc:v1:<base64url>` 字符串 (可直接写 JSON).
 *   · 空串 → 直接返 (不加密空值)
 *   · sentinel 'neox-managed' → 直接返 (不加密特殊值)
 *   · 已 wrapped → 直接返 (幂等)
 *   · 其它 → 加密
 */
export function wrapApiKey(plain: string): string {
  if (!plain) return plain;
  if (isNeoxManagedApiKey(plain)) return plain;
  if (isWrappedApiKey(plain)) return plain;
  const buf = encryptLocalSecret(plain);
  return ENC_PREFIX + buf.toString('base64url');
}

/**
 * 解密封装的 apiKey 回明文.
 *   · 空 / null → 返 ''
 *   · sentinel 'neox-managed' → 直接返 (透传 sentinel)
 *   · 非 wrapped 格式 → 视为遗留明文, 直接返 (让上层用起来, 首次 persist 时会自动 migrate)
 *   · wrapped → 解密返明文
 *   · 解密失败 → 返 '' 并 warn (机器 machineId 变了 / 文件损坏 — 用户需重填 apiKey)
 */
export function unwrapApiKey(stored: string | undefined | null): string {
  const s = stored ?? '';
  if (!s) return '';
  if (isNeoxManagedApiKey(s)) return s;
  if (!isWrappedApiKey(s)) return s;
  const b64 = s.slice(ENC_PREFIX.length);
  try {
    const buf = Buffer.from(b64, 'base64url');
    if (!isLocalSecretBlob(buf)) {
      console.warn('[apiKeyCrypto] wrapped apiKey base64 does not decode to NXS1 blob');
      return '';
    }
    return decryptLocalSecret(buf);
  } catch (err) {
    console.warn('[apiKeyCrypto] failed to decrypt provider apiKey:', (err as Error).message);
    return '';
  }
}
