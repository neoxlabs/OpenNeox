import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assert,
  assertUntampered,
  runNodeTest,
  runCheck,
  sha256File,
  workdirFromArgv,
} from '../../lib/check-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_HASH = sha256File(path.join(HERE, 'fixture/src/validate.mjs'));
const TEST_FILE = 'test/validate.test.mjs';

const MUTANTS = [
  ['pw.length < 8', 'pw.length < 7', '长度边界 (7/8)'],
  ['[A-Z]', '[a-z]', '大写字母分支'],
  ["if (typeof pw !== 'string')", 'if (false)', '非字符串分支'],
];

runCheck(async () => {
  const workdir = workdirFromArgv();
  assertUntampered(workdir, 'src/validate.mjs', SOURCE_HASH);

  const testPath = path.join(workdir, TEST_FILE);
  assert(fs.existsSync(testPath), '没有新建 test/validate.test.mjs');
  const source = fs.readFileSync(testPath, 'utf8');
  const cases = (source.match(/\b(?:test|it)\s*\(/g) ?? []).length;
  assert(cases >= 4, `测试用例太少 (${cases} 个), 至少要覆盖 4 个分支`);
  assert(/from\s+['"]\.\.\/src\/validate\.mjs['"]/.test(source), '测试没有从 ../src/validate.mjs 导入');

  const clean = runNodeTest(workdir, [TEST_FILE]);
  assert(clean.code === 0, `提交的测试自身没通过 (exit=${clean.code})\n${clean.out.slice(-2000)}`);

  // 变异测试: 改坏实现的一个分支, 提交的测试必须能抓出来
  const sourcePath = path.join(workdir, 'src/validate.mjs');
  const original = fs.readFileSync(sourcePath, 'utf8');
  try {
    for (const [from, to, label] of MUTANTS) {
      assert(original.includes(from), `实现里找不到变异点 ${from} (src/validate.mjs 不允许修改)`);
      fs.writeFileSync(sourcePath, original.replace(from, to));
      const mutated = runNodeTest(workdir, [TEST_FILE]);
      assert(mutated.code !== 0, `测试没有覆盖「${label}」: 改坏该分支后测试仍然通过`);
    }
  } finally {
    fs.writeFileSync(sourcePath, original);
  }
});
