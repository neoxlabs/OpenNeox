import { describe, expect, it } from 'vitest';
import { parseXmlToolCalls } from '../xmlToolCalls.js';

const LIVE_TAIL = `Let me look at the runner before changing the recovery path.

<content>
<parameter name="command">cd /Users/x/AI/OpenNeox-wt-xmltool && sed -n "2480,2560p" packages/kernel/src/core/runner.ts</parameter>
</content>`;

const COMPLETE = `我来看一下 runner。

<function_calls>
<invoke name="execute_shell">
<parameter name="command">sed -n '1,40p' packages/kernel/src/core/runner.ts</parameter>
</invoke>
</function_calls>`;

describe('纯 XML 形态工具调用', () => {
  it('实拍残缺: 判为不完整, 不产出调用, 残片从正文里摘掉', () => {
    const r = parseXmlToolCalls(LIVE_TAIL);
    expect(r.calls).toEqual([]);
    expect(r.sawIncomplete).toBe(true);
    expect(r.text).toContain('Let me look at the runner');
    expect(r.text).not.toContain('<parameter');
    expect(r.text).not.toContain('<content>');
  });

  it('完整调用 → 产出真调用, 参数按 string 语义强制', () => {
    const r = parseXmlToolCalls(COMPLETE);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.name).toBe('execute_shell');
    expect(JSON.parse(r.calls[0]!.arguments)).toEqual({
      command: "sed -n '1,40p' packages/kernel/src/core/runner.ts",
    });
    expect(r.sawIncomplete).toBe(false);
    expect(r.text).toBe('我来看一下 runner。');
  });

  it('多个 invoke 一次解析 + 非字符串参数按 JSON 解析', () => {
    const src = `<tool_calls>
<invoke name="read_file"><parameter name="path" string="true">a.ts</parameter></invoke>
<invoke name="execute_shell"><parameter name="command" string="true">ls</parameter><parameter name="timeout" string="false">30000</parameter></invoke>
</tool_calls>`;
    const r = parseXmlToolCalls(src);
    expect(r.calls.map((c) => c.name)).toEqual(['read_file', 'execute_shell']);
    expect(JSON.parse(r.calls[1]!.arguments)).toEqual({ command: 'ls', timeout: 30000 });
  });

  it('antml: 前缀与单引号属性也认', () => {
    const src = `<antml:invoke name='readfile'><antml:parameter name='path' string='true'>b.ts</antml:parameter></antml:invoke>`;
    const r = parseXmlToolCalls(src);
    expect(r.calls).toHaveLength(1);
    expect(JSON.parse(r.calls[0]!.arguments)).toEqual({ path: 'b.ts' });
  });

  it('invoke 没有闭合标签 → 不执行半截调用', () => {
    const src = `<invoke name="write_file"><parameter name="path" string="true">a.ts</parameter>`;
    const r = parseXmlToolCalls(src);
    expect(r.calls).toEqual([]);
    expect(r.sawIncomplete).toBe(true);
  });

  it('有 parameter 却一个都没解析出来 → 判残缺, 不猜', () => {
    const src = `<invoke name="x"><parameter>没有 name 属性</parameter></invoke>`;
    const r = parseXmlToolCalls(src);
    expect(r.calls).toEqual([]);
    expect(r.sawIncomplete).toBe(true);
  });
});

describe('不能误伤', () => {
  it('代码块里的示例不触发, 正文原样返回', () => {
    const src = `模型偶尔会这样输出:

\`\`\`xml
<function_calls>
<invoke name="execute_shell">
<parameter name="command">ls</parameter>
</invoke>
</function_calls>
\`\`\``;
    const r = parseXmlToolCalls(src);
    expect(r.calls).toEqual([]);
    expect(r.sawIncomplete).toBe(false);
    expect(r.text).toBe(src);
  });

  it('行内代码里的标签不触发', () => {
    const src = '这种调用要写成 `<parameter name="command">ls</parameter>`。';
    const r = parseXmlToolCalls(src);
    expect(r.sawIncomplete).toBe(false);
    expect(r.text).toBe(src);
  });

  it('标记后面还有正文 (不是在末尾) → 不触发', () => {
    const src = `开头 <parameter name="command">ls</parameter>

后面我还想说明一下: 这段是示例, 不要执行。`;
    const r = parseXmlToolCalls(src);
    expect(r.calls).toEqual([]);
    expect(r.sawIncomplete).toBe(false);
    expect(r.text).toBe(src);
  });

  it('普通回答 (没有标记) 零改动', () => {
    const src = '改完了, 改动在 `src/a.ts:12`。\n\n详情见上。';
    const r = parseXmlToolCalls(src);
    expect(r.calls).toEqual([]);
    expect(r.sawIncomplete).toBe(false);
    expect(r.text).toBe(src);
  });
});
