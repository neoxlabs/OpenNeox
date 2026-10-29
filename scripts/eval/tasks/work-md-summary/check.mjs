import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert, assertAnyOf, runCheck, workdirFromArgv } from '../../lib/check-helpers.mjs';

runCheck(async () => {
  const workdir = workdirFromArgv();
  const file = path.join(workdir, 'SUMMARY.md');
  assert(fs.existsSync(file), '没有生成 SUMMARY.md');
  const text = fs.readFileSync(file, 'utf8');

  const compact = text.replace(/\s+/g, '');
  assert(compact.length <= 500, `摘要太长 (${compact.length} 字, 要求 400 字以内)`);
  assert(compact.length >= 60, '摘要太短, 没有实质内容');

  assertAnyOf(text, [/11\s*月\s*5\s*日/, /11\/5/, /11-05/], '没有写发布日期 11 月 5 日');
  assertAnyOf(text, [/中小电商/, /电商运营/, /运营团队/], '没有写目标用户');
  for (const feature of ['批量上架', '库存预警', '对账导出']) {
    assert(text.includes(feature), `没有写核心功能「${feature}」`);
  }
  assertAnyOf(text, [/29\s*元\s*\/\s*月/, /29\s*元每月/, /每月\s*29\s*元/], '没有写定价 29 元/月');
  assertAnyOf(text, [/审核[^。\n]{0,20}(2|两)\s*周/, /(2|两)\s*周[^。\n]{0,20}审核/], '没有写审核周期 2 周的风险');
});
