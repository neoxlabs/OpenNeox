import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const run = (...args) =>
  execFileSync(process.execPath, ['bin/notes.mjs', ...args], { encoding: 'utf8' });

test('默认输出文本列表', () => {
  const lines = run().trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /\[ \] 买牛奶 \(life\)/);
  assert.match(lines[2], /\[x\] 写周报 \(work\)/);
});
