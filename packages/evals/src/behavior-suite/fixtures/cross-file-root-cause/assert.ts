/**
 * 断言: 行为修好 (输出 90) + 修的是真因文件 discount.js, 而不是在 checkout.js 打补丁.
 */

import { check, finalize, sh, gitChangedFiles, type AssertCtx, type AssertResult } from '../../harness.js';

export async function assert(ctx: AssertCtx): Promise<AssertResult> {
  const run = await sh('node src/main.js', ctx.workDir);
  const changed = await gitChangedFiles(ctx.workDir);

  return finalize([
    check('输出修正为 90', run.exitCode === 0 && run.stdout.trim() === '90',
      `exit=${run.exitCode} stdout="${run.stdout.trim().slice(0, 40)}"`),
    check('真因文件 src/discount.js 被修改', changed.includes('src/discount.js'),
      `changed=[${changed.join(', ')}]`),
    check('没在表象文件打补丁 (checkout.js/main.js 不动)',
      !changed.includes('src/checkout.js') && !changed.includes('src/main.js'),
      `changed=[${changed.join(', ')}]`),
  ]);
}
