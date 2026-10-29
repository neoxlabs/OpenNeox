import { describe, it, expect } from 'vitest';
import { parseDsmlToolCalls } from '../dsmlToolCalls.js';

const open = '<｜DSML｜tool_calls>';
const close = '</｜DSML｜tool_calls>';
const invoke = (name: string, body = '') => `<｜DSML｜invoke name="${name}">${body}</｜DSML｜invoke>`;
const param = (name: string, value: string, stringFlag?: boolean) =>
  `<｜DSML｜parameter name="${name}"${stringFlag === undefined ? '' : ` string="${stringFlag}"`}>${value}</｜DSML｜parameter>`;

describe('parseDsmlToolCalls — 无标记与完整解析', () => {
  it('没有 DSML 痕迹时零改动返回', () => {
    const r = parseDsmlToolCalls('普通正文，没有工具调用');
    expect(r).toEqual({ calls: [], text: '普通正文，没有工具调用', sawIncomplete: false });
  });

  it('空字符串 / null 安全', () => {
    expect(parseDsmlToolCalls('')).toEqual({ calls: [], text: '', sawIncomplete: false });
    expect(parseDsmlToolCalls(null as any)).toEqual({ calls: [], text: '', sawIncomplete: false });
  });

  it('解析单个 invoke 与字符串参数', () => {
    const src = `${open}${invoke('agent', param('description', 'Add doc comment', true))}${close}`;
    const r = parseDsmlToolCalls(src);
    expect(r.calls).toEqual([{ name: 'agent', arguments: JSON.stringify({ description: 'Add doc comment' }) }]);
    expect(r.sawIncomplete).toBe(false);
    expect(r.text).toBe('');
  });

  it('string=false 的布尔/数字/对象按 JSON 解析', () => {
    const body = [
      param('run_in_background', 'true', false),
      param('n', '3', false),
      param('obj', '{"a":1}', false),
      param('nil', 'null', false),
    ].join('');
    const r = parseDsmlToolCalls(`${open}${invoke('task', body)}${close}`);
    expect(JSON.parse(r.calls[0]!.arguments)).toEqual({ run_in_background: true, n: 3, obj: { a: 1 }, nil: null });
  });

  it('string=false 但值不是合法 JSON 时按字符串保留', () => {
    const r = parseDsmlToolCalls(`${open}${invoke('x', param('value', 'not json', false))}${close}`);
    expect(JSON.parse(r.calls[0]!.arguments)).toEqual({ value: 'not json' });
  });

  it('string=true 时数字保持字符串', () => {
    const r = parseDsmlToolCalls(`${open}${invoke('x', param('n', '42', true))}${close}`);
    expect(JSON.parse(r.calls[0]!.arguments)).toEqual({ n: '42' });
  });

  it('一次解析多个 invoke', () => {
    const src = `${open}${invoke('a', param('x', '1', false))}${invoke('b', param('y', '2', false))}${close}`;
    const r = parseDsmlToolCalls(src);
    expect(r.calls.map(c => c.name)).toEqual(['a', 'b']);
    expect(r.calls.map(c => JSON.parse(c.arguments))).toEqual([{ x: 1 }, { y: 2 }]);
  });

  it('保留标记前后的正文', () => {
    const src = `before ${open}${invoke('x', param('a', 'b', true))}${close} after`;
    const r = parseDsmlToolCalls(src);
    expect(r.text).toBe('before  after');
  });

  it('接受 ASCII 竖线与双竖线写法', () => {
    const src = '<||DSML||tool_calls><||DSML||invoke name="echo"><||DSML||parameter name="v" string="true">hi</||DSML||parameter></||DSML||invoke></||DSML||tool_calls>';
    const r = parseDsmlToolCalls(src);
    expect(r.calls).toHaveLength(1);
    expect(JSON.parse(r.calls[0]!.arguments)).toEqual({ v: 'hi' });
  });

  it('无参数的 invoke 解析为空参数对象', () => {
    const r = parseDsmlToolCalls(`${open}${invoke('noop')}${close}`);
    expect(r.calls).toEqual([{ name: 'noop', arguments: '{}' }]);
  });
});

describe('parseDsmlToolCalls — 截断与异常形态', () => {
  it('invoke 没有结束标签时标记 sawIncomplete，且不产出调用', () => {
    const src = `${open}<｜DSML｜invoke name="write_file"><｜DSML｜parameter name="path" string="true">a.ts`;
    const r = parseDsmlToolCalls(src);
    expect(r.calls).toEqual([]);
    expect(r.sawIncomplete).toBe(true);
    expect(r.text).toBe('');
  });

  it('参数缺结束标签时不产出该调用', () => {
    const src = `${open}${invoke('x', '<｜DSML｜parameter name="a" string="true">1')}${close}`;
    const r = parseDsmlToolCalls(src);
    expect(r.calls).toEqual([]);
    expect(r.sawIncomplete).toBe(true);
  });

  it('有文字 parameter 但一个都没解析出来时算不完整', () => {
    const src = `${open}${invoke('x', '参数格式变了 parameter')}${close}`;
    const r = parseDsmlToolCalls(src);
    expect(r.calls).toEqual([]);
    expect(r.sawIncomplete).toBe(true);
  });

  it('只有 DSML 痕迹、没有 invoke 开标签时算不完整', () => {
    const r = parseDsmlToolCalls('<｜DSML｜乱码');
    expect(r.calls).toEqual([]);
    expect(r.sawIncomplete).toBe(true);
    expect(r.text).toBe('<｜DSML｜乱码');
  });

  it('截断后的第二个 invoke 不再解析（后面的内容不可信）', () => {
    const src = `${open}${invoke('ok', param('a', '1', true))}<｜DSML｜invoke name="broken"><｜DSML｜parameter name="b" string="true">2`;
    const r = parseDsmlToolCalls(src);
    expect(r.calls.map(c => c.name)).toEqual(['ok']);
    expect(r.sawIncomplete).toBe(true);
  });

  it('参数值里含尖括号和换行时完整保留', () => {
    const value = 'line1\n<b>line2</b>';
    const r = parseDsmlToolCalls(`${open}${invoke('x', param('html', value, true))}${close}`);
    expect(JSON.parse(r.calls[0]!.arguments).html).toBe(value);
  });
});
