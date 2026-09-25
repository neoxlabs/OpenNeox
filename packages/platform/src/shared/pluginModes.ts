/**
 * 官方插件 × 模式可见性
 *
 *   市场「热门」按当前用途模式藏卡, 已安装的仍列出 (不然卸不掉)。
 *   表里没有的名字默认全模式可见 —— 第三方 / 本机导入不误伤。
 *
 *   Work 不出现 git/项目/委派; Code 全开办公连接器 (工程师也用 Slack / Gmail)。
 */

export type PluginAudience = 'work' | 'code';

export const PLUGIN_AUDIENCE: Record<string, readonly PluginAudience[]> = {
  notion: ['work', 'code'],
  figma: ['work', 'code'],
  'computer-use': ['work', 'code'],

  slack: ['work', 'code'],
  gmail: ['work', 'code'],
  'google-calendar': ['work', 'code'],
  'google-drive': ['work', 'code'],
  outlook: ['work', 'code'],
  'outlook-calendar': ['work', 'code'],
  teams: ['work', 'code'],
  asana: ['work', 'code'],
  airtable: ['work', 'code'],
  discord: ['work'],
  telegram: ['work'],
  todoist: ['work', 'code'],
  trello: ['work', 'code'],
  clickup: ['work', 'code'],
  hubspot: ['work', 'code'],
  intercom: ['work', 'code'],
  stripe: ['work', 'code'],

  resend: ['work', 'code'],
  postmark: ['work', 'code'],
  zendesk: ['work', 'code'],
  freshdesk: ['work', 'code'],
  pipedrive: ['work', 'code'],
  attio: ['work', 'code'],
  coda: ['work', 'code'],
  monday: ['work', 'code'],
  shopify: ['work', 'code'],
  helpscout: ['work', 'code'],
  close: ['work', 'code'],
  front: ['work', 'code'],
  typeform: ['work', 'code'],
  harvest: ['work', 'code'],
  toggl: ['work', 'code'],
  webflow: ['work', 'code'],
  contentful: ['work', 'code'],
  sanity: ['work', 'code'],
  klaviyo: ['work', 'code'],
  mailchimp: ['work', 'code'],
  'customer-io': ['work', 'code'],
  paddle: ['work', 'code'],
  chargebee: ['work', 'code'],
  wrike: ['work', 'code'],
  smartsheet: ['work', 'code'],
  fireflies: ['work', 'code'],

  github: ['code'],
  linear: ['code'],
  atlassian: ['code'],
  sentry: ['code'],
  gitlab: ['code'],
  vercel: ['code'],
  cloudflare: ['code'],
  supabase: ['code'],
  playwright: ['code'],
  'github-pr-agent': ['code'],
  bitbucket: ['code'],
  'azure-devops': ['code'],
  netlify: ['code'],
  render: ['code'],
  railway: ['code'],
  pagerduty: ['code'],
  datadog: ['code'],
  posthog: ['code'],
  neon: ['code'],
  planetscale: ['code'],
  circleci: ['code'],
  buildkite: ['code'],
  digitalocean: ['code'],
  shortcut: ['code'],
  newrelic: ['code'],
  opsgenie: ['code'],
  'incident-io': ['code'],
  grafana: ['code'],
  algolia: ['code'],
  codex: ['code'],
  'claude-code': ['code'],
};

/**
 * 市场「热门」白名单。目录还会继续涨, 热门只放用户真会先装的那一档。
 * 「全部」芯片看全量; 表外的第三方默认不算热门。
 */
export const MAINSTREAM_PLUGIN_NAMES: ReadonlySet<string> = new Set([
  'notion',
  'figma',
  'slack',
  'gmail',
  'google-calendar',
  'google-drive',
  'outlook',
  'outlook-calendar',
  'teams',
  'github',
  'linear',
  'asana',
  'airtable',
  'discord',
  'telegram',
  'todoist',
  'trello',
  'clickup',
  'hubspot',
  'stripe',
  'gitlab',
  'vercel',
  'sentry',
  'atlassian',
  'intercom',
  'monday',
  'shopify',
  'zendesk',
  'resend',
  'netlify',
  'computer-use',
]);

export function isMainstreamPlugin(name: string | null | undefined): boolean {
  return Boolean(name && MAINSTREAM_PLUGIN_NAMES.has(name));
}

export function audienceForAgentMode(mode: string | null | undefined): PluginAudience {
  if (mode === 'work' || mode === 'assistant') return 'work';
  return 'code';
}

export function isPluginVisibleInMode(
  name: string | null | undefined,
  mode: string | null | undefined,
): boolean {
  if (!name) return true;
  const allowed = PLUGIN_AUDIENCE[name];
  if (!allowed) return true;
  return allowed.includes(audienceForAgentMode(mode));
}
