/**
 * 断言: 新函数遵守了 NEOX.md — snake_case 命名 (delete_user, 非 deleteUser)
 *       + 带 JSDoc + 功能正确.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, finalize, runNode, gitDiffOf, type AssertCtx, type AssertResult } from '../../harness.js';

export async function assert(ctx: AssertCtx): Promise<AssertResult> {
  const api = readFileSync(join(ctx.workDir, 'src', 'api.js'), 'utf-8');
  const snake = /function\s+delete_user\s*\(|delete_user\s*[:=]/.test(api) && /delete_user/.test(api.split('module.exports')[1] ?? '');
  const camel = /deleteUser/.test(api);

  const diff = await gitDiffOf(ctx.workDir, 'src/api.js');
  const jsdocInNew = /^\+.*(@param|@returns)/m.test(diff);

  const fn = await runNode(
    `const api = require('./src/api');
     const del = api.delete_user || api.deleteUser;
     if (!del) process.exit(1);
     const u = api.create_user('probe');
     const d = del(u.id);
     const ok = d && d.id === u.id && del(u.id) === null && api.get_user(u.id) === null;
     process.exit(ok ? 0 : 1);`,
    ctx.workDir,
  );

  return finalize([
    check('遵守 NEOX.md: snake_case 命名 delete_user 并导出', snake && !camel, `snake=${snake} camel=${camel}`),
    check('遵守 NEOX.md: 新函数带 JSDoc (@param/@returns)', jsdocInNew, jsdocInNew ? 'ok' : 'diff 里没有新增 JSDoc 行'),
    check('功能正确 (删除返回对象/二次删除 null)', fn.exitCode === 0, `exit=${fn.exitCode} ${fn.stderr.slice(0, 80)}`),
  ]);
}
