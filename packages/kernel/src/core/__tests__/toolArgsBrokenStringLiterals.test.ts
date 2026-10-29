import { describe, it, expect } from 'vitest';
import { parseToolArguments } from '../toolArgsParser';

/**
 *  browser_run 的参数可能包含未转义的字符串字面量，测试覆盖这类输入:
 *   `Invalid JSON arguments: Unexpected non-whitespace character after JSON...`
 *   `Invalid JSON arguments: Expected ',' or '}' after property value in JSON...`
 * 修复链需要在结构不完整且包含嵌入代码时保留明确的解析错误。
 */
describe('字符串字面量破损', () => {
  it("内层引号没转义 —— Expected ',' or '}' after property value", () => {
    const raw = '{"steps":[{"action":"eval","args":{"expression":"document.querySelector("h1").innerText"}}]}';
    expect(() => JSON.parse(raw)).toThrow();     // 先确认这串确实是坏的
    const r = parseToolArguments(raw, 'browser_run');
    expect(r.ok).toBe(true);
    expect(r.repaired).toBe(true);
    expect((r.args.steps as any[])[0].args.expression)
      .toBe('document.querySelector("h1").innerText');
  });

  it('字符串里有裸换行 —— Bad control character', () => {
    const raw = '{"note":"第一行\n第二行","n":1}';
    expect(() => JSON.parse(raw)).toThrow();
    const r = parseToolArguments(raw);
    expect(r.ok).toBe(true);
    expect(r.args.note).toBe('第一行\n第二行');
    expect(r.args.n).toBe(1);
  });

  it('两个对象连在一起 —— Unexpected non-whitespace character after JSON', () => {
    const raw = '{"steps":[{"action":"click","args":{"selector":"#go"}}]}{"steps":[]}';
    expect(() => JSON.parse(raw)).toThrow();
    const r = parseToolArguments(raw, 'browser_run');
    expect(r.ok).toBe(true);
    expect((r.args.steps as any[])).toHaveLength(1);
    expect((r.args.steps as any[])[0].args.selector).toBe('#go');
  });

  it('对象后面跟一段散文也只取对象', () => {
    const r = parseToolArguments('{"a":1}\n好了, 我先跑这一段。', 'browser_run');
    expect(r.ok).toBe(true);
    expect(r.args.a).toBe(1);
  });

  it('字符串里的 } 不能被当成对象结尾', () => {
    const r = parseToolArguments('{"expression":"(()=>{return 1})()","b":2}');
    expect(r.ok).toBe(true);
    expect(r.repaired).toBe(false);
    expect(r.args.expression).toBe('(()=>{return 1})()');
    expect(r.args.b).toBe(2);
  });

  it('合法 JSON 一个字节都不动', () => {
    const raw = '{"steps":[{"action":"type","args":{"text":"a, b: c"}}]}';
    const r = parseToolArguments(raw, 'browser_run');
    expect(r.ok).toBe(true);
    expect(r.repaired).toBe(false);
    expect((r.args.steps as any[])[0].args.text).toBe('a, b: c');
  });
});
