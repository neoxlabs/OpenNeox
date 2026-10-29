/**
 * 官方插件品牌 mark —— 市场卡 / 设置行 / timeline 工具行共用
 *
 *   素材在 `assets/plugin-logos/{id}.{png|svg}`, vite 编译时 bundle 成 URL。
 *   市场卡在插件还没下载时就要显示 logo, 所以查的是本地资产表, 不是包内 icon。
 *
 *   timeline 工具名是 `namespace_tool` (如 slack_search)。用最长前缀对上
 *   命名空间, 再走别名表落到文件名。对不上就没有 logo, 退回原来的线性 glyph。
 */

const LOGO_URLS = import.meta.glob<string>(
  '../../assets/plugin-logos/*.{png,svg}',
  { eager: true, import: 'default', query: '?url' },
);

const logoById: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [p, url] of Object.entries(LOGO_URLS)) {
    const id = (p.split('/').pop() || '').replace(/\.(png|svg)$/i, '');
    if (id && url) out[id] = url;
  }
  return out;
})();

/** 插件名 / 命名空间 → 资产文件名 (无扩展名) */
export const PLUGIN_LOGO_ALIASES: Record<string, string> = {
  'outlook-calendar': 'outlook',
  ocal: 'outlook',
  gcal: 'google-calendar',
  gdrive: 'google-drive',
  jira: 'atlassian',
  confluence: 'atlassian',
  claude_code: 'claude-code',
  kimi_code: 'kimi-code',
  deepseek_harness: 'deepseek-harness',
  azure_devops: 'azure-devops',
  incident_io: 'incident-io',
  customer_io: 'customer-io',
};

/** 连接器命名空间, 按长度降序 —— 先匹配 google_calendar 再匹配 google */
const NAMESPACES = [
  'google_calendar',
  'google_drive',
  'outlook_calendar',
  'github_pr_agent',
  'deepseek_harness',
  'claude_code',
  'kimi_code',
  'opencode',
  'droid',
  'cline',
  'computer_use',
  'azure_devops',
  'incident_io',
  'customer_io',
  'digitalocean',
  'planetscale',
  'cloudflare',
  'pagerduty',
  'smartsheet',
  'contentful',
  'mailchimp',
  'chargebee',
  'freshdesk',
  'helpscout',
  'pipedrive',
  'fireflies',
  'buildkite',
  'circleci',
  'postmark',
  'typeform',
  'webflow',
  'atlassian',
  'airtable',
  'telegram',
  'discord',
  'playwright',
  'newrelic',
  'opsgenie',
  'posthog',
  'datadog',
  'algolia',
  'shopify',
  'grafana',
  'netlify',
  'railway',
  'bitbucket',
  'shortcut',
  'supabase',
  'harvest',
  'klaviyo',
  'monday',
  'zendesk',
  'sentry',
  'gitlab',
  'vercel',
  'github',
  'linear',
  'outlook',
  'gdrive',
  'notion',
  'figma',
  'slack',
  'gmail',
  'teams',
  'asana',
  'codex',
  'gcal',
  'ocal',
  'todoist',
  'trello',
  'clickup',
  'hubspot',
  'intercom',
  'stripe',
  'resend',
  'render',
  'attio',
  'coda',
  'neon',
  'toggl',
  'close',
  'front',
  'wrike',
  'paddle',
  'sanity',
].sort((a, b) => b.length - a.length);

function resolveId(name: string): string {
  const key = name.trim().toLowerCase().replace(/_/g, '-');
  return PLUGIN_LOGO_ALIASES[name] || PLUGIN_LOGO_ALIASES[key] || key;
}

export function pluginLogoUrl(name: string | undefined | null): string | undefined {
  if (!name) return undefined;
  return logoById[resolveId(name)] ?? logoById[name] ?? undefined;
}

/**
 * 从 Agent 工具全名反查官方 logo。
 * `slack_search` / `gcal_list_events` / `claude_code_delegate` 都能对上。
 */
export function pluginLogoFromToolName(toolName: string | undefined | null): string | undefined {
  if (!toolName) return undefined;
  const raw = toolName.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (raw.startsWith('mcp__')) {
    const inner = raw.slice(5).split('__')[0] ?? '';
    return pluginLogoUrl(inner);
  }
  for (const ns of NAMESPACES) {
    if (raw === ns || raw.startsWith(`${ns}_`)) {
      return pluginLogoUrl(ns.replace(/_/g, '-')) ?? pluginLogoUrl(ns);
    }
  }
  return pluginLogoUrl(raw);
}

export function knownPluginLogoIds(): string[] {
  return Object.keys(logoById).sort();
}
