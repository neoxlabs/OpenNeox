/**
 * When a user names an installed connector, unlock its tools before normal discovery.
 *
 *   Life / Work 不把 connector 放进常驻面 (插件数量不由我们控), 全靠 tool_search。
 *   用户写了 `gcal_list_events` / `google-calendar` 还要先搜一轮, 搜空就改走
 *   An explicit connector name is a direct intent signal, like browser intent pre-unlocking.
 */
import { toolPackRegistry } from './toolPack.js';

const SKIP_KEYWORDS = new Set(['connector', 'plugin', 'pack']);

export function collectConnectorToolsForPrompt(prompt: string): string[] {
  const q = String(prompt || '').toLowerCase();
  if (!q.trim()) return [];

  const names: string[] = [];
  for (const pack of toolPackRegistry.getAll()) {
    if (!pack.id.startsWith('connector:') && !pack.id.startsWith('plugin:')) continue;
    const short = pack.id.replace(/^(connector|plugin|extagent):/, '').toLowerCase();
    const needles = [
      short,
      short.replace(/-/g, ' '),
      short.replace(/-/g, ''),
      ...pack.toolNames.map((n) => n.toLowerCase()),
      ...(pack.keywords ?? [])
        .map((k) => k.toLowerCase())
        .filter((k) => k.length >= 3 && !SKIP_KEYWORDS.has(k)),
    ];
    let hit = needles.some((n) => n.length >= 3 && q.includes(n));
    if (!hit && looksLikeCalendarPack(pack.toolNames, short)) {
      hit = /gcal|google\s*calendar|谷歌日历|谷歌日程|google\s*日历/.test(q);
    }
    if (hit) names.push(...pack.toolNames);
  }
  if (!names.length) {
    const store = toolPackRegistry.get(PLUGIN_STORE_PACK_ID);
    if (store && (SERVICE_MENTION.test(q) || STORE_INTENT.test(q))) names.push(...store.toolNames);
  }
  return [...new Set(names)];
}

const PLUGIN_STORE_PACK_ID = 'plugin-store';

/** 常见第三方服务 / SaaS —— 用户点了名, 手上又没有它的工具, 第一步该查商店 */
const SERVICE_MENTION = new RegExp([
  'jira', 'confluence', 'atlassian', 'slack', 'figma', 'asana', 'trello', 'clickup', 'monday\\.com', 'airtable',
  'notion', 'linear', 'github', 'gitlab', 'bitbucket', 'sentry', 'datadog', 'grafana', 'pagerduty', 'zendesk', 'intercom',
  'hubspot', 'salesforce', 'stripe', 'shopify', 'discord', 'telegram', 'teams', 'outlook', 'gmail', 'google\\s*(drive|docs|sheets|calendar)',
  'dropbox', 'onedrive', 'sharepoint', 'cloudflare', 'vercel', 'supabase', 'todoist', 'zoom',
  '飞书', '钉钉', '企业微信', '语雀', '腾讯文档', '石墨', '金山文档', 'wps', '禅道', 'tapd', '企微',
].map((s) => `(?:^|[^a-z])${s}`).join('|'), 'i');

/** 直接问「有什么插件 / 能不能接上」 */
const STORE_INTENT = /插件|集成|接入|连上|打通|对接|integration|plugin|marketplace|connect (?:to|my)/i;

function looksLikeCalendarPack(toolNames: string[], shortId: string): boolean {
  return shortId.includes('calendar') || toolNames.some((n) => n.startsWith('gcal_'));
}
