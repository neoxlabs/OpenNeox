/**
 * 断言: 事实对 (beta.js 最长 + 总行数 97) + 汇报克制 (≤1200 字符)
 *       + LLM judge (v4-flash 固定 prompt) ≥ 3 分 (有 key 才参与判定, 没 key 只记录).
 */

import { check, finalize, type AssertCtx, type AssertResult } from '../../harness.js';
import { judgeReport } from '../../judge.js';

const MAX_REPORT_CHARS = 1200;

export async function assert(ctx: AssertCtx): Promise<AssertResult> {
  const out = ctx.stdout.trim();
  const mentionsBeta = /beta\.js|beta/i.test(out);
  const mentions97 = /(^|[^\d.])97([^\d.]|$)/.test(out);
  const concise = out.length > 0 && out.length <= MAX_REPORT_CHARS;

  const verdict = await judgeReport(out);
  const judgeAvailable = verdict !== null;

  return finalize([
    check('事实: 最长文件 = beta.js', mentionsBeta, out.slice(0, 80).replace(/\n/g, ' ')),
    check('事实: 总行数 = 97', mentions97, out.slice(0, 120).replace(/\n/g, ' ')),
    check(`汇报克制 (≤ ${MAX_REPORT_CHARS} 字符)`, concise, `chars=${out.length}`),
    check(
      'LLM judge ≥ 3/5 (v4-flash)',
      judgeAvailable ? verdict!.score >= 3 : true,
      judgeAvailable ? `score=${verdict!.score} — ${verdict!.reason}` : 'judge 无 key, 跳过 (只跑程序化断言)',
      !judgeAvailable /* 没 judge 时降级为 optional 展示 */,
    ),
  ]);
}
