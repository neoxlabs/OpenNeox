import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentTypeRegistry } from '../agentTypeRegistry.js';

describe('AgentTypeRegistry · plugin .md loading', () => {
  let reg: AgentTypeRegistry;
  let tmp: string;

  beforeEach(() => {
    reg = new AgentTypeRegistry();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-agent-types-'));
  });

  it('loads .md agent with frontmatter + body → systemPromptPrefix', async () => {
    fs.writeFileSync(path.join(tmp, 'slides.md'), `---
name: slides-writer
description: Generate slide outlines
tools: [readfile, grep]
maxTurns: 10
model: gpt-4
---
You are an expert slide writer. Output PowerPoint-ready sections.`);

    const count = await reg.loadFromDirectory(tmp, 'plugin', 'ppt-maker');
    expect(count).toBe(1);

    const def = reg.get('slides-writer');
    expect(def).toBeDefined();
    expect(def!.description).toBe('Generate slide outlines');
    expect(def!.tools).toEqual(['readfile', 'grep']);
    expect(def!.maxTurns).toBe(10);
    expect(def!.model).toBe('gpt-4');
    expect(def!.source).toBe('plugin');
    expect(def!.pluginName).toBe('ppt-maker');
    expect(def!.systemPromptPrefix).toContain('expert slide writer');
  });

  it('still supports .json (backward compat)', async () => {
    fs.writeFileSync(path.join(tmp, 'reviewer.json'), JSON.stringify({
      name: 'security-reviewer',
      description: 'Security-focused reviewer',
      tools: ['readfile'],
      maxTurns: 5,
    }));
    const count = await reg.loadFromDirectory(tmp, 'user');
    expect(count).toBe(1);
    const def = reg.get('security-reviewer');
    expect(def?.source).toBe('user');
    expect(def?.pluginName).toBeUndefined();
  });

  it('supports block-array YAML syntax', async () => {
    fs.writeFileSync(path.join(tmp, 'multi.md'), `---
name: multi-tool
description: demo
tools:
  - readfile
  - grep
  - execute_shell
---
body content`);
    await reg.loadFromDirectory(tmp, 'plugin', 'demo');
    expect(reg.get('multi-tool')?.tools).toEqual(['readfile', 'grep', 'execute_shell']);
  });

  it('unregisterPlugin removes only plugin-sourced agents', async () => {
    fs.writeFileSync(path.join(tmp, 'a.md'), `---
name: a
description: x
---
body`);
    fs.writeFileSync(path.join(tmp, 'b.json'), JSON.stringify({ name: 'b', description: 'y' }));

    await reg.loadFromDirectory(tmp, 'plugin', 'p1');
    expect(reg.get('a')?.source).toBe('plugin');

    // builtin count 不会被清
    const before = reg.size;
    const removed = reg.unregisterPlugin('p1');
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(reg.get('a')).toBeUndefined();
    // builtin 保留
    expect(reg.size).toBeLessThan(before);
    expect(reg.get('explorer')).toBeDefined();
  });

  it('rejects .md with missing name field', async () => {
    fs.writeFileSync(path.join(tmp, 'bad.md'), `---
description: has no name
---
body`);
    const count = await reg.loadFromDirectory(tmp, 'plugin', 'bad');
    expect(count).toBe(0);
  });
});
