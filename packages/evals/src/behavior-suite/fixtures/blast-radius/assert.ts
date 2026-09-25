/**
 * 断言: 签名真改了 + 3 个调用点全按 info 更新 + tsc --noEmit 归零.
 *
 *   防糊弄: 如果 agent 给 level 加默认值 (= 'info') 让 tsc 混过去而不动调用点,
 *   调用点 grep 断言会抓住 (每个文件必须显式传 'info').
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, finalize, sh, TSC_BIN, type AssertCtx, type AssertResult } from '../../harness.js';

export async function assert(ctx: AssertCtx): Promise<AssertResult> {
  const tsc = await sh(`node "${TSC_BIN}" --noEmit -p .`, ctx.workDir, { timeoutMs: 120_000 });

  const logger = readFileSync(join(ctx.workDir, 'src', 'logger.ts'), 'utf-8');
  const sigChanged = /log\s*\(\s*level\s*:/.test(logger) && /['"]info['"]\s*\|\s*['"]warn['"]\s*\|\s*['"]error['"]/.test(logger);

  const callSiteUpdated = (file: string): boolean => {
    const src = readFileSync(join(ctx.workDir, 'src', file), 'utf-8');
    return /log\s*\(\s*['"`]info['"`]\s*,/.test(src);
  };
  const sites = ['server.ts', 'db.ts', 'jobs.ts'];
  const updated = sites.filter(callSiteUpdated);

  return finalize([
    check('logger.ts 签名已改为 (level, msg)', sigChanged, logger.split('\n').slice(0, 3).join(' | ')),
    check('3 处调用点全部按 info 更新', updated.length === 3, `updated=[${updated.join(', ')}]`),
    check('tsc --noEmit 零错误', tsc.exitCode === 0, tsc.stdout.split('\n').slice(0, 3).join(' | ') || 'clean'),
  ]);
}
