import test from 'node:test';
import assert from 'node:assert/strict';
import { enumerateDays, monthKey } from '../src/dateRange.mjs';

test('包含首尾两天', () => {
  assert.deepEqual(enumerateDays('2026-03-01', '2026-03-03'), ['2026-03-01', '2026-03-02', '2026-03-03']);
});

test('单日区间', () => {
  assert.deepEqual(enumerateDays('2026-03-03', '2026-03-03'), ['2026-03-03']);
});

test('跨月枚举', () => {
  assert.deepEqual(enumerateDays('2026-01-30', '2026-02-02'), ['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']);
});

test('月份补零', () => {
  assert.equal(monthKey('2026-03-05'), '2026-03');
});

test('十二月的月份键', () => {
  assert.equal(monthKey('2026-12-31'), '2026-12');
});
