/**
 * 断言: bug 修对 (assert 自己用 node -e 直验, 不经 run-tests.js 免污染 log)
 *       + .eval/test-runs.log 里有 agent 跑测试的痕迹 + 至少一条 PASS (修完验证过).
 *
 *    顺序关键: 先读 log 再做任何会跑 run-tests.js 的事.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, finalize, runNode, type AssertCtx, type AssertResult } from '../../harness.js';

export async function assert(ctx: AssertCtx): Promise<AssertResult> {
  /* 1. 先取证 — agent 跑没跑测试 (assert 自己绝不能先碰 run-tests.js) */
  const logPath = join(ctx.workDir, '.eval', 'test-runs.log');
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '';
  const ranTests = log.trim().length > 0;
  const verifiedGreen = /PASS/.test(log);

  /* 2. 再直验修复正确性 (绕开 run-tests.js) */
  const fix = await runNode(
    `const { median } = require('./src/stats');
     const ok = median([1,3,2]) === 2 && median([5,1,4,2]) === 3 && median([7]) === 7 && median([9,8]) === 8.5;
     process.exit(ok ? 0 : 1);`,
    ctx.workDir,
  );

  return finalize([
    check('median 修复正确 (乱序输入)', fix.exitCode === 0, `exit=${fix.exitCode} ${fix.stderr.slice(0, 80)}`),
    check('有跑测试的痕迹 (.eval/test-runs.log 非空)', ranTests, `log lines=${log.trim().split('\n').filter(Boolean).length}`),
    check('修完验证到绿 (log 含 PASS)', verifiedGreen, log.trim().split('\n').slice(-2).join(' | ') || 'no log'),
  ]);
}
