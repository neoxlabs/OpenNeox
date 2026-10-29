import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRow, shorten } from '../src/report.mjs';

test('左右对齐', () => {
  assert.equal(formatRow('name', 'ok', 6), '  nameok    ');
});

test('按字符截断并加省略号', () => {
  assert.equal(shorten('abcdef', 5), 'abcd…');
  assert.equal(shorten('hello', 10), 'hello');
});

test('emoji 按码点计算', () => {
  assert.equal(shorten('😀😀😀😀', 3), '😀😀…');
});
