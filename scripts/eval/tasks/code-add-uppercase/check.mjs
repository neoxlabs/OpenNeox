import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  assertTestsPass,
  assertUntampered,
  runCheck,
  workdirFromArgv,
} from '../../lib/check-helpers.mjs';

const TEST_HASH = '01cfa6a500dbd8618d4f7ae0a4a7e78c9edd3f6bb3c65ffbf61d63dda43d0c01';
const HIDDEN_TEST = '.bench-hidden.test.mjs';

const HIDDEN_SOURCE = `import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLine, parseArgs } from './src/format.mjs';

test('uppercase 只作用于正文', () => {
  assert.equal(formatLine('hello', { uppercase: true }), 'HELLO\\n');
  assert.equal(formatLine('hello', { prefix: '> ', uppercase: true }), '> HELLO\\n');
});

test('默认不做大写', () => {
  assert.equal(formatLine('Hello'), 'Hello\\n');
  assert.equal(formatLine('Hello', { prefix: '# ' }), '# Hello\\n');
});

test('--upper 开关', () => {
  assert.equal(parseArgs(['--upper', 'hi']).uppercase, true);
  assert.equal(parseArgs(['hi']).uppercase, false);
  assert.equal(parseArgs(['--upper', '--prefix=>', 'a b']).text, 'a b');
});
`;

runCheck(async () => {
  const workdir = workdirFromArgv();
  assertUntampered(workdir, 'test/format.test.mjs', TEST_HASH);
  assertTestsPass(workdir, ['test/format.test.mjs'], '现有测试');

  const hiddenPath = path.join(workdir, HIDDEN_TEST);
  fs.writeFileSync(hiddenPath, HIDDEN_SOURCE);
  try {
    assertTestsPass(workdir, [HIDDEN_TEST], '隐藏测试');
  } finally {
    fs.rmSync(hiddenPath, { force: true });
  }
});
