import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assert,
  assertTestsPass,
  assertUntampered,
  runCheck,
  sha256File,
  workdirFromArgv,
} from '../../lib/check-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_HASH = sha256File(path.join(HERE, 'fixture/test/cli.test.mjs'));
const HIDDEN_TEST = '.bench-hidden.test.mjs';

const HIDDEN_SOURCE = `import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const run = (...args) => execFileSync(process.execPath, ['bin/notes.mjs', ...args], { encoding: 'utf8' });

test('--tag 过滤', () => {
  const lines = run('--tag', 'work').trim().split('\\n');
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.includes('(work)')));
});

test('--json 输出数组', () => {
  const all = JSON.parse(run('--json'));
  assert.equal(all.length, 3);
  assert.deepEqual(Object.keys(all[0]).sort(), ['done', 'id', 'tag', 'text']);
});

test('--json 与 --tag 组合', () => {
  const filtered = JSON.parse(run('--tag', 'work', '--json'));
  assert.equal(filtered.length, 2);
  assert.ok(filtered.every((note) => note.tag === 'work'));
});

test('没有匹配项时 --json 输出空数组', () => {
  assert.equal(JSON.parse(run('--tag', 'nope', '--json')).length, 0);
});
`;

runCheck(async () => {
  const workdir = workdirFromArgv();
  assertUntampered(workdir, 'test/cli.test.mjs', TEST_HASH);
  assertTestsPass(workdir, ['test/cli.test.mjs'], '现有测试');

  const hiddenPath = path.join(workdir, HIDDEN_TEST);
  fs.writeFileSync(hiddenPath, HIDDEN_SOURCE);
  try {
    assertTestsPass(workdir, [HIDDEN_TEST], '隐藏测试');
  } finally {
    fs.rmSync(hiddenPath, { force: true });
  }
});
