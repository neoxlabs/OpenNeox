import test from 'node:test';
import assert from 'node:assert/strict';
import { orderTotal } from '../src/orders.mjs';
import { reportTotal } from '../src/reports.mjs';

test('订单按 8% 计税', () => {
  assert.equal(orderTotal({ items: [{ price: 100, qty: 2 }] }), 216);
});

test('报表按 5% 计税并保留两位', () => {
  assert.equal(reportTotal([{ price: 10, qty: 1 }]), '合计: 10.50');
});
