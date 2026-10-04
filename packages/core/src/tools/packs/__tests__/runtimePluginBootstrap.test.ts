import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureRuntimePluginsLoaded,
  setRuntimePluginBootstrap,
  toolPackRegistry,
} from '../toolPack.js';

afterEach(() => {
  setRuntimePluginBootstrap(null);
});

describe('runtime plugin bootstrap hook', () => {
  it('没 set 时是 no-op', async () => {
    await expect(ensureRuntimePluginsLoaded()).resolves.toBeUndefined();
  });

  it('set 之后 ensure 会跑到, 失败不抛', async () => {
    let calls = 0;
    setRuntimePluginBootstrap(() => {
      calls += 1;
      throw new Error('boom');
    });
    await expect(ensureRuntimePluginsLoaded()).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  it('resolve 认 connector 短名', () => {
    toolPackRegistry.register({
      id: 'connector:google-calendar',
      label: 'Google Calendar',
      icon: '🔌',
      description: 'Google Calendar connector tools for resolve alias testing',
      group: 'community',
      tier: 'extended',
      toolNames: ['gcal_list_events'],
    });
    try {
      expect(toolPackRegistry.get('google-calendar')).toBeUndefined();
      expect(toolPackRegistry.resolve('google-calendar')?.id).toBe('connector:google-calendar');
      expect(toolPackRegistry.resolve('connector:google-calendar')?.id).toBe('connector:google-calendar');
    } finally {
      toolPackRegistry.unregister('connector:google-calendar');
    }
  });
});
