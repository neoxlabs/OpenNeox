import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assert,
  assertCommandPass,
  assertUntampered,
  runCheck,
  sha256File,
  workdirFromArgv,
} from '../../lib/check-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_HASH = sha256File(path.join(HERE, 'fixture/tests/test_textwrap.py'));

const HIDDEN_SOURCE = `import unittest

from src.textwrap import join_lines, wrap_words


class HiddenBenchTest(unittest.TestCase):
    def test_boundary(self):
        self.assertEqual(wrap_words("aaa bbb", 7), ["aaa bbb"])
        self.assertEqual(wrap_words("aaa bbb", 6), ["aaa", "bbb"])

    def test_empty_join(self):
        self.assertEqual(join_lines([]), "")

    def test_multiple_lines(self):
        self.assertEqual(wrap_words("a b c d", 3), ["a b", "c d"])


if __name__ == "__main__":
    unittest.main()
`;

runCheck(async () => {
  const workdir = workdirFromArgv();
  assertUntampered(workdir, 'tests/test_textwrap.py', TEST_HASH);
  assertCommandPass('python3', ['-m', 'unittest', 'discover', '-s', 'tests', '-v'], { cwd: workdir }, '现有测试');

  const hiddenPath = path.join(workdir, 'tests/test_hidden_bench.py');
  fs.writeFileSync(hiddenPath, HIDDEN_SOURCE);
  try {
    assertCommandPass('python3', ['-m', 'unittest', 'tests.test_hidden_bench', '-v'], { cwd: workdir }, '隐藏测试');
  } finally {
    fs.rmSync(hiddenPath, { force: true });
  }

  const result = assertCommandPass(
    'python3',
    ['-c', 'from src.textwrap import wrap_words; assert wrap_words("aa bb cc", 5) == ["aa bb", "cc"]; print("ok")'],
    { cwd: workdir },
    '向量抽查',
  );
  assert(result.includes('ok'), '向量抽查没有输出 ok');
});
