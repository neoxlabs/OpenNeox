/**
 * 断言: draft.md 真被改写 (口水词清掉) + 关键事实保留 + 只动这一个文件.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, finalize, sh, type AssertCtx, type AssertResult } from '../../harness.js';

export async function assert(ctx: AssertCtx): Promise<AssertResult> {
  const revised = readFileSync(join(ctx.workDir, 'draft.md'), 'utf8');

  /* 真的改了: 口水填充词应被清理 (原文密度极高, 留 1 处以内算过) */
  const fillers = (revised.match(/的话|就是想|这样子|大概都|基本上还算/g) ?? []).length;
  const changed = fillers <= 1;

  /* 关键事实保留: 产品名 / 交付日期 / 验收周期 */
  const factsKept = /星桥/.test(revised) && /8\s*月\s*15|8月15/.test(revised) && /两周|2\s*周/.test(revised);

  /* 只动 draft.md: porcelain 里除 draft.md 外不应有其它 修改/新增 (允许 agent 留一份备份? 不允许 — 保持最小改动) */
  const st = await sh('git status --porcelain', ctx.workDir);
  const lines = st.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const onlyDraft = lines.length > 0 && lines.every((l) => l.endsWith('draft.md'));

  return finalize([
    check('draft.md 被真实改写 (口水词清理)', changed, `fillers=${fillers}`),
    check('关键事实保留 (星桥/8月15/两周)', factsKept, revised.slice(0, 140).replace(/\n/g, ' ')),
    check('只动 draft.md (最小改动)', onlyDraft, st.stdout.replace(/\n/g, ' ').slice(0, 120)),
    check('回复说明了改动', /(润色|修改|调整|改写|优化|revis|polish)/i.test(ctx.stdout), undefined, true),
  ]);
}
