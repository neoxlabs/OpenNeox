import { calculateTotal } from './pricing.mjs';

const items = [
  { price: 20, qty: 2 },
  { price: 5.5, qty: 1 },
];

console.log(calculateTotal(items, 0.1).toFixed(2));
