/**
 * cross-file-root-cause — bug 表象在 checkout.js (A), 真因在 discount.js (B).
 *
 *   陷阱: checkout.js 里留了一句 "舍入逻辑要 review" 的红鲱鱼注释,
 *   菜鸟会在 A 打补丁 (clamp / 自己除 100), 专家追进 B 修 applyDiscount 少除 100.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initGitRepo } from '../../harness.js';

export async function setup(workDir: string): Promise<void> {
  mkdirSync(join(workDir, 'src'), { recursive: true });

  writeFileSync(join(workDir, 'src', 'main.js'), `'use strict';
const { checkout } = require('./checkout');

const items = [
  { name: 'pen', price: 20, qty: 2 },
  { name: 'book', price: 60, qty: 1 },
];

console.log(checkout(items, 10));
`);

  writeFileSync(join(workDir, 'src', 'checkout.js'), `'use strict';
const { applyDiscount } = require('./discount');

function subtotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}

/**
 * 结账: 算出打折后的应付总价 (取整).
 * @param {Array<{price: number, qty: number}>} items 购物车
 * @param {number} discountPercent 折扣百分比, 例如 10 表示 10% off
 */
function checkout(items, discountPercent) {
  const sub = subtotal(items);
  // TODO: 这里的取整/舍入逻辑之后可能需要 review
  const finalPrice = applyDiscount(sub, discountPercent);
  return Math.round(finalPrice);
}

module.exports = { checkout, subtotal };
`);

  writeFileSync(join(workDir, 'src', 'discount.js'), `'use strict';

/**
 * applyDiscount — 按百分比打折.
 * @param {number} total 原价
 * @param {number} percent 折扣百分比, 传 10 表示 10% off
 * @returns {number} 折后价
 */
function applyDiscount(total, percent) {
  return total - total * percent;
}

module.exports = { applyDiscount };
`);

  await initGitRepo(workDir);
}
