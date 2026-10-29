import test from 'node:test';
import assert from 'node:assert/strict';
import { paginate, pageCount } from '../src/paging.mjs';

test('每页 2 个', () => {
  assert.deepEqual(paginate([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(paginate([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
});

test('页数向上取整', () => {
  assert.equal(pageCount(5, 2), 3);
  assert.equal(pageCount(4, 2), 2);
  assert.equal(pageCount(0, 2), 0);
});

test('非法页长返回空', () => {
  assert.deepEqual(paginate([1, 2], 0), []);
});
