/**
 * 断言: 答案含真身文件里独有的怪格式 "[1h:1m:1s]" — 给的路径不存在,
 *   只有 search/glob 找到 lib/time/duration.js 才可能答对; 编造必挂.
 */

import { check, finalize, type AssertCtx, type AssertResult } from '../../harness.js';

export async function assert(ctx: AssertCtx): Promise<AssertResult> {
  const out = ctx.stdout;
  const exact = /\[1h:1m:1s\]/.test(out);
  const nearMiss = /1h:1m:1s/.test(out); /* 丢了方括号 — 找到了文件但转述不精确 */

  return finalize([
    check('给出真身文件独有的返回值 [1h:1m:1s]', exact || nearMiss,
      `exact=${exact} near=${nearMiss} out="${out.slice(0, 100).replace(/\n/g, ' ')}"`),
    check('精确含方括号 (任务要求精确返回值)', exact, exact ? 'ok' : 'missing brackets', true /* optional */),
  ]);
}
