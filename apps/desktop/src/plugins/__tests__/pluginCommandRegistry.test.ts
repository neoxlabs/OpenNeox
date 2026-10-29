import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PluginCommandRegistry } from '../pluginCommandRegistry.js';

describe('PluginCommandRegistry', () => {
  let reg: PluginCommandRegistry;
  let tmpDir: string;

  beforeEach(() => {
    reg = new PluginCommandRegistry();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-plugin-cmd-'));
  });

  it('register + find + list', () => {
    reg.register({
      name: '/hello',
      description: 'say hi',
      promptTemplate: 'Hi $1',
      pluginName: 'demo',
    });
    expect(reg.find('/hello')?.description).toBe('say hi');
    expect(reg.find('/HELLO')).toBeTruthy();  // 大小写归一
    expect(reg.list()).toHaveLength(1);
  });

  it('loadFromPath parses .md with frontmatter', async () => {
    const md = `---
name: /summarize
description: Summarize a file
category: Plugin
usage: "/summarize <path>"
allowed-tools: [readfile, grep]
---
Please summarize $1 in 3 sentences.

Full args: $ARGUMENTS`;
    fs.writeFileSync(path.join(tmpDir, 'summarize.md'), md);

    const count = await reg.loadFromPath(tmpDir, 'demo');
    expect(count).toBe(1);

    const def = reg.find('/summarize');
    expect(def).toBeDefined();
    expect(def!.description).toBe('Summarize a file');
    expect(def!.category).toBe('Plugin');
    expect(def!.allowedTools).toEqual(['readfile', 'grep']);
    expect(def!.promptTemplate).toContain('Please summarize $1');
  });

  it('parseAndExpand replaces $1 / $2 / $ARGUMENTS', () => {
    reg.register({
      name: '/greet',
      description: '',
      promptTemplate: 'Hello $1, from $2. Full: [$ARGUMENTS]',
      pluginName: 'demo',
    });
    const inv = reg.parseAndExpand('/greet Alice Bob');
    expect(inv).toBeTruthy();
    expect(inv!.prompt).toBe('Hello Alice, from Bob. Full: [Alice Bob]');
    expect(inv!.argumentsList).toEqual(['Alice', 'Bob']);
    expect(inv!.argumentsRaw).toBe('Alice Bob');
  });

  it('parseAndExpand returns null for unknown command', () => {
    expect(reg.parseAndExpand('/nope foo')).toBeNull();
  });

  it('unregisterPlugin removes only that plugin', () => {
    reg.register({ name: '/a', description: '', promptTemplate: '', pluginName: 'p1' });
    reg.register({ name: '/b', description: '', promptTemplate: '', pluginName: 'p2' });
    expect(reg.unregisterPlugin('p1')).toBe(1);
    expect(reg.list().map(c => c.name)).toEqual(['/b']);
  });

  it('falls back to filename when frontmatter omits name', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'my-cmd.md'),
      'just a plain body, no frontmatter at all',
    );
    await reg.loadFromPath(tmpDir, 'demo');
    expect(reg.find('/my-cmd')).toBeTruthy();
  });
});
