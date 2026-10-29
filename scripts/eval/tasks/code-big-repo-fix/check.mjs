import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assert,
  assertTestsPass,
  assertUntampered,
  runCheck,
  workdirFromArgv,
} from '../../lib/check-helpers.mjs';

const TEST_HASH = 'c2dae0eefd64703fed37af41deabf385580a537c9b1c45cb6335679c8edf6f78';

runCheck(async () => {
  const workdir = workdirFromArgv();
  assertUntampered(workdir, 'test/pipeline.test.mjs', TEST_HASH);
  assertTestsPass(workdir, ['test/pipeline.test.mjs'], '大 fixture 测试');

  // 直接从模块验证算法: 防止把 fixture 里的数据改小/改掉来让测试碰巧通过
  const checksumModule = await import(pathToFileURL(path.join(workdir, 'src/core/checksum.mjs')).href);
  assert(checksumModule.checksum([]) === 7, `checksum([]) 应为 7, 实际 ${checksumModule.checksum([])}`);
  assert(checksumModule.checksum([1, 2, 3]) === 209563, 'checksum([1,2,3]) 应为 209563');
  assert(checksumModule.checksum([5]) === 222, `checksum([5]) 应为 222, 实际 ${checksumModule.checksum([5])}`);

  const pipeline = await import(pathToFileURL(path.join(workdir, 'src/core/pipeline.mjs')).href);
  assert(pipeline.moduleCount() === 300, `模块数应为 300, 实际 ${pipeline.moduleCount()}`);
  assert(pipeline.runAll([2]).values.length === 300, '每个模块都应产出一个值');
});
