import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assert,
  assertTestsPass,
  assertUntampered,
  runCheck,
  workdirFromArgv,
} from '../../lib/check-helpers.mjs';

const TEST_HASH = 'c28d464cffe7e4ae4ad955f455955d5e167f72bb39f37824fcd1b99b94140c91';

runCheck(async () => {
  const workdir = workdirFromArgv();
  assertUntampered(workdir, 'test/date-range.test.mjs', TEST_HASH);
  assertTestsPass(workdir, ['test/date-range.test.mjs'], '日期测试');

  const module = await import(pathToFileURL(path.join(workdir, 'src/dateRange.mjs')).href);
  const weekend = module.enumerateDays('2026-05-29', '2026-05-31');
  assert(weekend.length === 3, `跨周末枚举应得 3 天, 实际 ${weekend.length}`);
  assert(module.monthKey('2026-06-15') === '2026-06', `monthKey 应补零, 实际 ${module.monthKey('2026-06-15')}`);
  assert(module.enumerateDays('2026-03-05', '2026-03-01').length === 0, '起止倒置时应该返回空数组');
});
