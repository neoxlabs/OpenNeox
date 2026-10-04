import { describe, expect, it } from 'vitest';
import { isMainstreamPlugin, isPluginVisibleInMode } from '../pluginModes.js';

describe('isPluginVisibleInMode', () => {
  it('Code 看见委派和 GitHub, Life/Work 看不见', () => {
    expect(isPluginVisibleInMode('codex', 'code')).toBe(true);
    expect(isPluginVisibleInMode('codex', 'work')).toBe(false);
    expect(isPluginVisibleInMode('codex', 'assistant')).toBe(false);
    expect(isPluginVisibleInMode('github', 'code')).toBe(true);
    expect(isPluginVisibleInMode('github', 'work')).toBe(false);
  });

  it('Work 看见 Slack / Gmail / HubSpot, 看不见 Linear / Cloudflare', () => {
    expect(isPluginVisibleInMode('slack', 'work')).toBe(true);
    expect(isPluginVisibleInMode('gmail', 'work')).toBe(true);
    expect(isPluginVisibleInMode('hubspot', 'work')).toBe(true);
    expect(isPluginVisibleInMode('todoist', 'work')).toBe(true);
    expect(isPluginVisibleInMode('linear', 'work')).toBe(false);
    expect(isPluginVisibleInMode('cloudflare', 'work')).toBe(false);
  });

  it('已下线的 Life (assistant) 按 Work 的可见面算 —— 存量会话已并进 Work', () => {
    expect(isPluginVisibleInMode('slack', 'assistant')).toBe(isPluginVisibleInMode('slack', 'work'));
    expect(isPluginVisibleInMode('gmail', 'assistant')).toBe(true);
    expect(isPluginVisibleInMode('linear', 'assistant')).toBe(false);
  });

  it('未登记的第三方默认全模式可见', () => {
    expect(isPluginVisibleInMode('my-custom', 'assistant')).toBe(true);
    expect(isPluginVisibleInMode('my-custom', 'work')).toBe(true);
  });

  it('已安装视角不该用这个函数挡卸载 —— 调用方自己跳过 installed', () => {
    expect(isPluginVisibleInMode('codex', 'assistant')).toBe(false);
  });

  it('热门白名单是主流子集, 不是目录全量', () => {
    expect(isMainstreamPlugin('slack')).toBe(true);
    expect(isMainstreamPlugin('notion')).toBe(true);
    expect(isMainstreamPlugin('datadog')).toBe(false);
    expect(isMainstreamPlugin('cloudflare')).toBe(false);
  });
});
