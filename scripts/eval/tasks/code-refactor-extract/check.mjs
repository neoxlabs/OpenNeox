import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assert,
  assertTestsPass,
  assertUntampered,
  runCheck,
  sha256File,
  workdirFromArgv,
} from '../../lib/check-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_HASH = sha256File(path.join(HERE, 'fixture/test/runtime.test.mjs'));
const HIDDEN_TEST = '.bench-hidden.test.mjs';

const HIDDEN_SOURCE = `import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from './src/time/parseDuration.mjs';

test('新模块可独立使用', () => {
  assert.equal(parseDuration('1h'), 3600000);
  assert.equal(parseDuration('250ms'), 250);
});
`;

runCheck(async () => {
  const workdir = workdirFromArgv();
  assertUntampered(workdir, 'test/runtime.test.mjs', TEST_HASH);
  assertTestsPass(workdir, ['test/runtime.test.mjs'], '现有测试');

  const newPath = path.join(workdir, 'src/time/parseDuration.mjs');
  assert(fs.existsSync(newPath), '新模块 src/time/parseDuration.mjs 不存在');
  assert(/export\s+function\s+parseDuration\b/.test(fs.readFileSync(newPath, 'utf8')), '新模块没有导出 parseDuration');

  const runtimeSource = fs.readFileSync(path.join(workdir, 'src/runtime.mjs'), 'utf8');
  assert(!/parseDuration/.test(runtimeSource), 'src/runtime.mjs 里还留着 parseDuration（不要转发再导出）');
  assert(/export\s+function\s+formatCount\b/.test(runtimeSource), 'runtime.mjs 的 formatCount 被误删');

  for (const file of ['schedule.mjs', 'config.mjs', 'cli.mjs']) {
    const source = fs.readFileSync(path.join(workdir, 'src', file), 'utf8');
    assert(/from\s+['"]\.\/time\/parseDuration\.mjs['"]/.test(source), `${file} 没有改成从新模块 import`);
  }

  const hiddenPath = path.join(workdir, HIDDEN_TEST);
  fs.writeFileSync(hiddenPath, HIDDEN_SOURCE);
  try {
    assertTestsPass(workdir, [HIDDEN_TEST], '隐藏测试');
  } finally {
    fs.rmSync(hiddenPath, { force: true });
  }

  const mod = await import(pathToFileURL(newPath).href);
  assert(mod.parseDuration('45s') === 45_000, '新模块行为不对');
});
