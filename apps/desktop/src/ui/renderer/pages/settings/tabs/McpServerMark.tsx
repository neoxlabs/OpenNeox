import React from 'react';


import { pluginLogoFromToolName, pluginLogoUrl } from '../../plugins/pluginBrandAssets.js';
import { mcpPresets } from './McpPresets';

/** 有官方素材的几个 —— 匹配服务器名/命令里的关键词 */
const KNOWN: Array<[RegExp, string]> = [
  [/figma/i, 'figma'],
  [/notion/i, 'notion'],
  [/claude[-_ ]?code/i, 'claude-code'],
  [/codex/i, 'codex'],
  [/slack/i, 'slack'],
  [/github/i, 'github'],
  [/gmail/i, 'gmail'],
  [/linear/i, 'linear'],
  [/sentry/i, 'sentry'],
  [/discord/i, 'discord'],
  [/telegram/i, 'telegram'],
  [/atlassian|jira|confluence/i, 'atlassian'],
  [/asana/i, 'asana'],
  [/airtable/i, 'airtable'],
  [/gitlab/i, 'gitlab'],
  [/vercel/i, 'vercel'],
  [/playwright/i, 'playwright'],
  [/outlook/i, 'outlook'],
  [/teams/i, 'teams'],
  [/zendesk/i, 'zendesk'],
  [/shopify/i, 'shopify'],
  [/monday/i, 'monday'],
  [/resend/i, 'resend'],
  [/netlify/i, 'netlify'],
  [/datadog/i, 'datadog'],
  [/pagerduty/i, 'pagerduty'],
];

const PRESET_HINTS: Array<[RegExp, string]> = [
  [/server-filesystem|^filesystem\b/i, 'filesystem'],
  [/context7/i, 'context7'],
  [/deepwiki/i, 'deepwiki'],
  [/sequential-thinking/i, 'sequential-thinking'],
  [/lark-mcp|飞书|feishu|lark/i, 'feishu'],
  [/amap|高德/i, 'amap'],
];

/** 名字 → 一个稳定的色相。同名永远同色。 */
function hueOf(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i += 1) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}

/** 首字母 —— 中文取第一个字, 英文取首字母大写, 都取不到用 · */
function initialOf(name: string): string {
  const c = name.trim()[0];
  if (!c) return '·';
  return /[a-z]/i.test(c) ? c.toUpperCase() : c;
}

export const McpServerMark: React.FC<{ name: string; hint?: string }> = ({ name, hint }) => {
  const probe = `${name} ${hint ?? ''}`;
  const known = KNOWN.find(([re]) => re.test(probe));
  const url = (known ? pluginLogoUrl(known[1]) : undefined)
    ?? pluginLogoFromToolName(name)
    ?? pluginLogoUrl(name);
  if (url) {
    return (
      <span className="mcp-server-mark mcp-server-mark--logo" aria-hidden>
        <img src={url} alt="" />
      </span>
    );
  }
  /* 「常用服务」里那几个 (本地文件 / Context7 / DeepWiki / 飞书 / 高德 …): 用常用服务卡上同一枚标 */
  const preset = PRESET_HINTS.find(([re]) => re.test(probe));
  const presetLogo = preset ? mcpPresets(true).find((p) => p.id === preset[1])?.logo : undefined;
  if (presetLogo) {
    return <span className="mcp-server-mark mcp-server-mark--logo mcp-server-mark--preset" aria-hidden>{presetLogo}</span>;
  }
  const hue = hueOf(name);
  return (
    <span
      className="mcp-server-mark"
      aria-hidden
      style={{
        '--mark-h': String(hue),
      } as React.CSSProperties}
    >
      {initialOf(name)}
    </span>
  );
};
