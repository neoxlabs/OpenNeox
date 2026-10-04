import { VERSION } from '../version.js';

export const CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";
export const CLAUDE_CODE_STAINLESS_PACKAGE_VERSION = '0.80.0';
export const PROMPT_CACHING_SCOPE_BETA_FEATURE = 'prompt-caching-scope-2026-01-05';
export const DEFAULT_CLAUDE_CODE_BETA_FEATURES = [
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
  PROMPT_CACHING_SCOPE_BETA_FEATURE,
];

export type SystemPromptCacheMode = 'default' | 'global' | 'none';

export interface SystemPromptCacheBlock {
  text: string;
  cacheMode: SystemPromptCacheMode;
}

const NON_CLAUDE_VENDOR_HOSTS = [
  'api.deepseek.com',
  'api.moonshot.cn',
  'api.moonshot.ai',
  'open.bigmodel.cn',
  'api.z.ai',
  'api.minimax.io',
  'api.minimaxi.com',
  'dashscope.aliyuncs.com',
  'ark.cn-beijing.volces.com',
];
function hostOf(baseUrl: string | undefined | null): string {
  try {
    return new URL(String(baseUrl ?? '')).hostname.toLowerCase();
  }
  catch {
    return '';
  }
}
export function isClaudeTarget(baseUrl: string | undefined | null, model: string | undefined | null): boolean {
  const host = hostOf(baseUrl);
  if (NON_CLAUDE_VENDOR_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)))
    return false;
  if (host === 'api.anthropic.com' || host.endsWith('.anthropic.com'))
    return true;
  return /claude|opus|sonnet|haiku/i.test(String(model ?? ''));
}
export function shouldUseClaudeCodeIdentity(baseUrl: string | undefined | null, mode: 'auto' | 'on' | 'off' | undefined): boolean {
  if (mode === 'on')
    return true;
  if (mode === 'off')
    return false;
  const host = hostOf(baseUrl);
  if (!host || host === 'api.anthropic.com' || host.endsWith('.anthropic.com'))
    return false;
  return !NON_CLAUDE_VENDOR_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}
export function getClaudeCodeUserAgent(): string {
  return `claude-cli/${VERSION} (external, cli)`;
}

/** Anthropic API key 使用 x-api-key；OAuth access token 使用 Authorization: Bearer。 */
export function isAnthropicOAuthToken(token: string | undefined | null): boolean {
  return /^sk-ant-(oat|ort)/i.test(String(token ?? '').trim());
}

/**
 * 给一个 Anthropic 凭据, 返回该发的认证头。
 *
 *   API key → x-api-key (官方标准) + Authorization: Bearer (只认 Bearer 的定制代理)
 *             \+ anthropic-api-key (历史上一直在发, 留着以免打掉某个只认它的代理)
 *   OAuth   → 只发 Bearer
 */
export function buildAnthropicAuthHeaders(token: string | undefined | null): Record<string, string> {
  /* token 可能是 undefined —— provider 在"还没配 key"时照样会构造并 buildHeaders。
   * 旧代码用的是模板字符串 (`Bearer ${undefined}`), 不会炸; 我第一版直接 .trim()
   * 把 AnthropicProvider 的构造函数打成 TypeError, 三条 reducer 测试当场变红。
   * 认证头拼不出来该由服务端回 401, 不该在客户端构造阶段抛。 */
  const t = String(token ?? '').trim();
  if (isAnthropicOAuthToken(t)) {
    return { Authorization: `Bearer ${t}` };
  }
  return {
    'x-api-key': t,
    'anthropic-api-key': t,
    Authorization: `Bearer ${t}`,
  };
}

export function buildClaudeCodeHeaders({
  authToken,
  betaFeatures = DEFAULT_CLAUDE_CODE_BETA_FEATURES,
  helperMethod = 'stream',
}: {
  authToken: string;
  betaFeatures?: string[];
  helperMethod?: string;
}): Record<string, string> {
  return {
    Accept: 'application/json',
    'X-Stainless-Retry-Count': '0',
    'X-Stainless-Timeout': '600',
    'X-Stainless-Lang': 'js',
    'X-Stainless-Package-Version': CLAUDE_CODE_STAINLESS_PACKAGE_VERSION,
    'X-Stainless-OS': getStainlessOs(),
    'X-Stainless-Arch': normalizeStainlessArch(),
    'X-Stainless-Runtime': 'node',
    'X-Stainless-Runtime-Version': process.version,
    'anthropic-dangerous-direct-browser-access': 'true',
    'anthropic-version': '2023-06-01',
    'x-app': 'cli',
    'User-Agent': getClaudeCodeUserAgent(),
    /* 伪装 Claude Code 时凭据通常是 OAuth token (只能走 Bearer); 但用户把第三方网关的
     * API key 配在这条路上是常态 (claudeCodeMode 默认 auto, 非官方域一律走这儿),
     * 那种情况必须补上 x-api-key —— 否则严格照官方实现的网关 100% 401。见
     * buildAnthropicAuthHeaders 的说明。 */
    ...buildAnthropicAuthHeaders(authToken),
    'Content-Type': 'application/json',
    'anthropic-beta': betaFeatures.join(','),
    'x-stainless-helper-method': helperMethod,
    'accept-language': '*',
    'sec-fetch-mode': 'cors',
    'accept-encoding': 'br, gzip, deflate',
  };
}

export function buildClaudePromptCacheControl(options?: { scope?: 'global'; ttl?: '1h' }) {
  return {
    type: 'ephemeral' as const,
    ...(options?.ttl ? { ttl: options.ttl } : {}),
    ...(options?.scope ? { scope: options.scope } : {}),
  };
}

export function splitSystemPromptForCaching(system: string): SystemPromptCacheBlock[] {
  const trimmed = system.trim();
  if (!trimmed) return [];

  const boundaryIndex = Math.max(
    trimmed.lastIndexOf('\n## 环境\n- 工作目录:'),
    trimmed.lastIndexOf('\n## Environment\n- Working directory:'),
  );

  if (boundaryIndex <= 0) {
    return [{ text: trimmed, cacheMode: 'default' }];
  }

  const stablePart = trimmed.slice(0, boundaryIndex).trim();
  const dynamicPart = trimmed.slice(boundaryIndex).trim();
  const blocks: SystemPromptCacheBlock[] = [];

  if (stablePart) blocks.push({ text: stablePart, cacheMode: 'global' });
  if (dynamicPart) blocks.push({ text: dynamicPart, cacheMode: 'none' });

  return blocks.length > 0 ? blocks : [{ text: trimmed, cacheMode: 'default' }];
}

function getStainlessOs(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case 'darwin':
      return 'MacOS';
    case 'win32':
      return 'Windows';
    default:
      return 'Linux';
  }
}

function normalizeStainlessArch(arch: string = process.arch): string {
  return arch === 'x64' || arch === 'arm64' ? arch : arch;
}
