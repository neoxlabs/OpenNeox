/**
 * selfHostedRelay.ts — 自托管中继的配置 (~/.neox/self-hosted-relay.enc)。
 *
 * 用户在自己的 VPS 上跑 cloud/relay, 桌面填地址和部署令牌, 手机扫配对码时一并拿到。
 * 配了它, 远程连接就走这台中继, 不需要账号 —— 鉴权是部署令牌, 内容仍是配对时派生的
 * 端到端密钥加密, 中继看不到。两个发行版都能用; 商业版没配时照旧走账号那条。
 *
 * 令牌按本机 machine-id 派生的密钥加密落盘 (跟 auth.enc 同一套), 不留明文。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { neoxHome } from '@neoxlabs/kernel/platform/neoxHome.js';
import { decryptLocalSecret, encryptLocalSecret, isLocalSecretBlob } from '../services/localSecretCipher.js';

export interface SelfHostedRelayConfig {
  /** https://relay.example.com (不带 /relay 路径; 客户端自己拼) */
  url: string;
  token: string;
}

const MIN_TOKEN_LEN = 16;

function filePath(): string {
  return neoxHome('self-hosted-relay.enc');
}

/** 规范化并校验; 不合法返回原因, 给设置页直接显示。 */
export function normalizeSelfHostedRelay(input: { url?: unknown; token?: unknown }):
  { ok: true; config: SelfHostedRelayConfig } | { ok: false; error: string } {
  const rawUrl = typeof input.url === 'string' ? input.url.trim() : '';
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'invalid_url' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { ok: false, error: 'invalid_url' };
  if (token.length < MIN_TOKEN_LEN) return { ok: false, error: 'token_too_short' };
  /* 用户可能粘贴了完整的 WS 地址或带了 /relay —— 只留 origin + 自定义前缀, 去掉我们自己会拼的那段 */
  const base = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '').replace(/\/relay(\/api\/v1\/relay)?$/, '');
  return { ok: true, config: { url: base, token } };
}

let cache: SelfHostedRelayConfig | null | undefined;

export function loadSelfHostedRelay(): SelfHostedRelayConfig | null {
  if (cache !== undefined) return cache;
  try {
    const buf = fs.readFileSync(filePath());
    const parsed = JSON.parse(isLocalSecretBlob(buf) ? decryptLocalSecret(buf) : '');
    const r = normalizeSelfHostedRelay(parsed);
    cache = r.ok ? r.config : null;
  } catch {
    cache = null;
  }
  return cache;
}

export function saveSelfHostedRelay(config: SelfHostedRelayConfig | null): void {
  const file = filePath();
  cache = config;
  if (!config) {
    try { fs.unlinkSync(file); } catch { /* 本来就没有 */ }
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, encryptLocalSecret(JSON.stringify(config)), { mode: 0o600 });
}

/** RPC relay.config —— 手机在同 Wi-Fi 连上时取自托管中继的地址和令牌, 出门后就能远程。
 *  只走局域网连接给: 已经在中继上的连接本来就有, 不需要再发一遍。 */
export function relayConfigRpc(transport: string): { relay: SelfHostedRelayConfig | null } {
  if (transport !== 'lan') return { relay: null };
  const cfg = loadSelfHostedRelay();
  return { relay: cfg ? { url: cfg.url, token: cfg.token } : null };
}

/** 测试用: 丢掉内存缓存 */
export function _resetSelfHostedRelayCache(): void {
  cache = undefined;
}
