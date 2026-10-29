import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLine, parseArgs } from '../src/format.mjs';

test('默认没有前缀', () => {
  assert.equal(formatLine('hi'), 'hi\n');
});

test('自定义前缀', () => {
  assert.equal(formatLine('hi', { prefix: '> ' }), '> hi\n');
});

test('解析 --prefix', () => {
  const parsed = parseArgs(['--prefix=>>', 'hello']);
  assert.equal(parsed.prefix, '>>');
  assert.equal(parsed.text, 'hello');
});

test('多个词拼成一句话', () => {
  const parsed = parseArgs(['hello', 'world']);
  assert.equal(parsed.prefix, '');
  assert.equal(parsed.text, 'hello world');
});
