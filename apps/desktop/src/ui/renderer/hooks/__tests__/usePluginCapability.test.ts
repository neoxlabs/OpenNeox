import { describe, it, expect } from 'vitest';
import { listDeclaresCapability, SETTINGS_TAB_BY_CAPABILITY } from '../usePluginCapability';

describe('listDeclaresCapability — 渲染端的插件能力闸', () => {
  const gh = { name: 'github-pr-agent', enabled: true, manifest: { capabilities: ['github-pr-agent'] } };

  it('装了且启用 → 开', () => {
    expect(listDeclaresCapability([gh], 'github-pr-agent')).toBe(true);
  });
  it('装了但停用 → 关 (跟 core 读注册表的判据一致)', () => {
    expect(listDeclaresCapability([{ ...gh, enabled: false }], 'github-pr-agent')).toBe(false);
  });
  it('别的插件 / 没有 manifest / 列表坏了 → 关', () => {
    expect(listDeclaresCapability([{ name: 'figma', enabled: true, manifest: { capabilities: [] } }], 'github-pr-agent')).toBe(false);
    expect(listDeclaresCapability([{ name: 'x', enabled: true }], 'github-pr-agent')).toBe(false);
    expect(listDeclaresCapability(undefined, 'github-pr-agent')).toBe(false);
  });
  it('能力 → 设置页映射', () => {
    expect(SETTINGS_TAB_BY_CAPABILITY['github-pr-agent']).toBe('github');
  });
});
