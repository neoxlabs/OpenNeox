/**
 * 生成一个大一点的 fixture: 300 个模块 + 聚合流水线 + 一个滚动哈希 (故意从 0 起算)。
 * 内容确定 (无时间戳), 所以测试文件哈希稳定, 判分脚本可以钉死。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('用法: node gen.mjs <target-dir>');
  process.exit(1);
}

const MODULE_COUNT = 300;
const MODULUS = 1000003;
const SEED = 7;

/** 正确的滚动哈希 (以 SEED 起算), 用来算测试里的期望值 */
function checksum(values) {
  let hash = SEED;
  for (const value of values) hash = (hash * 31 + value) % MODULUS;
  return hash;
}

const write = (relative, content) => {
  const file = path.join(target, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

write('package.json', `${JSON.stringify({ name: 'big-fixture', version: '1.0.0', type: 'module', private: true }, null, 2)}\n`);
write(
  'README.md',
  `# big-fixture

- \`src/modules/mNNN/\`: 每个模块一个 \`mod.mjs\` 和一份 \`meta.json\`，导出 \`scale(value)\`。
- \`src/core/pipeline.mjs\`: 把所有模块聚合成流水线。
- \`src/core/checksum.mjs\`: 对聚合结果做滚动哈希。
- \`test/\`: 测试。
`,
);

const moduleIds = [];
for (let index = 1; index <= MODULE_COUNT; index += 1) {
  const id = `m${String(index).padStart(3, '0')}`;
  const factor = 1 + (index % 5);
  moduleIds.push(id);
  write(
    `src/modules/${id}/meta.json`,
    `${JSON.stringify({ id, factor, owner: `team-${(index % 7) + 1}` }, null, 2)}\n`,
  );
  write(
    `src/modules/${id}/mod.mjs`,
    `export const id = '${id}';
export const factor = ${factor};

export function scale(value) {
  return value * factor;
}
`,
  );
}

const importLines = moduleIds.map((id) => `import * as ${id} from '../modules/${id}/mod.mjs';`);
const listItems = moduleIds.map((id) => `  ${id},`);
write(
  'src/core/pipeline.mjs',
  `${importLines.join('\n')}

import { checksum } from './checksum.mjs';

const modules = [
${listItems.join('\n')}
];

export function moduleCount() {
  return modules.length;
}

export function runAll(values) {
  const scaled = [];
  for (const mod of modules) {
    for (const value of values) scaled.push(mod.scale(value));
  }
  return { values: scaled, checksum: checksum(scaled) };
}
`,
);

write(
  'src/core/checksum.mjs',
  `export const SEED = ${SEED};
const MODULUS = ${MODULUS};

/** 滚动哈希: 每步先乘 31 再加当前值。 */
export function checksum(values) {
  let hash = 0;
  for (const value of values) hash = (hash * 31 + value) % MODULUS;
  return hash;
}
`,
);

const pipelineVector = checksum(
  moduleIds.flatMap((id, index) => [2 * (1 + ((index + 1) % 5))]),
);

write(
  'test/pipeline.test.mjs',
  `import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleCount, runAll } from '../src/core/pipeline.mjs';
import { checksum, SEED } from '../src/core/checksum.mjs';

test('300 个模块都加载了', () => {
  assert.equal(moduleCount(), ${MODULE_COUNT});
});

test('每个输入为每个模块产出一个值', () => {
  assert.equal(runAll([1, 2]).values.length, ${MODULE_COUNT * 2});
});

test('滚动哈希从 SEED 起算', () => {
  assert.equal(checksum([]), SEED);
});

test('滚动哈希的已知向量', () => {
  assert.equal(checksum([1, 2, 3]), 209563);
});

test('整条流水线的哈希', () => {
  assert.equal(runAll([2]).checksum, ${pipelineVector});
});
`,
);
