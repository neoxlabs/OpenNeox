import { calculateTotal } from './pricing.mjs';

export function reportTotal(lines) {
  const rounded = Math.round(calculateTotal(lines, 0.05) * 100) / 100;
  return `合计: ${rounded.toFixed(2)}`;
}
