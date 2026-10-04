/**
 * Self-heal helpers 契约固化 — 防 LLM 输出修复逻辑回归.
 */

import { describe, expect, test } from 'vitest';
import { tryFixToolArgsJson, closeFencedBlocks } from '../runnerOutputSelfHeal.js';

describe('tryFixToolArgsJson — JSON 截断修复', () => {
  test('完整 JSON → identity (parse 通过, 不动)', () => {
    const ok = '{"path":"/a.ts","content":"hi"}';
    expect(tryFixToolArgsJson(ok)).toBe(ok);
  });

  test('trailing comma → 修', () => {
    expect(tryFixToolArgsJson('{"a":1,')).toBe('{"a":1}');
  });

  test('字符串没闭合 → 补 "', () => {
    expect(tryFixToolArgsJson('{"path":"/a.ts')).toBe('{"path":"/a.ts"}');
  });

  test('数组没闭合 → 补 ]', () => {
    expect(tryFixToolArgsJson('{"a":[1,2')).toBe('{"a":[1,2]}');
  });

  test('对象没闭合 → 补 }', () => {
    expect(tryFixToolArgsJson('{"a":{"b":1')).toBe('{"a":{"b":1}}');
  });

  test('嵌套 + 字符串 + 数组组合截断', () => {
    /* 字符串没闭合 → 补 ", 然后 ] 和 } 也补 */
    expect(tryFixToolArgsJson('{"items":["a","b'))
      .toBe('{"items":["a","b"]}');
  });

  test('值缺失无法补 → 返 null', () => {
    /* "b": 后面没值, 怎么修都不能合法 → 返 null 让 caller fallback */
    expect(tryFixToolArgsJson('{"a":1,"b":')).toBeNull();
  });

  test('完全 garbage → null', () => {
    expect(tryFixToolArgsJson('aaa bbb ccc')).toBeNull();
  });

  test('空字符串 → null', () => {
    expect(tryFixToolArgsJson('')).toBeNull();
  });

  test('非 string 输入 → null', () => {
    expect(tryFixToolArgsJson(null as any)).toBeNull();
    expect(tryFixToolArgsJson(undefined as any)).toBeNull();
    expect(tryFixToolArgsJson(42 as any)).toBeNull();
  });

  test('字符串内的 } 不算闭合 (escape-safe)', () => {
    expect(tryFixToolArgsJson('{"msg":"hello } world'))
      .toBe('{"msg":"hello } world"}');
  });
});

describe('closeFencedBlocks — markdown 围栏补全', () => {
  test('已闭合 → 不动', () => {
    expect(closeFencedBlocks('```ts\nfoo()\n```')).toBe('```ts\nfoo()\n```');
  });

  test('单个未闭合 ``` → 补', () => {
    expect(closeFencedBlocks('```ts\nfoo()')).toBe('```ts\nfoo()\n```');
  });

  test('已 \\n 结尾 → 不加额外换行', () => {
    expect(closeFencedBlocks('```\nincomplete\n')).toBe('```\nincomplete\n```');
  });

  test('无 ``` → 原样', () => {
    expect(closeFencedBlocks('plain text')).toBe('plain text');
  });

  test('两个完整代码块 → 不动', () => {
    expect(closeFencedBlocks('```a\nx\n```\n```b\ny\n```'))
      .toBe('```a\nx\n```\n```b\ny\n```');
  });

  test('两个完整 + 第三个未闭合 → 补 (5 个 ```)', () => {
    expect(closeFencedBlocks('```a\nx\n```\n```b\ny\n```\n```c\nz'))
      .toBe('```a\nx\n```\n```b\ny\n```\n```c\nz\n```');
  });

  test('空 → 空', () => {
    expect(closeFencedBlocks('')).toBe('');
  });
});
