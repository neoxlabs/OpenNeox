import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import {
  assert,
  assertTestsPass,
  assertUntampered,
  runCheck,
  sha256File,
  workdirFromArgv,
} from '../../lib/check-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_HASH = sha256File(path.join(HERE, 'fixture/test/totals.test.mjs'));
const HIDDEN_TEST = '.bench-hidden.test.mjs';

const HIDDEN_SOURCE = `import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateTotal } from './src/pricing.mjs';

const items = [{ price: 10, qty: 2 }];

test('新签名: 默认不计税不打折', () => {
  assert.equal(calculateTotal(items), 20);
});

test('新签名: 税率从 options 读', () => {
  assert.equal(calculateTotal(items, { taxRate: 0.1 }), 22);
});

test('新签名: 折扣先扣再计税', () => {
  assert.equal(calculateTotal(items, { discount: 5 }), 15);
  assert.equal(calculateTotal(items, { discount: 5, taxRate: 0.1 }), 16.5);
});

test('折扣不能把小计扣成负数', () => {
  assert.equal(calculateTotal(items, { discount: 999 }), 0);
});
`;

runCheck(async () => {
  const workdir = workdirFromArgv();
  assertUntampered(workdir, 'test/totals.test.mjs', TEST_HASH);
  assertTestsPass(workdir, ['test/totals.test.mjs'], '现有测试');

  // 所有调用点都必须走新签名: 不允许再出现第二个位置参数
  for (const file of fs.readdirSync(path.join(workdir, 'src'))) {
    if (!file.endsWith('.mjs')) continue;
    const source = fs.readFileSync(path.join(workdir, 'src', file), 'utf8');
    assert(
      !/calculateTotal\([^)]*,\s*[\d.]/.test(source),
      `${file} 里还有传位置参数 taxRate 的旧调用点`,
    );
  }

  const hiddenPath = path.join(workdir, HIDDEN_TEST);
  fs.writeFileSync(hiddenPath, HIDDEN_SOURCE);
  try {
    assertTestsPass(workdir, [HIDDEN_TEST], '隐藏测试');
  } finally {
    fs.rmSync(hiddenPath, { force: true });
  }

  const pricing = await import(pathToFileURL(path.join(workdir, 'src/pricing.mjs')).href);
  assert(pricing.calculateTotal([{ price: 1, qty: 1 }], {}) === 1, '空 options 应等价于不计税');
});
