import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, assertTestsPass, assertUntampered, runCheck, sha256File, workdirFromArgv } from '../../lib/check-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

runCheck(async () => {
  const workdir = workdirFromArgv();

  // 测试文件应与 gen.mjs 生成的完全一致: 现场重新生成一份, 不手抄哈希
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'big-repo-config-'));
  try {
    const gen = spawnSync(process.execPath, [path.join(HERE, 'gen.mjs'), fresh], { encoding: 'utf8', timeout: 120_000 });
    assert(gen.status === 0, `重新生成 fixture 失败: ${gen.stderr}`);
    assertUntampered(workdir, 'test/timeout.test.mjs', sha256File(path.join(fresh, 'test/timeout.test.mjs')));
  } finally {
    fs.rmSync(fresh, { recursive: true, force: true });
  }

  assertTestsPass(workdir, ['test/timeout.test.mjs'], '超时测试');

  const runtime = fs.readFileSync(path.join(workdir, 'src/config/runtime.mjs'), 'utf8');
  assert(/HTTP_TIMEOUT_MS\s*=\s*8000\b/.test(runtime), `真正生效的 HTTP_TIMEOUT_MS 应为 8000, 实际:\n${runtime}`);

  for (const decoy of ['src/config/defaults.mjs', 'src/config/legacy.mjs', 'src/modules/mod000.mjs']) {
    const source = fs.readFileSync(path.join(workdir, decoy), 'utf8');
    assert(!/8000/.test(source), `${decoy} 是无关配置/历史遗留, 不应被修改`);
  }
});
