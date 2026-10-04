/**
 * 极简模式 (prompts/lean.ts) —— 开局要真的小, 而且不能小到把用户自己的内容丢掉。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildPrompt, registerSection, __resetForTests, type SectionInput } from '../sectionRegistry.js';
import {
  buildLeanBase, buildLeanCatalog, compactToolForLean, isLeanContext, LEAN_RESIDENT_TOOLS,
} from '../lean.js';

const input = (over: Partial<SectionInput> = {}): SectionInput => ({ workDir: '/w', language: 'zh', ...over });

describe('lean 提示词白名单', () => {
  afterEach(() => __resetForTests());

  it('lean 下只注入标了 inLean 的 section', () => {
    registerSection({ name: 'guide', layer: 'stable', compute: () => 'GUIDE' });
    registerSection({ name: 'agents-md', layer: 'context', compute: () => 'AGENTS', inLean: true });
    expect(buildPrompt(input({ promptStyle: 'lean' })).full).toBe('AGENTS');
    /* 标准模式不受 inLean 影响 */
    expect(buildPrompt(input({ promptStyle: 'layered' })).full).toBe('GUIDE\n\nAGENTS');
  });

  it('精简正文够短 (中英各 < 2500 字符)', () => {
    expect(buildLeanBase('zh').length).toBeLessThan(2500);
    expect(buildLeanBase('en').length).toBeLessThan(2500);
    /* 硬规则都还在 */
    for (const s of ['write_file', 'edit', 'unpack', 'hooks']) expect(buildLeanBase('zh')).toContain(s);
  });
});

describe('常驻工具压缩', () => {
  const tool = {
    name: 'edit',
    description: 'x'.repeat(2000),
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'long…' },
        old_string: { type: 'string', description: 'long…' },
        new_string: { type: 'string', description: 'long…' },
        replace_all: { type: 'boolean', description: 'long…' },
        hunks: { type: 'array', items: { type: 'object' }, description: 'long…' },
      },
      required: ['file_path', 'hunks'],
    },
    function: () => 'ok',
  } as any;

  it('换短描述, 只公布关键参数, required 跟着过滤', () => {
    const c = compactToolForLean(tool) as any;
    expect(c.description.length).toBeLessThan(250);
    expect(Object.keys(c.parameters.properties)).toEqual(['file_path', 'old_string', 'new_string', 'replace_all']);
    expect(c.parameters.required).toEqual(['file_path']);
    /* 执行函数原样保留 —— 压的只是 schema */
    expect(c.function).toBe(tool.function);
  });

  it('不在常驻表里的工具原样返回', () => {
    const other = { ...tool, name: 'git_status' };
    expect(compactToolForLean(other)).toBe(other);
  });

  it('六个常驻工具', () => {
    expect([...LEAN_RESIDENT_TOOLS].sort()).toEqual(['edit', 'execute_shell', 'readfile', 'search', 'search_files', 'write_file']);
  });
});

describe('unpack 目录', () => {
  it('大包只列前 6 个, extended 只列 id, 常驻工具不重复列', () => {
    const cat = buildLeanCatalog([
      { id: 'git', tier: 'primary', names: ['git_status', 'git_diff'] },
      { id: 'browser', tier: 'primary', names: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8'] },
      { id: 'code_search', tier: 'primary', names: ['readfile', 'list_directory'] },
      { id: 'debug', tier: 'extended', names: ['set_breakpoint'] },
    ]);
    expect(cat).toContain('git: git_status, git_diff');
    expect(cat).toContain('browser: b1, b2, b3, b4, b5, b6 (+2)');
    expect(cat).toContain('code_search: list_directory');
    expect(cat).not.toContain('readfile');
    expect(cat).toContain('also: debug');
  });
});

describe('开关', () => {
  afterEach(() => { delete process.env.NEOX_CONTEXT_PROFILE; });
  it('环境变量优先于配置', () => {
    expect(isLeanContext({ context: { profile: 'lean' } })).toBe(true);
    expect(isLeanContext({ context: { profile: 'full' } })).toBe(false);
    expect(isLeanContext({})).toBe(false);
    process.env.NEOX_CONTEXT_PROFILE = 'full';
    expect(isLeanContext({ context: { profile: 'lean' } })).toBe(false);
    process.env.NEOX_CONTEXT_PROFILE = 'lean';
    expect(isLeanContext({ context: { profile: 'full' } })).toBe(true);
  });
});
