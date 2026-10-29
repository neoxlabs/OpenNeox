import { describe, expect, it } from 'vitest';
import { parseDsmlToolCalls } from '../dsmlToolCalls.js';

/** /private/tmp/.../orphan-close-sample.txt 的尾部 (前 17 行英文思考略) */
const ORPHAN_CLOSE = `Let me rewrite ui.ts settings block and adjust settings.test.ts assertions.

Let me do it in one edit for ui.ts and one for settings.test.ts.</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;

describe('只有闭合标签的残片', () => {
  it('判为不完整, 不产出调用', () => {
    const r = parseDsmlToolCalls(ORPHAN_CLOSE);
    expect(r.calls).toEqual([]);
    expect(r.sawIncomplete).toBe(true);
  });

  it('正文里一个 DSML 字符都不留, 人话保留', () => {
    const r = parseDsmlToolCalls(ORPHAN_CLOSE);
    expect(r.text).toContain('Let me do it in one edit');
    expect(r.text).not.toContain('DSML');
    expect(r.text).not.toContain('｜');
  });
});

describe('竖线与关键字之间有空格', () => {
  it('完整调用照旧解析 (parameter / invoke / calls 都带空格)', () => {
    const src = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read_file">
<｜｜DSML｜｜ parameter name="path" string="true">a.ts</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;
    const r = parseDsmlToolCalls(src);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.name).toBe('read_file');
    expect(JSON.parse(r.calls[0]!.arguments)).toEqual({ path: 'a.ts' });
    expect(r.sawIncomplete).toBe(false);
    expect(r.text).toBe('');
  });

  it('单竖线 + calls 外壳 + 空格也认', () => {
    const src = `<｜DSML｜ calls><｜DSML｜ invoke name="echo"><｜DSML｜ parameter name="v" string="true">hi</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>`;
    const r = parseDsmlToolCalls(src);
    expect(r.calls).toHaveLength(1);
    expect(JSON.parse(r.calls[0]!.arguments)).toEqual({ v: 'hi' });
  });
});
