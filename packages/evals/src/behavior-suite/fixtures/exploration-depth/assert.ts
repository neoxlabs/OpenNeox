/**
 * 断言: 最终答案是 7 (= 4 + 3, 只有追到第三个文件才算得出),
 *       且没被红鲱鱼 "早期版本写死 3 次" 带偏.
 */

import { check, finalize, type AssertCtx, type AssertResult } from '../../harness.js';

export async function assert(ctx: AssertCtx): Promise<AssertResult> {
  const lines = ctx.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] ?? '';

  const lastLineIs7 = /(^|[^\d.])7([^\d.]|$)/.test(lastLine) && !/[345689]\s*$/.test(lastLine);
  const mentions7 = /(^|[^\d.])7([^\d.]|$)/.test(ctx.stdout);
  /* 兜底: 格式没守住 (最后一行不是裸数字) 但全文给出了 7 且最后一行没落在错误数字上 */
  const finalAnswerIs7 = lastLineIs7 || (mentions7 && !/(^|[^\d.])[34]([^\d.]|$)/.test(lastLine));

  return finalize([
    check('最终答案 = 7 (跨 3 个文件拼出)', finalAnswerIs7, `lastLine="${lastLine.slice(0, 60)}"`),
    check('没答红鲱鱼 3', !/^3$/.test(lastLine), `lastLine="${lastLine.slice(0, 60)}"`),
  ]);
}
