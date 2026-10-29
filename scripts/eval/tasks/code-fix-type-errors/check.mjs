import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assert,
  assertCommandPass,
  assertUntampered,
  runCheck,
  sha256File,
  workdirFromArgv,
} from '../../lib/check-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_HASH = sha256File(path.join(HERE, 'fixture/test/behavior.test.ts'));

runCheck(async () => {
  const workdir = workdirFromArgv();
  assertUntampered(workdir, 'test/behavior.test.ts', TEST_HASH);

  for (const file of ['types.ts', 'users.ts', 'index.ts']) {
    const source = fs.readFileSync(path.join(workdir, 'src', file), 'utf8');
    assert(!/@ts-ignore|@ts-expect-error/.test(source), `${file} 用了 @ts-ignore 绕过类型检查`);
    assert(!/\bas\s+any\b|:\s*any\b/.test(source), `${file} 用了 any 绕过类型检查`);
  }

  assertCommandPass('tsc', ['--noEmit', '-p', '.'], { cwd: workdir, timeoutMs: 180_000 }, 'tsc --noEmit');
  assertCommandPass(
    process.execPath,
    ['--experimental-strip-types', '--test', 'test/behavior.test.ts'],
    { cwd: workdir },
    '行为测试',
  );
});
