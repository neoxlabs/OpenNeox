/**
 * Grok CLI / cli-chat-proxy transport headers
 *
 * 对齐 AccountHub `xai-constants.js` + grok-build `xai-grok-sampler` client:
 *   · 官方代理 `cli-chat-proxy.grok.com` 用 `x-grok-client-version` 做版本门禁
 *   · 缺省会报: Your Grok CLI version (none) is outdated … >= 0.1.202
 *
 * grok-build-main (本机 demo) Cargo 版本 = 0.2.109; Accounthub 先前 0.2.101.
 * 取 0.2.109 对齐源码树最新.
 */

/** 与 grok-build `xai-grok-version` Cargo.toml 对齐 */
export const GROK_CLI_CLIENT_VERSION = '0.2.109';

export const GROK_CLI_CLIENT_IDENTIFIER = 'grok-shell';

const GROK_PROXY_HOST_RE =
  /cli-chat-proxy\.grok\.com|selfhosted|grok\.com\/v1|api\.x\.ai/i;

/** baseUrl / model 是否看起来走 Grok CLI 代理通道 */
export function looksLikeGrokCliTransport(baseUrl?: string, model?: string): boolean {
  const url = (baseUrl || '').toLowerCase();
  const m = (model || '').toLowerCase();
  if (GROK_PROXY_HOST_RE.test(url)) return true;
  if (m.startsWith('grok-') || m.includes('/grok-')) return true;
  return false;
}

/**
 * 注入 Grok CLI 识别头. 已有同名头不覆盖 (用户 extraHeaders / Accounthub 凭证优先).
 */
export function applyGrokCliHeaders(
  headers: Record<string, string>,
  opts?: { baseUrl?: string; model?: string; force?: boolean },
): Record<string, string> {
  if (!opts?.force && !looksLikeGrokCliTransport(opts?.baseUrl, opts?.model)) {
    return headers;
  }
  const out = { ...headers };
  const has = (name: string) =>
    Object.keys(out).some((k) => k.toLowerCase() === name.toLowerCase());

  if (!has('x-grok-client-version')) {
    out['x-grok-client-version'] = GROK_CLI_CLIENT_VERSION;
  }
  if (!has('x-grok-client-identifier')) {
    out['x-grok-client-identifier'] = GROK_CLI_CLIENT_IDENTIFIER;
  }
  if (!has('x-grok-client-mode')) {
    out['x-grok-client-mode'] = 'headless';
  }
  if (!has('X-XAI-Token-Auth')) {
    out['X-XAI-Token-Auth'] = 'xai-grok-cli';
  }
  if (!has('x-authenticateresponse')) {
    out['x-authenticateresponse'] = 'authenticate-response';
  }
  /* UA: grok-pager/V grok-shell/V (os; arch) — CPA / sso_to_auth_json 同款 */
  if (!has('User-Agent') || /axios|neox/i.test(out['User-Agent'] || out['user-agent'] || '')) {
    const platform = process.platform === 'darwin' ? 'darwin' : process.platform;
    const arch = process.arch === 'arm64' ? 'arm64' : process.arch;
    out['User-Agent'] =
      `grok-pager/${GROK_CLI_CLIENT_VERSION} grok-shell/${GROK_CLI_CLIENT_VERSION} (${platform}; ${arch})`;
  }
  return out;
}
