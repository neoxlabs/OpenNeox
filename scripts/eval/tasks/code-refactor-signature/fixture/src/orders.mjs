import { calculateTotal } from './pricing.mjs';

export function orderTotal(order) {
  return calculateTotal(order.items, 0.08);
}
