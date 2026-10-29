import { describe, expect, it } from 'vitest';
import { pluginLogoFromToolName } from '../pluginBrandAssets.js';

describe('pluginLogoFromToolName', () => {
  it('用命名空间最长前缀对上工具全名', () => {
    expect(pluginLogoFromToolName('notion_search')).toBeTruthy();
    expect(pluginLogoFromToolName('figma_get_file')).toBeTruthy();
    expect(pluginLogoFromToolName('codex_delegate')).toBeTruthy();
    expect(pluginLogoFromToolName('slack_search')).toBeTruthy();
    expect(pluginLogoFromToolName('gmail_send')).toBeTruthy();
    expect(pluginLogoFromToolName('gcal_list_events')).toBeTruthy();
    expect(pluginLogoFromToolName('gdrive_export_file')).toBeTruthy();
    expect(pluginLogoFromToolName('ocal_list_events')).toBeTruthy();
    expect(pluginLogoFromToolName('outlook_search')).toBeTruthy();
    expect(pluginLogoFromToolName('telegram_send_message')).toBeTruthy();
    expect(pluginLogoFromToolName('github_search_issues')).toBeTruthy();
    expect(pluginLogoFromToolName('todoist_search_tasks')).toBeTruthy();
    expect(pluginLogoFromToolName('stripe_search_customers')).toBeTruthy();
    expect(pluginLogoFromToolName('cloudflare_list_zones')).toBeTruthy();
    expect(pluginLogoFromToolName('resend_send_email')).toBeTruthy();
    expect(pluginLogoFromToolName('monday_list_items')).toBeTruthy();
    expect(pluginLogoFromToolName('shopify_list_orders')).toBeTruthy();
    expect(pluginLogoFromToolName('azure_devops_list_projects')).toBeTruthy();
  });

  it('MCP 前缀也能对上', () => {
    expect(pluginLogoFromToolName('mcp__notion__search')).toBeTruthy();
  });

  it('对不上的工具没有 logo, 不瞎猜', () => {
    expect(pluginLogoFromToolName('read_file')).toBeUndefined();
    expect(pluginLogoFromToolName('execute_shell')).toBeUndefined();
    expect(pluginLogoFromToolName('')).toBeUndefined();
  });
});
