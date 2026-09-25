/**
 * Release integrity — CLI 自更新的防投毒校验。
 *
 * 威胁: `neox update` 下载 tarball 后原子替换正在运行的二进制。若下载源(R2)被控
 * 或传输被中间人劫持, 攻击者可投递恶意 binary → 本机代码执行。原代码只有
 * `buf.length < 1024` 的弱检查, 等于白送。
 *
 * 双层防御:
 *   1. **sha256 摘要校验** — latest.json 携带每平台 tarball 的 sha256; 客户端下载后
 *      逐字节核对。防传输损坏 + 防"只换 tarball 不改 latest.json"的投毒。
 *   2. **ed25519 清单签名** — latest.json 的 `{version, digests}` 用发布私钥签名,
 *      客户端用内置公钥验签。防"同时控制 R2 改 latest.json + tarball"的强投毒 ——
 *      攻击者没有私钥就无法伪造 digests。
 *
 * 性能: 只在 `neox update` 真正下载时跑一次 (sha256 一遍 + 一次 ed25519 verify),
 * 对日常使用零开销。
 *
 * 兼容/不自锁: 公钥未配置(占位)时降级为仅 sha256; latest.json 无这些字段时回落
 * 原行为。生产可用 NEOX_UPDATE_REQUIRE_SIGNATURE=1 强制必须验签通过。
 */

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';

/**
 * 发布验签公钥 (ed25519, SPKI PEM)。公钥公开、可硬编码; 私钥由发布者离线持有
 * (发布脚本从 NEOX_RELEASE_SIGN_KEY 环境变量读)。
 *
 * 生成密钥对: `node scripts/publish/gen-release-keypair.mjs`
 * 把打印的 PUBLIC KEY 粘到这里, PRIVATE KEY 存进发布机 secrets。
 *
 * 占位状态 (含 PLACEHOLDER) = 未配置 → 验签降级为仅 sha256。填真公钥后自动启用强验签。
 */
export const RELEASE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
__RELEASE_ED25519_PUBKEY_PLACEHOLDER__
-----END PUBLIC KEY-----`;

export function isReleasePublicKeyConfigured(): boolean {
  return !RELEASE_PUBLIC_KEY_PEM.includes('PLACEHOLDER');
}

export interface SignedLatest {
  version: string;
  /** platform-arch → tarball sha256 (hex) */
  digests?: Record<string, string>;
  /** base64(ed25519 sign of canonicalJson({version, digests})) */
  signature?: string;
  /** 公钥标识, 供轮换时选对公钥 (可选) */
  signatureKeyId?: string;
}

/**
 * 稳定序列化 — key 递归字典序。客户端与发布端必须逐字节一致, 否则签名对不上。
 * 只处理 JSON 安全类型 (string/number/bool/null/array/plain object)。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(',')}}`;
}

/** 待签名/待验签的规范载荷 = {version, digests}。signature/其它字段不入签名。 */
export function signingPayload(latest: SignedLatest): string {
  return canonicalJson({ version: latest.version, digests: latest.digests ?? {} });
}

/** 校验 tarball 摘要。expected 缺失(老 latest.json)时返回 'skip'。 */
export function verifyTarballDigest(
  buf: Buffer,
  expectedSha256: string | undefined,
): 'ok' | 'mismatch' | 'skip' {
  if (!expectedSha256) return 'skip';
  const actual = createHash('sha256').update(buf).digest('hex');
  // 定长 hex 常时间比较不是必需 (摘要非机密), 但小写归一避免大小写误判。
  return actual.toLowerCase() === expectedSha256.trim().toLowerCase() ? 'ok' : 'mismatch';
}

/**
 * 用公钥验 ed25519 清单签名。无签名或公钥未配置时返回 'skip'。
 * @param pubPemOverride 仅测试用的公钥注入; 生产不传 → 用内置 RELEASE_PUBLIC_KEY_PEM。
 */
export function verifyManifestSignature(
  latest: SignedLatest,
  pubPemOverride?: string,
): 'ok' | 'bad' | 'skip' {
  const pubPem = pubPemOverride ?? (isReleasePublicKeyConfigured() ? RELEASE_PUBLIC_KEY_PEM : undefined);
  if (!latest.signature || !pubPem) return 'skip';
  try {
    const pubKey = createPublicKey({ key: pubPem, format: 'pem', type: 'spki' });
    const payload = Buffer.from(signingPayload(latest), 'utf-8');
    const sig = Buffer.from(latest.signature, 'base64');
    // ed25519: algorithm 传 null
    return cryptoVerify(null, payload, pubKey, sig) ? 'ok' : 'bad';
  } catch {
    return 'bad';
  }
}

export interface UpdateVerifyDecision {
  allow: boolean;
  reason: string;
}

/**
 * 汇总裁决: 给定清单 + 下载好的 tarball, 判断能否替换 binary。
 *
 * 规则:
 *   - 摘要 mismatch → 一律拒 (传输/投毒)。
 *   - 签名 bad → 一律拒 (公钥已配且签名对不上 = 伪造)。
 *   - 要求强验签 (NEOX_UPDATE_REQUIRE_SIGNATURE=1 或 requireSignature) 时, 签名/摘要
 *     任一 skip → 拒 (拒绝"没有可验证完整性"的更新)。
 *   - 否则 (过渡期): 有啥验啥, 都 skip 也放行 (回落原行为)。
 */
export function decideUpdate(
  latest: SignedLatest,
  tarball: Buffer,
  opts: { requireSignature?: boolean; publicKeyPem?: string } = {},
): UpdateVerifyDecision {
  const requireSig = opts.requireSignature
    || process.env.NEOX_UPDATE_REQUIRE_SIGNATURE === '1';

  const digest = verifyTarballDigest(tarball, latest.digests?.[currentPlatformArch()]);
  if (digest === 'mismatch') {
    return { allow: false, reason: 'tarball sha256 与清单不符 (可能被篡改或传输损坏)' };
  }

  const sig = verifyManifestSignature(latest, opts.publicKeyPem);
  if (sig === 'bad') {
    return { allow: false, reason: '清单 ed25519 签名校验失败 (可能被伪造)' };
  }

  if (requireSig && (sig !== 'ok' || digest !== 'ok')) {
    return {
      allow: false,
      reason: `要求强验签但缺可验证完整性 (signature=${sig}, digest=${digest})`,
    };
  }

  const verified: string[] = [];
  if (sig === 'ok') verified.push('signature');
  if (digest === 'ok') verified.push('sha256');
  return {
    allow: true,
    reason: verified.length ? `已校验: ${verified.join('+')}` : '无完整性字段 (过渡期放行)',
  };
}

export function currentPlatformArch(): string {
  return `${process.platform}-${process.arch}`;
}
