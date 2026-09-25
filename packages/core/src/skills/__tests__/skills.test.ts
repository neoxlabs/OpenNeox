import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SkillLoader } from '../loader.js';
import { SkillRegistry, onSkillsLoaded } from '../registry.js';
import { SkillExecutor } from '../executor.js';
import type { Skill } from '@neoxlabs/kernel/skills/types.js';

vi.mock('../history.js', () => ({
  recordExecution: vi.fn(),
  readHistory: vi.fn(() => []),
  clearHistory: vi.fn(),
}));

// ─── Loader 测试 ───

describe('SkillLoader', () => {
  const loader = new SkillLoader();

  describe('parseSkillFile', () => {
    it('顶层块列表 (paths: 换行 - item) 解析成数组, 引号剥掉 (2026-09-10 #5 真机抓到)', () => {
      const { metadata } = loader.parseSkillFile(`---
name: go-rules
description: d
paths:
  - "**/*.go"
  - 'cmd/**'
neox:
  aliases:
    - gr
---
body`);
      expect(metadata.paths).toEqual(['**/*.go', 'cmd/**']);
      expect(metadata.neox?.aliases).toEqual(['gr']);
    });

    it('parses basic frontmatter', () => {
      const content = `---
name: "Test Skill"
description: "A test skill"
user-invocable: true
---

Some content here`;

      const { metadata, body } = loader.parseSkillFile(content);
      expect(metadata.name).toBe('Test Skill');
      expect(metadata.description).toBe('A test skill');
      expect(metadata['user-invocable']).toBe(true);
      expect(body.trim()).toBe('Some content here');
    });

    it('parses new fields: model, effort, paths', () => {
      const content = `---
name: "Advanced Skill"
description: "With new fields"
model: "gpt-4"
effort: "high"
paths: "src/**/*.ts, test/**/*.ts"
shell: "bash"
when_to_use: "When you need TypeScript help"
argument-hint: "<file>"
version: "1.0.0"
hide-from-slash-command-tool: "true"
---

Instructions`;

      const { metadata } = loader.parseSkillFile(content);
      // validateMetadata is called in loadSkill, not parseSkillFile
      // but we can check raw metadata
      expect(metadata.model).toBe('gpt-4');
      expect(metadata.effort).toBe('high');
      expect(metadata.paths).toBe('src/**/*.ts, test/**/*.ts');
      expect(metadata.shell).toBe('bash');
      expect(metadata.when_to_use).toBe('When you need TypeScript help');
      expect(metadata['argument-hint']).toBe('<file>');
      expect(metadata.version).toBe('1.0.0');
    });

    it('parses paths as array', () => {
      const content = `---
name: "Multi Path"
description: "Multiple paths"
paths: [src/*.ts, test/*.ts]
---

Body`;
      const { metadata } = loader.parseSkillFile(content);
      expect(metadata.paths).toEqual(['src/*.ts', 'test/*.ts']);
    });

    it('handles content without frontmatter', () => {
      const content = 'Just plain content';
      const { metadata, body } = loader.parseSkillFile(content);
      expect(Object.keys(metadata)).toHaveLength(0);
      expect(body).toBe('Just plain content');
    });
  });
});

// ─── Registry 测试 ───

describe('SkillRegistry', () => {
  let registry: SkillRegistry;

  const makeSkill = (overrides: Partial<Skill> = {}): Skill => ({
    id: 'test-skill',
    path: '/fake/SKILL.md',
    source: 'user',
    metadata: {
      name: 'Test Skill',
      description: 'A test skill',
      'user-invocable': true,
      neox: { aliases: ['ts'] },
    },
    content: 'Do something',
    ...overrides,
  });

  beforeEach(() => {
    registry = new SkillRegistry();
  });

  describe('register & find', () => {
    it('registers and finds by id', () => {
      registry.register(makeSkill());
      expect(registry.find('test-skill')).toBeDefined();
      expect(registry.size).toBe(1);
    });

    it('finds by alias', () => {
      registry.register(makeSkill());
      expect(registry.find('ts')).toBeDefined();
    });

    it('finds by case-insensitive name', () => {
      registry.register(makeSkill());
      expect(registry.find('TEST-SKILL')).toBeDefined();
    });
  });

  describe('realpath dedup', () => {
    it('skips duplicate fileIdentity', () => {
      registry.register(makeSkill({ fileIdentity: '/real/path/SKILL.md' }));
      registry.register(makeSkill({
        id: 'test-skill-2',
        fileIdentity: '/real/path/SKILL.md', // same realpath
      }));

      expect(registry.size).toBe(1);
    });

    it('allows different fileIdentity', () => {
      registry.register(makeSkill({ id: 'a', fileIdentity: '/path/a/SKILL.md' }));
      registry.register(makeSkill({ id: 'b', fileIdentity: '/path/b/SKILL.md' }));

      expect(registry.size).toBe(2);
    });
  });

  describe('conditional activation', () => {
    it('skills with paths are not immediately registered', () => {
      registry.register(makeSkill({
        id: 'conditional',
        metadata: {
          name: 'Conditional',
          description: 'Only for TS',
          paths: ['src/**/*.ts'],
        },
      }));

      expect(registry.size).toBe(0);
      expect(registry.conditionalCount).toBe(1);
    });

    it('activateForPaths activates matching skills', () => {
      registry.register(makeSkill({
        id: 'ts-skill',
        metadata: {
          name: 'TS Skill',
          description: 'TypeScript helper',
          'user-invocable': true,
          paths: ['src/**/*.ts'],
          neox: { aliases: ['tsh'] },
        },
      }));

      expect(registry.find('ts-skill')).toBeUndefined();

      const activated = registry.activateForPaths(
        ['/project/src/index.ts'],
        '/project',
      );

      expect(activated).toEqual(['TS Skill']);
      expect(registry.dynamicCount).toBe(1);
      expect(registry.find('ts-skill')).toBeDefined();
      expect(registry.find('tsh')).toBeDefined(); // alias
    });

    it('激活后能拿到要灌进上下文的正文; 超长截断并指回 use_skill (2026-09-10 #5)', () => {
      registry.register(makeSkill({
        id: 'long-skill',
        content: 'x'.repeat(9000),
        metadata: { name: 'Long Skill', description: 'd', paths: ['**/*.go'] },
      }));
      expect(registry.getAutoInjectBody('Long Skill')).toBeUndefined();   /* 没激活就没有 */
      registry.activateForPaths(['/project/main.go'], '/project');
      const body = registry.getAutoInjectBody('Long Skill')!;
      expect(body.startsWith('x'.repeat(100))).toBe(true);
      expect(body.length).toBeLessThan(9000);
      expect(body).toMatch(/use_skill\("long-skill"\)/);
    });

    it('先无 workDir 初始化、再带 workDir 初始化 → 工作区技能仍会装进来 (2026-09-10 #5 真机抓到)', async () => {
      const r = new SkillRegistry();
      const spy = vi.spyOn(r as any, 'loadWorkspace').mockResolvedValue(undefined);
      vi.spyOn(r as any, 'loadBuiltin').mockResolvedValue(undefined);
      vi.spyOn(r as any, 'loadUser').mockResolvedValue(undefined);
      await r.initialize();
      await r.initialize('/ws');
      await r.initialize('/ws');          /* 同一个工作区不重复装 */
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('/ws');
    });

    it('does not activate for non-matching paths', () => {
      registry.register(makeSkill({
        id: 'py-skill',
        metadata: {
          name: 'Python Skill',
          description: 'Python helper',
          paths: ['**/*.py'],
        },
      }));

      const activated = registry.activateForPaths(
        ['/project/src/index.ts'],
        '/project',
      );

      expect(activated).toEqual([]);
      expect(registry.conditionalCount).toBe(1);
    });
  });

  describe('isEnabled gate', () => {
    it('list with enabledOnly filters disabled skills', () => {
      registry.register(makeSkill({
        id: 'enabled',
        metadata: {
          name: 'Enabled',
          description: 'Always enabled',
          'user-invocable': true,
        },
      }));
      registry.register(makeSkill({
        id: 'disabled',
        metadata: {
          name: 'Disabled',
          description: 'Currently disabled',
          'user-invocable': true,
          isEnabled: () => false,
        },
      }));

      const all = registry.list({ userInvocable: true });
      expect(all.length).toBe(2);

      const enabled = registry.list({ userInvocable: true, enabledOnly: true });
      expect(enabled.length).toBe(1);
      expect(enabled[0].id).toBe('enabled');
    });
  });

  describe('getSkillsForPrompt', () => {
    it('includes model and effort annotations', () => {
      registry.register(makeSkill({
        id: 'annotated',
        metadata: {
          name: 'Annotated',
          description: 'Has model',
          'user-invocable': true,
          model: 'gpt-4-mini',
          effort: 'low',
          argumentHint: '<file>',
          whenToUse: 'For quick tasks',
        },
      }));

      const prompt = registry.getSkillsForPrompt();
      expect(prompt).toContain('/annotated');
      expect(prompt).toContain('[model: gpt-4-mini]');
      expect(prompt).toContain('[effort: low]');
      expect(prompt).toContain('<file>');
      expect(prompt).toContain('When to use: For quick tasks');
    });

    it('excludes disableModelInvocation skills', () => {
      registry.register(makeSkill({
        id: 'hidden',
        metadata: {
          name: 'Hidden',
          description: 'Hidden from model',
          'user-invocable': true,
          disableModelInvocation: true,
        },
      }));

      const prompt = registry.getSkillsForPrompt();
      expect(prompt).not.toContain('hidden');
    });
  });

  describe('signal', () => {
    it('onSkillsLoaded fires on refresh', async () => {
      const callback = vi.fn();
      const unsub = onSkillsLoaded(callback);

      await registry.refresh();
      expect(callback).toHaveBeenCalled();

      unsub();
    });

    it('onSkillsLoaded fires on activation', () => {
      const callback = vi.fn();
      const unsub = onSkillsLoaded(callback);

      registry.register(makeSkill({
        id: 'cond',
        metadata: { name: 'Cond', description: 'X', paths: ['**/*.rs'] },
      }));

      registry.activateForPaths(['/proj/main.rs'], '/proj');
      expect(callback).toHaveBeenCalled();

      unsub();
    });
  });

  describe('getUnifiedCommands', () => {
    it('returns deduped sorted commands', () => {
      registry.register(makeSkill({ id: 'beta' }));
      registry.register(makeSkill({ id: 'alpha', fileIdentity: '/a' }));

      const commands = registry.getUnifiedCommands();
      expect(commands.length).toBe(2);
      expect(commands[0].name).toBe('alpha');
      expect(commands[1].name).toBe('beta');
    });
  });
});

// ─── Executor 测试 ───

describe('SkillExecutor', () => {
  let registry: SkillRegistry;
  let executor: SkillExecutor;

  beforeEach(() => {
    registry = new SkillRegistry();
    executor = new SkillExecutor(registry);
  });

  it('builds prompt with tool restriction', async () => {
    registry.register({
      id: 'restricted',
      path: '/fake',
      source: 'user',
      metadata: {
        name: 'Restricted',
        description: 'Limited tools',
        neox: { allowedTools: ['readfile', 'grep'] },
      },
      content: 'Do the thing',
    });

    const result = await executor.execute('restricted', '', {
      workDir: '/project',
      args: '',
      rawInput: '/restricted',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('restricted to the following tools only: readfile, grep');
    expect(result.allowedTools).toEqual(['readfile', 'grep']);
  });

  it('returns model override', async () => {
    registry.register({
      id: 'model-skill',
      path: '/fake',
      source: 'user',
      metadata: {
        name: 'Model Skill',
        description: 'Uses specific model',
        model: 'claude-haiku',
      },
      content: 'Quick task',
    });

    const result = await executor.execute('model-skill', '', {
      workDir: '/project',
      args: '',
      rawInput: '/model-skill',
    });

    expect(result.model).toBe('claude-haiku');
  });

  it('rejects disabled skill', async () => {
    registry.register({
      id: 'gated',
      path: '/fake',
      source: 'user',
      metadata: {
        name: 'Gated',
        description: 'Gated skill',
        isEnabled: () => false,
      },
      content: 'Nope',
    });

    const result = await executor.execute('gated', '', {
      workDir: '/project',
      args: '',
      rawInput: '/gated',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('disabled');
  });

  it('includes effort in prompt', async () => {
    registry.register({
      id: 'effort-skill',
      path: '/fake',
      source: 'user',
      metadata: {
        name: 'Effort',
        description: 'High effort',
        effort: 'high',
      },
      content: 'Think hard',
    });

    const result = await executor.execute('effort-skill', '', {
      workDir: '/project',
      args: '',
      rawInput: '/effort-skill',
    });

    expect(result.output).toContain('Thinking effort: high');
  });

  it('uses lazy prompt when available', async () => {
    registry.register({
      id: 'lazy',
      path: '/fake',
      source: 'builtin',
      metadata: { name: 'Lazy', description: 'Lazy loaded' },
      content: 'fallback',
      lazyPrompt: async () => 'dynamically loaded content',
    });

    const result = await executor.execute('lazy', '', {
      workDir: '/project',
      args: '',
      rawInput: '/lazy',
    });

    expect(result.output).toContain('dynamically loaded content');
    expect(result.output).not.toContain('fallback');
  });
});
