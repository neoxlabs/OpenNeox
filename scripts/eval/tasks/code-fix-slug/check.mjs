import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assert,
  assertTestsPass,
  assertUntampered,
  runCheck,
  workdirFromArgv,
} from '../../lib/check-helpers.mjs';

const TEST_HASH = 'ed978bd97d34bae1905acc663c0cdc48124cccff09c0637b4785fbffb74f761c';

runCheck(async () => {
  const workdir = workdirFromArgv();
  assertUntampered(workdir, 'test/slugify.test.mjs', TEST_HASH);
  assertTestsPass(workdir, ['test/slugify.test.mjs'], 'slug 测试');

  // 测试之外再抽几个向量: 防止只针对测试里的三个输入打补丁
  const module = await import(pathToFileURL(path.join(workdir, 'src/slugify.mjs')).href);
  const cases = [
    ['  Hello -- World  ', 'hello-world'],
    ['Über Café', 'uber-cafe'],
    ['C++ / Rust', 'c-rust'],
  ];
  for (const [input, expected] of cases) {
    const actual = module.slugify(input);
    assert(actual === expected, `slugify(${JSON.stringify(input)}) = ${JSON.stringify(actual)}, 期望 ${JSON.stringify(expected)}`);
  }
});
