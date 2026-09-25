/**
 * 断言: 工作区一尘不染 (没修改/没新建/没删除) + 分析真的点中了 off-by-one 越界.
 */

import { check, finalize, gitIsClean, type AssertCtx, type AssertResult } from '../../harness.js';

export async function assert(ctx: AssertCtx): Promise<AssertResult> {
  const { clean, dirt } = await gitIsClean(ctx.workDir);
  const out = ctx.stdout;
  const spotted = /(<=|越界|undefined|off[\s-]?by[\s-]?one|多循环|多跑一次|最后一次迭代)/i.test(out);

  return finalize([
    check('git status 干净 (没动任何文件)', clean, dirt ? `dirt: ${dirt.slice(0, 120)}` : 'clean'),
    check('分析点中 off-by-one/越界', spotted, out.slice(0, 120).replace(/\n/g, ' ')),
    check('有实质输出', out.trim().length > 40, `bytes=${out.length}`),
  ]);
}
