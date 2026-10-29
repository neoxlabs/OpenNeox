import { describe, it, expect, beforeEach } from 'vitest';
import { PluginHookRegistry } from '../pluginHookRegistry.js';

describe('PluginHookRegistry', () => {
  let reg: PluginHookRegistry;

  beforeEach(() => {
    reg = new PluginHookRegistry();
  });

  it('registers hooks + counts them', () => {
    const count = reg.registerPluginHooks('p1', {
      preToolCall: [
        { toolPattern: 'read_file', command: 'echo ok' },
        { toolPattern: 'write_*', command: 'true' },
      ],
      postToolCall: [{ toolPattern: '*', command: 'echo post' }],
    });
    expect(count).toBe(3);
    expect(reg.hasAny()).toBe(true);
    expect(reg.hasAny('preToolCall')).toBe(true);
    expect(reg.hasAny('postToolCall')).toBe(true);
    expect(reg.list()).toHaveLength(3);
  });

  it('unregisterPlugin removes only that plugin', () => {
    reg.registerPluginHooks('p1', { preToolCall: [{ toolPattern: '*', command: 'echo p1' }] });
    reg.registerPluginHooks('p2', { preToolCall: [{ toolPattern: '*', command: 'echo p2' }] });
    expect(reg.list()).toHaveLength(2);
    const removed = reg.unregisterPlugin('p1');
    expect(removed).toBe(1);
    expect(reg.list().map(h => h.pluginName)).toEqual(['p2']);
  });

  it('preToolCall blocks tool when shell exits non-zero', async () => {
    reg.registerPluginHooks('blocker', {
      preToolCall: [{ toolPattern: 'read_file', command: 'exit 1' }],
    });
    const result = await reg.matchAndRun('preToolCall', 'read_file', {}, process.cwd());
    expect(result.blocked).toBe(true);
    expect(result.blockedBy).toBe('blocker');
    expect(result.executed).toBe(1);
  });

  it('exit 2 returns alternateResult from stdout', async () => {
    reg.registerPluginHooks('alt', {
      preToolCall: [{ toolPattern: '*', command: 'echo substitute-output && exit 2' }],
    });
    const result = await reg.matchAndRun('preToolCall', 'anything', {}, process.cwd());
    expect(result.blocked).toBe(true);
    expect(result.alternateResult).toContain('substitute-output');
  });

  it('non-matching toolPattern skips entirely', async () => {
    reg.registerPluginHooks('skip', {
      preToolCall: [{ toolPattern: 'read_file', command: 'exit 1' }],
    });
    const result = await reg.matchAndRun('preToolCall', 'grep', {}, process.cwd());
    expect(result.executed).toBe(0);
    expect(result.blocked).toBe(false);
  });

  it('glob `write_*` matches prefix but not unrelated names', async () => {
    reg.registerPluginHooks('g', {
      preToolCall: [{ toolPattern: 'write_*', command: 'exit 0' }],
    });
    const a = await reg.matchAndRun('preToolCall', 'write_file', {}, process.cwd());
    const b = await reg.matchAndRun('preToolCall', 'read_file', {}, process.cwd());
    expect(a.executed).toBe(1);
    expect(b.executed).toBe(0);
  });
});
