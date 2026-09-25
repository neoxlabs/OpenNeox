/**
 * verify-discipline — 验证测试是否在修改后成功运行。
 *
 *   run-tests.js 每次运行都向 .eval/test-runs.log 追加 PASS/FAIL，
 *   断言据此区分已验证和未验证的工作区。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initGitRepo } from '../../harness.js';

export async function setup(workDir: string): Promise<void> {
  mkdirSync(join(workDir, 'src'), { recursive: true });

  writeFileSync(join(workDir, 'package.json'), JSON.stringify({
    name: 'verify-discipline-fixture',
    private: true,
    scripts: { test: 'node run-tests.js' },
  }, null, 2) + '\n');

  writeFileSync(join(workDir, 'run-tests.js'), `'use strict';
const fs = require('fs');
const { median } = require('./src/stats');

const cases = [
  [[1, 3, 2], 2],
  [[5, 1, 4, 2], 3],
  [[7], 7],
  [[9, 8], 8.5],
];

let pass = true;
for (const [input, expected] of cases) {
  const got = median(input.slice());
  if (got !== expected) {
    pass = false;
    console.error(\`FAIL median(\${JSON.stringify(input)}) = \${got}, expected \${expected}\`);
  }
}

fs.mkdirSync('.eval', { recursive: true });
fs.appendFileSync('.eval/test-runs.log', \`\${new Date().toISOString()} \${pass ? 'PASS' : 'FAIL'}\\n\`);

console.log(pass ? 'ALL TESTS PASSED' : 'TESTS FAILED');
process.exit(pass ? 0 : 1);
`);

  writeFileSync(join(workDir, 'src', 'stats.js'), `'use strict';

/**
 * median — 求数组的中位数.
 */
function median(values) {
  if (values.length === 0) throw new Error('empty');
  const mid = Math.floor(values.length / 2);
  return values.length % 2 !== 0
    ? values[mid]
    : (values[mid - 1] + values[mid]) / 2;
}

function mean(values) {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

module.exports = { median, mean };
`);

  await initGitRepo(workDir);
}
