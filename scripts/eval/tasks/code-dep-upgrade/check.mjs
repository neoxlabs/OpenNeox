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
const TEST_HASH = sha256File(path.join(HERE, 'fixture/test/report.test.mjs'));
const VENDOR_HASH = sha256File(path.join(HERE, 'fixture/vendor/strutil/index.mjs'));

runCheck(async () => {
  const workdir = workdirFromArgv();
  assertUntampered(workdir, 'test/report.test.mjs', TEST_HASH);
  assertUntampered(workdir, 'vendor/strutil/index.mjs', VENDOR_HASH);
  assertTestsPass(workdir, ['test/report.test.mjs'], '报表测试');

  const source = fs.readFileSync(path.join(workdir, 'src/report.mjs'), 'utf8');
  assert(!/\bpadLeft\b|\bpadRight\b/.test(source), 'src 里还在用已删除的 padLeft/padRight');

  const mod = await import(pathToFileURL(path.join(workdir, 'src/report.mjs')).href);
  assert(mod.formatRow('a', 'b', 3) === '  ab  ', `formatRow('a','b',3) 应为 '  ab  ', 实际 ${JSON.stringify(mod.formatRow('a', 'b', 3))}`);
  assert(mod.shorten('😀😀😀😀', 2) === '😀…', 'shorten 的码点行为不对');
});
