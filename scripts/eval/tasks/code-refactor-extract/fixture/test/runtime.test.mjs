import test from 'node:test';
import assert from 'node:assert/strict';
import { delayFor } from '../src/schedule.mjs';
import { readTimeout } from '../src/config.mjs';
import { formatCount } from '../src/runtime.mjs';

test('调度时长', () => {
  assert.equal(delayFor('2h'), 7_200_000);
});

test('配置默认超时', () => {
  assert.equal(readTimeout({}), 30_000);
  assert.equal(readTimeout({ timeout: 500 }), 500);
});

test('runtime 的其它导出不受影响', () => {
  assert.equal(formatCount(3), '3 项');
});
