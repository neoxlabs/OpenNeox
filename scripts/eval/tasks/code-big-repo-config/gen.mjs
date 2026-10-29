import * as fs from 'node:fs';
import * as path from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('用法: node gen.mjs <target-dir>');
  process.exit(1);
}

function write(relative, content) {
  const file = path.join(target, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const MODULE_COUNT = 600;

write('package.json', `${JSON.stringify({ name: 'big-repo', type: 'module', private: true }, null, 2)}\n`);

/* 真正生效的配置 */
write(
  'src/config/runtime.mjs',
  `import { DEFAULT_TIMEOUT_MS } from './defaults.mjs';

export const HTTP_TIMEOUT_MS = 5000;

export function requestTimeout() {
  return HTTP_TIMEOUT_MS || DEFAULT_TIMEOUT_MS;
}
`,
);

/* 没被引用的默认值 / 历史遗留配置 —— 都是 5000, 改它们不会让测试通过 */
write('src/config/defaults.mjs', 'export const DEFAULT_TIMEOUT_MS = 5000;\n');
write('src/config/legacy.mjs', 'export const HTTP_TIMEOUT_MS = 5000;\nexport const LEGACY_NOTE = "v0 配置, 已不再引用";\n');

const imports = [];
const names = [];
for (let index = 0; index < MODULE_COUNT; index += 1) {
  const id = String(index).padStart(3, '0');
  const name = `mod${id}`;
  imports.push(`import * as ${name} from './mod${id}.mjs';`);
  names.push(name);
  const legacyBlock =
    index % 20 === 0
      ? `\n/* 历史遗留, 本模块自己的重试超时: HTTP_TIMEOUT_MS = 5000 */\nconst HTTP_TIMEOUT_MS = 5000;\nexport const legacyTimeout = HTTP_TIMEOUT_MS;\n`
      : '';
  write(
    `src/modules/mod${id}.mjs`,
    `export const moduleId = ${index};\nexport function scale(value) { return value + ${index}; }\n${legacyBlock}`,
  );
}

write(
  'src/modules/index.mjs',
  `${imports.join('\n')}\n\nexport const modules = [${names.join(', ')}];\n\nexport function moduleCount() {\n  return modules.length;\n}\n`,
);

write(
  'test/timeout.test.mjs',
  `import test from 'node:test';
import assert from 'node:assert/strict';
import { requestTimeout } from '../src/config/runtime.mjs';
import { moduleCount } from '../src/modules/index.mjs';

test('请求超时为 8000ms', () => {
  assert.equal(requestTimeout(), 8000);
});

test('600 个模块都加载了', () => {
  assert.equal(moduleCount(), 600);
});
`,
);
