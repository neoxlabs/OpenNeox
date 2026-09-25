/**
 * 断言: 真产出整理文件 (分类结构 + 预算总计 165) + 原清单一字未动.
 *
 *   产出位置接受 workDir 或 assistant home 下的 `清单-整理.md`；
 *   assistant home 侧使用 setup 写入的 `.eval-started-at` 时间戳限定本次运行的产物。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { check, finalize, sh, type AssertCtx, type AssertResult } from '../../harness.js';

const OUT_NAME = '清单-整理.md';

/** 在 dir 两层内找本 run 期间 (mtime >= startedAt) 产出的 OUT_NAME */
function findRecentOutput(dir: string, startedAt: number): string | null {
  try {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const st = statSync(p);
      if (st.isFile() && entry === OUT_NAME && st.mtimeMs >= startedAt) return p;
      if (st.isDirectory()) {
        const inner = join(p, OUT_NAME);
        if (existsSync(inner) && statSync(inner).mtimeMs >= startedAt) return inner;
      }
    }
  } catch { /* dir 不存在 = 没找到 */ }
  return null;
}

export async function assert(ctx: AssertCtx): Promise<AssertResult> {
  const startedAt = Number(readFileSync(join(ctx.workDir, '.eval-started-at'), 'utf8').trim() || '0');

  /* 位置 1: workDir (用户上下文最直觉) · 位置 2: ~/Neox/assistant/ (assistant 模式设计落点) */
  const inWorkDir = join(ctx.workDir, OUT_NAME);
  const outPath = existsSync(inWorkDir)
    ? inWorkDir
    : findRecentOutput(join(homedir(), 'Neox', 'assistant'), startedAt);
  const produced = !!outPath;
  const content = outPath ? readFileSync(outPath, 'utf8') : '';

  /* 原文件未动: 只看 modify/delete; untracked 新文件 (.eval-started-at 是 setup 在 git init 前写的, 已入库) 不算 */
  const diff = await sh('git status --porcelain', ctx.workDir);
  const touchedOriginal = /^\s*[MD]+\s+.*购物清单\.txt/m.test(diff.stdout);

  /* 分类结构: 至少 2 个 markdown 标题或分组行 (## / ** / 类别:) */
  const groups = (content.match(/^(#{1,3}\s|\*\*|.+[:：]\s*$)/gm) ?? []).length;

  /* 预算总计 = 12+35+8+15+18+10+22+45 = 165 */
  const totalRight = /165/.test(content) || /165/.test(ctx.stdout);

  return finalize([
    check('产出 清单-整理.md (workDir 或 assistant home)', produced, outPath ?? 'missing in both locations'),
    check('有分类结构 (>=2 组)', groups >= 2, `groups=${groups} @ ${outPath ?? '-'}`),
    check('预算总计正确 (165)', totalRight),
    check('原文件未被修改', !touchedOriginal, diff.stdout.slice(0, 120).replace(/\n/g, ' ')),
  ]);
}
