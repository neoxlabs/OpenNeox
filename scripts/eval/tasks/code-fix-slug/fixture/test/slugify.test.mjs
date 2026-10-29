import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slugify.mjs';

test('合并连续空白', () => {
  assert.equal(slugify('Hello,   World!'), 'hello-world');
});

test('去掉首尾分隔符', () => {
  assert.equal(slugify('  --Hello  '), 'hello');
});

test('重音字符转成基本字母而不是丢弃', () => {
  assert.equal(slugify('Crème Brûlée'), 'creme-brulee');
});

test('点号和 & 直接去掉', () => {
  assert.equal(slugify('Node.js & TypeScript'), 'nodejs-typescript');
});
