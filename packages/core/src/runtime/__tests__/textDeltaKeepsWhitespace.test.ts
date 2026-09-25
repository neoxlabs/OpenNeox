import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 验证流式文本和工具参数事件保留空白字符，避免分词后的内容改变语义。 */
const SRC = readFileSync(join(__dirname, '..', 'agentRuntimeHost.ts'), 'utf8');

/** 取 `case 'x':` 到下一个同级 `case '` 之间那一段 */
function caseBody(src: string, name: string): string {
  const start = src.indexOf(`case '${name}':`);
  expect(start, `找不到 case '${name}'`).toBeGreaterThan(-1);
  const rest = src.slice(start + 8);
  const end = rest.indexOf("\n          case '");
  return end > -1 ? rest.slice(0, end) : rest;
}

describe('流式 delta 不许被 trim 掉', () => {
  it("text_delta: emit text 不能被 trim 条件包住", () => {
    const body = caseBody(SRC, 'text_delta');
    expect(body, "text 事件必须还在发").toContain("type: 'text'");
    /* status 节流分支必须在 text 事件发送前闭合，不能包住文本发送。 */
    const emitAt = body.indexOf("this.emitEvent({ type: 'text'");
    expect(emitAt, '找不到 emit text').toBeGreaterThan(-1);
    const head = body.slice(0, emitAt).replace(/\s+$/, '');
    expect(
      head.endsWith('}'),
      'emit text 又被包进 if 里了 —— 只等于 " " 的 delta 会被整个吞掉',
    ).toBe(true);
  });

  it('tool_call_delta: emit 不能被 trim 条件包住', () => {
    const body = caseBody(SRC, 'tool_call_delta');
    expect(body, 'tool_call_delta 事件必须还在发').toContain("type: 'tool_call_delta'");
    expect(
      /arguments_delta\.trim\(\)/.test(body),
      '流式参数预览又被 trim 掉空格了 (执行用 accumulatedArgs 不受影响, 预览会少字)',
    ).toBe(false);
  });
});
