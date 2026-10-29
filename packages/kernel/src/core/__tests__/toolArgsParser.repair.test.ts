import { describe, it, expect } from 'vitest';
import { parseToolArguments, normalizeToolArgumentAliases } from '../toolArgsParser.js';

describe('parseToolArguments — 空值与直接 JSON', () => {
  it('undefined / null / 空白 → 空对象成功', () => {
    for (const raw of [undefined, null, '', '   ']) {
      const r = parseToolArguments(raw as any);
      expect(r.ok).toBe(true);
      expect(r.args).toEqual({});
      expect(r.normalized).toBe('{}');
      expect(r.repaired).toBe(false);
    }
  });

  it('合法 JSON 对象直接通过，不做修复', () => {
    const r = parseToolArguments('{"a":1,"b":"x"}');
    expect(r).toEqual({ ok: true, args: { a: 1, b: 'x' }, raw: '{"a":1,"b":"x"}', normalized: '{"a":1,"b":"x"}', repaired: false });
  });

  it('数组 / 标量 / null 不是工具参数对象', () => {
    for (const raw of ['[1,2]', '"str"', '42', 'true', 'null']) {
      const r = parseToolArguments(raw);
      expect(r.ok, raw).toBe(false);
      expect(r.args).toEqual({});
    }
  });

  it('嵌套字符串里的花括号与转义不会截断', () => {
    const raw = '{"code":"function f(){ return {a:1}; }","s":"say \\"hi\\""}';
    const r = parseToolArguments(raw);
    expect(r.ok).toBe(true);
    expect(r.args.code).toBe('function f(){ return {a:1}; }');
    expect(r.args.s).toBe('say "hi"');
  });

  it('两个对象连写时只取第一个', () => {
    const r = parseToolArguments('{"a":1}{"b":2}');
    expect(r.ok).toBe(true);
    expect(r.args).toEqual({ a: 1 });
  });

  it('对象前后有解释文字时仍能解析', () => {
    const r = parseToolArguments('调用参数如下：\n{"file_path":"a.ts"}\n请执行');
    expect(r.ok).toBe(true);
    expect(r.args.file_path).toBe('a.ts');
  });
});

describe('parseToolArguments — 格式修复', () => {
  it('代码围栏', () => {
    const r = parseToolArguments('```json\n{"a": 1}\n```');
    expect(r.ok).toBe(true);
    expect(r.args).toEqual({ a: 1 });
  });

  it('尾逗号', () => {
    expect(parseToolArguments('{"a":1,}').args).toEqual({ a: 1 });
    expect(parseToolArguments('{"a":[1,2,]}').args).toEqual({ a: [1, 2] });
  });

  it('双逗号 / 开头多余逗号', () => {
    expect(parseToolArguments('{"a":1,, "b":2}').args).toEqual({ a: 1, b: 2 });
    expect(parseToolArguments('{,"a":1}').args).toEqual({ a: 1 });
  });

  it('BOM / 零宽字符', () => {
    expect(parseToolArguments('\uFEFF{"a":1}').args).toEqual({ a: 1 });
    expect(parseToolArguments('{"a":\u200B1}').args).toEqual({ a: 1 });
  });

  it('单引号 JSON', () => {
    const r = parseToolArguments("{'question':'text','options':['A','B']}");
    expect(r.ok).toBe(true);
    expect(r.args).toEqual({ question: 'text', options: ['A', 'B'] });
  });

  it('未加引号的 key', () => {
    const r = parseToolArguments('{question: "text", options: ["A"]}');
    expect(r.ok).toBe(true);
    expect(r.args).toEqual({ question: 'text', options: ['A'] });
  });

  it('未加引号的标识符值', () => {
    const r = parseToolArguments('{"name": search_files, "args": {"pattern": foo}}');
    expect(r.ok).toBe(true);
    expect(r.args).toEqual({ name: 'search_files', args: { pattern: 'foo' } });
  });

  it('true/false/null/数字不被当成裸标识符加引号', () => {
    const r = parseToolArguments('{a: true, b: false, c: null, d: 1, e: 1.5}');
    expect(r.ok).toBe(true);
    expect(r.args).toEqual({ a: true, b: false, c: null, d: 1, e: 1.5 });
  });

  it('截断的嵌套对象自动补括号', () => {
    const r = parseToolArguments('{"items":[{"a":1},{"b":2');
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.args.items)).toBe(true);
  });

  it('截断的顶层对象自动补括号', () => {
    const r = parseToolArguments('{"query":"hello","limit":10');
    expect(r.ok).toBe(true);
    expect(r.args).toEqual({ query: 'hello', limit: 10 });
  });

  it('字符串里未转义的引号 / 裸换行能被修复', () => {
    const raw = '{"text": "he said "hi"\nthen left"}';
    const r = parseToolArguments(raw);
    expect(r.ok).toBe(true);
    expect(String(r.args.text)).toContain('he said');
  });

  it('无法修复时返回结构化失败信息', () => {
    const r = parseToolArguments('{ totally broken');
    expect(r.ok).toBe(false);
    expect(r.args).toEqual({});
    expect(typeof r.reason).toBe('string');
    expect(r.raw).toBe('{ totally broken');
  });

  it('修复成功时 repaired=true 并带 reason', () => {
    const r = parseToolArguments("{'a':1}");
    expect(r.ok).toBe(true);
    expect(r.repaired).toBe(true);
    expect(r.reason).toContain('single_quote_repaired');
  });
});

describe('normalizeToolArgumentAliases', () => {
  it('write_file / edit 的 path 转 file_path', () => {
    expect(normalizeToolArgumentAliases({ path: 'a.ts' }, 'write_file')).toEqual({ path: 'a.ts', file_path: 'a.ts' });
    expect(normalizeToolArgumentAliases({ filePath: 'a.ts' }, 'edit_file')).toEqual({ filePath: 'a.ts', file_path: 'a.ts' });
  });

  it('工具限定别名不会套到别的工具', () => {
    expect(normalizeToolArgumentAliases({ path: 'a.ts' }, 'readfile')).toEqual({ path: 'a.ts' });
    expect(normalizeToolArgumentAliases({ path: 'a.ts' })).toEqual({ path: 'a.ts' });
  });

  it('通用别名（old/new/startLine）不限工具', () => {
    expect(normalizeToolArgumentAliases({ old: 'a', new: 'b', startLine: 3 }, 'edit')).toMatchObject({
      old_string: 'a', new_string: 'b', start_line: 3,
    });
  });

  it('已有 canonical 字段时不覆盖', () => {
    const out = normalizeToolArgumentAliases({ file_path: 'canonical', path: 'alias' }, 'write_file');
    expect(out.file_path).toBe('canonical');
  });

  it('call_tool 递归给内层参数做别名', () => {
    const out = normalizeToolArgumentAliases({ name: 'write_file', args: { path: 'a.ts', old: 'x' } }, 'call_tool');
    expect(out.args).toMatchObject({ path: 'a.ts', file_path: 'a.ts', old: 'x', old_string: 'x' });
  });

  it('call_tool 的 args 不是对象时不递归', () => {
    expect(normalizeToolArgumentAliases({ name: 'x', args: 'raw' }, 'call_tool')).toEqual({ name: 'x', args: 'raw' });
  });
});

describe('parseToolArguments 与别名组合', () => {
  it('解析后自动应用工具别名', () => {
    const r = parseToolArguments('{"path":"src/a.ts","content":"x"}', 'write_file');
    expect(r.args).toMatchObject({ path: 'src/a.ts', file_path: 'src/a.ts', content: 'x' });
  });
});
