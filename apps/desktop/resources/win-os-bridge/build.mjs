import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const OUT = join(DIR, 'neox-os-bridge.exe');
const BUILT = join(DIR, 'target', 'release', 'neox-os-bridge.exe');

console.log('[win-os-bridge] cargo build --release …');
const r = spawnSync('cargo', ['build', '--release'], { cwd: DIR, stdio: 'inherit', shell: true });
if (r.status !== 0) {
  console.error('[win-os-bridge] 构建失败');
  process.exit(r.status ?? 1);
}

if (!existsSync(BUILT)) {
  console.error(`[win-os-bridge] 没找到产物: ${BUILT}`);
  process.exit(1);
}
copyFileSync(BUILT, OUT);
console.log(`[win-os-bridge] ✓ ${(statSync(OUT).size / 1024 / 1024).toFixed(2)} MB → neox-os-bridge.exe`);

/* 自检: 打一行探测回执就退。桥起不来要在这里就红, 别等客户端里才发现。 */
console.log('[win-os-bridge] 自检 --probe …');
const probe = spawnSync(OUT, ['--probe'], { encoding: 'utf8' });
process.stdout.write(probe.stdout || '');
if (probe.status !== 0 || !(probe.stdout || '').includes('"ok":true')) {
  console.error('[win-os-bridge] 自检失败');
  process.exit(1);
}
