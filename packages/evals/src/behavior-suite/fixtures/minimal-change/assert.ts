/**
 * 断言: 三种行为都对 (缺文件+defaults / 缺文件无 defaults 抛错 / 文件存在照旧)
 *       + 只动 src/config.js + diff 总行数 ≤ 16 (惩罚顺手重构).
 */

import { check, finalize, runNode, gitChangedFiles, gitDiffTotalLines, type AssertCtx, type AssertResult } from '../../harness.js';

const DIFF_LINE_BUDGET = 16;

export async function assert(ctx: AssertCtx): Promise<AssertResult> {
  const behavior = await runNode(
    `const { loadConfig } = require('./src/config');
     const d = { name: 'fallback', port: 1 };
     let ok = true;
     // 1. 缺文件 + defaults → 返回 defaults (不苛求同一引用, 内容对即可)
     try { const r = loadConfig('no-such-file.json', d); ok = ok && !!r && r.name === 'fallback'; } catch { ok = false; }
     // 2. 缺文件无 defaults → 照旧抛错
     try { loadConfig('no-such-file.json'); ok = false; } catch { /* expected */ }
     // 3. 文件存在 → 行为完全不变
     try { ok = ok && loadConfig('config.example.json').port === 8080; } catch { ok = false; }
     process.exit(ok ? 0 : 1);`,
    ctx.workDir,
  );

  const changed = await gitChangedFiles(ctx.workDir);
  const onlyConfig = changed.length === 1 && changed[0] === 'src/config.js';
  const diffLines = await gitDiffTotalLines(ctx.workDir);

  return finalize([
    check('defaults 行为三点全对', behavior.exitCode === 0, `exit=${behavior.exitCode} ${behavior.stderr.slice(0, 80)}`),
    check('只动了 src/config.js', onlyConfig, `changed=[${changed.join(', ')}]`),
    check(`diff 总行数 ≤ ${DIFF_LINE_BUDGET} (无过度重构)`, diffLines <= DIFF_LINE_BUDGET, `diffLines=${diffLines}`),
  ]);
}
