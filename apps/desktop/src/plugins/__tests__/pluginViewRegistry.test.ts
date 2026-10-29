import { describe, it, expect, beforeEach } from 'vitest';
import { PluginViewRegistry } from '../pluginViewRegistry.js';

describe('PluginViewRegistry', () => {
  let reg: PluginViewRegistry;

  beforeEach(() => {
    reg = new PluginViewRegistry();
  });

  it('registers valid views and skips invalid ones', () => {
    const count = reg.registerPluginViews({
      pluginName: 'ppt',
      installDir: '/plugins/ppt',
      views: [
        { id: 'ppt.editor', title: 'Slides', location: 'workspace', entry: 'ui/editor.html' },
        { id: 'ppt.preview', title: 'Preview', location: 'panel', entry: 'ui/preview.html', icon: 'icons/eye.svg' },
        // 无效 (缺 entry)
        { id: 'bad', title: 'Bad', location: 'sidebar' } as any,
      ],
    });
    expect(count).toBe(2);
    expect(reg.list()).toHaveLength(2);
    expect(reg.findById('ppt.editor')?.absoluteEntry).toBe('/plugins/ppt/ui/editor.html');
    expect(reg.findById('ppt.preview')?.absoluteIcon).toBe('/plugins/ppt/icons/eye.svg');
  });

  it('emoji icon is not resolved as path', () => {
    reg.registerPluginViews({
      pluginName: 'video',
      installDir: '/plugins/video',
      views: [
        { id: 'video.timeline', title: 'Timeline', location: 'panel', entry: 'index.html', icon: '🎬' },
      ],
    });
    const v = reg.findById('video.timeline');
    expect(v?.icon).toBe('🎬');
    expect(v?.absoluteIcon).toBeUndefined();
  });

  it('listByLocation returns only matching location', () => {
    reg.registerPluginViews({
      pluginName: 'p1',
      installDir: '/p1',
      views: [
        { id: 'a', title: 'A', location: 'sidebar', entry: 'a.html' },
        { id: 'b', title: 'B', location: 'workspace', entry: 'b.html' },
      ],
    });
    expect(reg.listByLocation('sidebar').map(v => v.id)).toEqual(['a']);
    expect(reg.listByLocation('workspace').map(v => v.id)).toEqual(['b']);
  });

  it('registerPluginViews replaces previous views (hot reload)', () => {
    reg.registerPluginViews({
      pluginName: 'p', installDir: '/p',
      views: [{ id: 'v1', title: 'V1', location: 'sidebar', entry: 'v1.html' }],
    });
    reg.registerPluginViews({
      pluginName: 'p', installDir: '/p',
      views: [{ id: 'v2', title: 'V2', location: 'sidebar', entry: 'v2.html' }],
    });
    expect(reg.list()).toHaveLength(1);
    expect(reg.findById('v1')).toBeUndefined();
    expect(reg.findById('v2')).toBeDefined();
  });

  it('unregisterPlugin removes only that plugin', () => {
    reg.registerPluginViews({
      pluginName: 'p1', installDir: '/p1',
      views: [{ id: 'a', title: 'untitled', location: 'sidebar', entry: 'a.html' }],
    });
    reg.registerPluginViews({
      pluginName: 'p2', installDir: '/p2',
      views: [{ id: 'b', title: 'untitled', location: 'sidebar', entry: 'b.html' }],
    });
    const removed = reg.unregisterPlugin('p1');
    expect(removed).toBe(1);
    expect(reg.list().map(v => v.id)).toEqual(['b']);
  });

  it('duplicate id within the same plugin is skipped with warning', () => {
    const count = reg.registerPluginViews({
      pluginName: 'p', installDir: '/p',
      views: [
        { id: 'same', title: 'First', location: 'sidebar', entry: 'a.html' },
        { id: 'same', title: 'Second', location: 'sidebar', entry: 'b.html' },
      ],
    });
    expect(count).toBe(1);
    expect(reg.findById('same')?.title).toBe('First');
  });

  it('serialize returns POJO shape for IPC', () => {
    reg.registerPluginViews({
      pluginName: 'p', installDir: '/p',
      views: [{
        id: 'v',
        title: 'T',
        location: 'sidebar',
        entry: 'index.html',
        icon: '📊',
        when: "resourceExtname == '.xlsx'",
        preferredSize: { width: 300 },
      }],
    });
    const serialized = reg.serialize();
    expect(serialized[0]).toMatchObject({
      pluginName: 'p',
      id: 'v',
      title: 'T',
      location: 'sidebar',
      entry: 'index.html',
      icon: '📊',
      iconIsEmoji: true,
      preferredSize: { width: 300 },
    });
  });

  it('onChange fires when views added/removed', () => {
    let fired = 0;
    reg.onChange(() => { fired++; });
    reg.registerPluginViews({
      pluginName: 'p', installDir: '/p',
      views: [{ id: 'a', title: 'untitled', location: 'sidebar', entry: 'a.html' }],
    });
    reg.unregisterPlugin('p');
    expect(fired).toBe(2);
  });
});
