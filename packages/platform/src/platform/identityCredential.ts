/**
 * platform/identityCredential — 按 identity-dir 现取网关凭据 (架构重构 阶段2,)。
 *
 *   server 进程拿到 --identity-dir=<configDir> 后, 用本模块从 <dir>/gateway-key.enc (+auth.enc
 *   确认登录身份) 解出当前网关凭据, 注册成 providerResolver 的 CredentialProvider。
 *
 *   这就把"网关 key 的真源"从【共享明文 routing.json】移到了【按端隔离的加密 gateway-key.enc】:
 *   - CLI server  → --identity-dir ~/.neox            → 读 CLI 自己的 nxk
 *   - 桌面 server → --identity-dir <桌面 userData>     → 读桌面自己的 nxk
 *   桌面就算退化成匿名, 也只动它自己 dir 下的文件, 碰不到 CLI 的凭据 (不变量 I5)。
 *
 *   解密只依赖 machineId (机器全局), 与 dir 无关 → 任一 dir 下的 .enc 本机都能解。
 */

import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { decryptLocalSecret, isLocalSecretBlob } from './localSecretCipher.js';
import type { GatewayCredential } from './providerResolver.js';

interface StoredGatewayKey {
  secret?: string;        /* nxk_<prefix>_<body> 或 anonkey_... */
  ownerUserId?: string;   /* 归属用户; 跨户校验用 */
}
interface StoredAuth {
  user?: { id?: string };
}

function readEncJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    const buf = readFileSync(path);
    if (!isLocalSecretBlob(buf)) return null;
    return JSON.parse(decryptLocalSecret(buf)) as T;
  } catch {
    return null;
  }
}

/** 读 <identityDir>/auth.enc 的登录用户 id。null = 未登录 / 解不开。 */
export function readIdentityUserId(identityDir: string): string | null {
  const auth = readEncJson<StoredAuth>(join(identityDir, 'auth.enc'));
  return auth?.user?.id ?? null;
}

/** daemon 身份纪元 (阶段4): 当前登录用户 id, 未登录为 'anon'。
 *  随 登录/登出/换户 变化 → daemon 复用时比对它, 不一致即回收重启 (防陈旧身份 daemon 续命)。
 *  注: 用 userId 而非 auth.enc mtime —— token refresh 改 mtime 但身份不变, 避免无谓重启。
 *  client(processManager) 与 server(main.ts) 必须都用本函数算, 保证一致。 */
export function computeIdentityEpoch(identityDir: string): string {
  return readIdentityUserId(identityDir) ?? 'anon';
}

/**
 * 按 identity-dir 现取网关凭据。
 *   · 登录态 (auth.enc 在) + 自有 nxk(归属相符) → {nxk, 'nxk', userId}
 *   · 未登录 + anonkey                          → {anonkey, 'anonkey', null}
 *   · 其它 (无 key / 换户残留 nxk / 登录态却是 anonkey) → null
 *     → resolver 回落 routing.json (过渡期) 或经 I1 守卫 fail-fast, 前端 syncAfterLogin 重签自愈。
 */
export function readGatewayCredentialFromDir(identityDir: string): GatewayCredential | null {
  const gk = readEncJson<StoredGatewayKey>(join(identityDir, 'gateway-key.enc'));
  const secret = gk?.secret;
  if (!secret) return null;
  const authUserId = readIdentityUserId(identityDir);

  if (secret.startsWith('nxk_')) {
    const owner = gk?.ownerUserId ?? authUserId;
    /* 登录态 nxk: 归属必须 == 当前登录用户, 防陈旧/换户 key 透出。 */
    if (authUserId && owner && owner !== authUserId) return null;
    /* 有 nxk 但 auth.enc 已不在 = 登出残留 → 不透 nxk。 */
    if (!authUserId) return null;
    return { key: secret, type: 'nxk', userId: owner ?? authUserId };
  }

  /* anonkey 只在【未登录】时有效; 登录态却存 anonkey = 异常 (不该发生), 不透出。 */
  if (authUserId) return null;
  return { key: secret, type: 'anonkey', userId: null };
}
