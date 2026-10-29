import { describe, expect, it } from 'vitest';
import {
  applyDsmlToolCallsToTurn,
  MAX_DSML_RETRIES,
} from '../dsmlTurnRecovery.js';

const BROKEN = `thinking about the edit...
</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;

const COMPLETE = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read_file">
<｜｜DSML｜｜ parameter name="path" string="true">a.ts</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;

describe('applyDsmlToolCallsToTurn', () => {
  it('完整调用 → 产出 ToolCall, 计数归零', () => {
    const r = applyDsmlToolCallsToTurn(COMPLETE, 1);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]!.function.name).toBe('read_file');
    expect(JSON.parse(r.toolCalls[0]!.function.arguments)).toEqual({ path: 'a.ts' });
    expect(r.retry).toBe(false);
    expect(r.giveUp).toBe(false);
    expect(r.retries).toBe(0);
  });

  it('残缺 → retry, 正文摘掉残片', () => {
    const r = applyDsmlToolCallsToTurn(BROKEN, 0);
    expect(r.toolCalls).toEqual([]);
    expect(r.retry).toBe(true);
    expect(r.giveUp).toBe(false);
    expect(r.retries).toBe(1);
    expect(r.text).toContain('thinking about the edit');
    expect(r.text).not.toContain('DSML');
  });

  it(`连续残缺 ${MAX_DSML_RETRIES} 次后 giveUp`, () => {
    const first = applyDsmlToolCallsToTurn(BROKEN, 0);
    const second = applyDsmlToolCallsToTurn(BROKEN, first.retries);
    expect(second.retry).toBe(true);
    const third = applyDsmlToolCallsToTurn(BROKEN, second.retries);
    expect(third.retry).toBe(false);
    expect(third.giveUp).toBe(true);
  });

  it('正常文本原样返回, 残缺计数归零', () => {
    const t = '改完了, 改动在 src/a.ts:12。';
    const r = applyDsmlToolCallsToTurn(t, 2);
    expect(r.toolCalls).toEqual([]);
    expect(r.text).toBe(t);
    expect(r.retry).toBe(false);
    expect(r.giveUp).toBe(false);
    expect(r.retries).toBe(0);
  });
});

describe('纯 XML 形态的文本调用', () => {
  const XML_BROKEN = `Let me inspect the runner.

<content>
<parameter name="command">cd /tmp && sed -n "2480,2560p" packages/kernel/src/core/runner.ts</parameter>
</content>`;

  const XML_COMPLETE = `<function_calls>
<invoke name="read_file">
<parameter name="path" string="true">a.ts</parameter>
</invoke>
</function_calls>`;

  it('残缺 → retry, 正文摘掉标签', () => {
    const r = applyDsmlToolCallsToTurn(XML_BROKEN, 0);
    expect(r.toolCalls).toEqual([]);
    expect(r.retry).toBe(true);
    expect(r.giveUp).toBe(false);
    expect(r.retries).toBe(1);
    expect(r.text).toContain('Let me inspect the runner');
    expect(r.text).not.toContain('<parameter');
  });

  it('完整 → 当真调用执行, 计数归零', () => {
    const r = applyDsmlToolCallsToTurn(XML_COMPLETE, 1);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]!.function.name).toBe('read_file');
    expect(JSON.parse(r.toolCalls[0]!.function.arguments)).toEqual({ path: 'a.ts' });
    expect(r.retry).toBe(false);
    expect(r.retries).toBe(0);
    expect(r.text).toBe('');
  });

  it(`与 DSML 共用 ${MAX_DSML_RETRIES} 次上限`, () => {
    const first = applyDsmlToolCallsToTurn(XML_BROKEN, 0);
    const second = applyDsmlToolCallsToTurn(XML_BROKEN, first.retries);
    const third = applyDsmlToolCallsToTurn(XML_BROKEN, second.retries);
    expect(second.retry).toBe(true);
    expect(third.retry).toBe(false);
    expect(third.giveUp).toBe(true);
  });

  it('代码块里的示例不算残缺, 不当成调用', () => {
    const t = '示例:\n\n```xml\n<invoke name="read_file">\n<parameter name="path" string="true">a.ts</parameter>\n</invoke>\n```';
    const r = applyDsmlToolCallsToTurn(t, 1);
    expect(r.toolCalls).toEqual([]);
    expect(r.retry).toBe(false);
    expect(r.retries).toBe(0);
    expect(r.text).toBe(t);
  });
});
