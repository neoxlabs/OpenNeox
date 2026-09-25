
import * as tls from 'node:tls';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

/* 编译时常量 — 服务端 HTTPS 部署后填这里 (或 env override).
 * hex 形式的 SPKI sha256 (64 字符). */
const BUILTIN_PIN_HEX = '';
/** Gateway hostname 白名单 — 只这些 host 的 https 请求走 pinning. */
const PINNED_HOSTS = new Set(['gateway.neoxcloud.com']);

function getActivePinHex(): string | null {
  const env = process.env.NEOX_PIN_GATEWAY_PUBKEY_SHA256;
  const hex = (env && env.trim()) || BUILTIN_PIN_HEX;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return hex.toLowerCase();
}

/** 给定 TLS 证书的公钥, 算 SPKI 的 sha256 hex. */
function spkiSha256(cert: tls.PeerCertificate): string {
  /* cert.pubkey 是 DER 编码的 SubjectPublicKeyInfo */
  const der = (cert as any).pubkey as Buffer | undefined;
  if (!der || !Buffer.isBuffer(der)) {
    /* 老 Node 没暴露, 从 raw 证书提取 (用 X.509 解析). */
    if (cert.raw) {
      try {
        const x509 = new crypto.X509Certificate(cert.raw);
        const pubKeyDer = x509.publicKey.export({ type: 'spki', format: 'der' });
        return crypto.createHash('sha256').update(pubKeyDer).digest('hex');
      } catch { /* 老路径走 cert.fingerprint256 */ }
    }
  }
  if (der) {
    return crypto.createHash('sha256').update(der).digest('hex');
  }
  /* 兜底: 用证书整 sha256 (不准确, 续签会换). 至少给条诊断路径. */
  return cert.fingerprint256 ? cert.fingerprint256.replace(/:/g, '').toLowerCase() : '';
}

let _installed = false;

/** 启动早期调一次. 没 pin / 没 https → no-op. */
export function setupCertPinning(): void {
  if (_installed) return;
  const pin = getActivePinHex();
  if (!pin) return;

  let undici: any;
  try { undici = _require('undici'); } catch {
    /* node 内置 fetch 在 Node 18+ 走 undici, 应该总能拿到. 取不到就放弃 (no-op). */
    return;
  }

  const Pool = undici.Pool;
  if (!Pool) return;

  /* 给 PINNED_HOSTS 每个 host 注册带自定义 TLS 验证的 dispatcher.
   * undici.setGlobalDispatcher + Agent 按 host route 太复杂, 这里用 RouteableDispatcher 简化:
   * 拦截特定 origin → 自定义 Pool; 其他 → 默认. */
  const customAgent = new undici.Agent({
    connect: {
      checkServerIdentity(hostname: string, cert: tls.PeerCertificate) {
        /* 不在白名单 → 走标准 X.509 check */
        if (!PINNED_HOSTS.has(hostname)) return tls.checkServerIdentity(hostname, cert);
        /* 在白名单 → 标准 check + pin check */
        const stdErr = tls.checkServerIdentity(hostname, cert);
        if (stdErr) return stdErr;
        const actual = spkiSha256(cert);
        if (actual !== pin) {
          return new Error(`certPin: ${hostname} SPKI sha256 mismatch (expected ${pin}, got ${actual})`);
        }
        return undefined;
      },
    },
  });
  undici.setGlobalDispatcher(customAgent);
  _installed = true;
  console.warn(`[certPin] pinning active for hosts: ${[...PINNED_HOSTS].join(', ')}, pin=${pin.slice(0, 16)}...`);
}

/** 诊断: 当前 pin 设没设. */
export function getCertPinStatus(): { enabled: boolean; pin: string | null; hosts: string[] } {
  return { enabled: _installed, pin: getActivePinHex(), hosts: [...PINNED_HOSTS] };
}
