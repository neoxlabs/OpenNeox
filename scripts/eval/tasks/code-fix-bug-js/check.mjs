import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assert,
  assertTestsPass,
  assertUntampered,
  runCheck,
  sha256File,
  workdirFromArgv,
} from '../../lib/check-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_HASH = sha256File(path.join(HERE, 'fixture/test/paging.test.mjs'));

runCheck(async () => {
  const workdir = workdirFromArgv();
  assertUntampered(workdir, 'test/paging.test.mjs', TEST_HASH);
  assertTestsPass(workdir, ['test/paging.test.mjs'], '分页测试');

  const mod = await import(pathToFileURL(path.join(workdir, 'src/paging.mjs')).href);
  assert(JSON.stringify(mod.paginate([1, 2, 3], 1)) === JSON.stringify([[1], [2], [3]]), 'pageSize=1 每页应 1 个');
  assert(mod.pageCount(10, 3) === 4, `pageCount(10,3) 应为 4, 实际 ${mod.pageCount(10, 3)}`);
  assert(mod.pageCount(9, 3) === 3, '整除时不应多算一页');
});
