/** 验证 DSML 文本工具调用可转换为结构化调用，并拒绝未闭合的调用。 */
import { describe, expect, it } from 'vitest';
import { parseDsmlToolCalls } from '../dsmlToolCalls.js';

/** 覆盖完整 invoke 块及其参数解析。 */
const REAL = `<｜DSML｜tool_calls>
<｜DSML｜invoke name="agent">
<｜DSML｜parameter name="description" string="true">Add file doc comment to commands.js</｜DSML｜parameter>
<｜DSML｜parameter name="prompt" string="true">给 src/commands.js 顶部加一行文件说明注释。</｜DSML｜parameter>
<｜DSML｜parameter name="run_in_background" string="false">true</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>`;

describe('实拍那一段', () => {
  it('解析成一个 agent 调用, 参数一个不少', () => {
    const r = parseDsmlToolCalls(REAL);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.name).toBe('agent');
    expect(JSON.parse(r.calls[0]!.arguments)).toEqual({
      description: 'Add file doc comment to commands.js',
      prompt: '给 src/commands.js 顶部加一行文件说明注释。',
      run_in_background: true,   // string="false" → 按 JSON 解析成布尔, 不是 "true" 字符串
    });
    expect(r.sawIncomplete).toBe(false);
  });

  it('正文里不留任何 DSML 残壳', () => {
    const r = parseDsmlToolCalls(REAL);
    expect(r.text).toBe('');
    expect(r.text).not.toContain('DSML');
  });

  it('标记前后的人话要留着 —— 那是模型真的在跟用户说的', () => {
    const r = parseDsmlToolCalls(`我来派个子 agent。\n${REAL}\n派好了。`);
    expect(r.calls).toHaveLength(1);
    expect(r.text).toContain('我来派个子 agent。');
    expect(r.text).toContain('派好了。');
    expect(r.text).not.toContain('DSML');
  });
});

describe('格式变体', () => {
  it('分隔符写两遍也认 (agenticRuntime 注释里记的是这个变体)', () => {
    const r = parseDsmlToolCalls(
      `<｜｜DSML｜｜invoke name="read_file"><｜｜DSML｜｜parameter name="path" string="true">a.ts</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke>`,
    );
    expect(r.calls).toHaveLength(1);
    expect(JSON.parse(r.calls[0]!.arguments)).toEqual({ path: 'a.ts' });
  });

  it('一段里多个 invoke 全都要', () => {
    const r = parseDsmlToolCalls(`<｜DSML｜tool_calls>
<｜DSML｜invoke name="a"><｜DSML｜parameter name="x" string="true">1</｜DSML｜parameter></｜DSML｜invoke>
<｜DSML｜invoke name="b"><｜DSML｜parameter name="y" string="true">2</｜DSML｜parameter></｜DSML｜invoke>
</｜DSML｜tool_calls>`);
    expect(r.calls.map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('没有 string 属性时按 JSON 试探, 不合法就当字符串 (不丢信息)', () => {
    const r = parseDsmlToolCalls(
      `<｜DSML｜invoke name="t"><｜DSML｜parameter name="n">42</｜DSML｜parameter><｜DSML｜parameter name="s">hello world</｜DSML｜parameter></｜DSML｜invoke>`,
    );
    expect(JSON.parse(r.calls[0]!.arguments)).toEqual({ n: 42, s: 'hello world' });
  });

  it('值里有换行和引号也不破 (prompt 参数常见)', () => {
    const r = parseDsmlToolCalls(
      `<｜DSML｜invoke name="t"><｜DSML｜parameter name="p" string="true">第一行\n第二行 "带引号"</｜DSML｜parameter></｜DSML｜invoke>`,
    );
    expect(JSON.parse(r.calls[0]!.arguments).p).toBe('第一行\n第二行 "带引号"');
  });
});

describe('⚠️ 半截的绝不执行', () => {
  it('实拍那条截断样本: 没有结束标签 → 不产出调用, 且标记为不完整', () => {
    const truncated = `<｜DSML｜tool_calls>
<｜DSML｜invoke name="agent">
<｜DSML｜parameter name="description" string="true">Add doc</｜DSML｜parameter>
<｜DSML｜parameter name="prompt" string="true">写到一半就断了`;
    const r = parseDsmlToolCalls(truncated);
    expect(r.calls).toHaveLength(0);
    expect(r.sawIncomplete).toBe(true);
  });

  it('前面完整 + 后面截断: 完整的那个照收, 截断的丢掉', () => {
    const r = parseDsmlToolCalls(
      `<｜DSML｜invoke name="a"><｜DSML｜parameter name="x" string="true">1</｜DSML｜parameter></｜DSML｜invoke>` +
      `<｜DSML｜invoke name="b"><｜DSML｜parameter name="y" string="true">半截`,
    );
    expect(r.calls.map((c) => c.name)).toEqual(['a']);
    expect(r.sawIncomplete).toBe(true);
  });

  it('有 DSML 痕迹但一个 invoke 都认不出 → 报不完整, 不静默放行残骸', () => {
    const r = parseDsmlToolCalls('<｜DSML｜something_else>???');
    expect(r.calls).toHaveLength(0);
    expect(r.sawIncomplete).toBe(true);
  });
});

describe('没有 DSML 的正常文本一个字都不能动', () => {
  it('普通回复原样返回', () => {
    const t = '好的，我改完了。改动在 src/store.js:12。';
    const r = parseDsmlToolCalls(t);
    expect(r).toEqual({ calls: [], text: t, sawIncomplete: false });
  });

  it('正文里出现 DSML 字样但不是标记 (比如在讲这个 bug) 不误伤', () => {
    const t = '这个模型会吐 DSML 格式的调用，我们已经解析了。';
    const r = parseDsmlToolCalls(t);
    expect(r.calls).toHaveLength(0);
    expect(r.text).toBe(t);
    expect(r.sawIncomplete).toBe(false);
  });

  it('空串 / undefined 不炸', () => {
    expect(parseDsmlToolCalls('').calls).toHaveLength(0);
    expect(parseDsmlToolCalls(undefined as any).text).toBe('');
  });

  it('含 XML/HTML 的正常回复不误伤', () => {
    const t = '用 <div class="x">…</div> 包一层就行。';
    expect(parseDsmlToolCalls(t).text).toBe(t);
  });
});
