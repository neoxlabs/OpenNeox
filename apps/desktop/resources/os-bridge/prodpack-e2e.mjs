import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/[\\/]$/, '');
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const sh = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { return String(e.stdout ?? '') + String(e.stderr ?? ''); }
};

const dmg = process.argv[2] ?? (() => {
  const dir = join(REPO, 'release');
  const found = readdirSync(dir).filter((f) => f.endsWith('-arm64.dmg')).sort();
  return found.length ? join(dir, found[found.length - 1]) : null;
})();

if (!dmg || !existsSync(dmg)) {
  console.error('找不到 DMG。先跑 NEOX_SKIP_R2=1 bash scripts/publish/desktop-mac.sh <version>');
  process.exit(1);
}
console.log(`验收: ${dmg.split('/').pop()}\n`);

console.log('1) DMG 挂载');
const mountOut = sh('hdiutil', ['attach', dmg, '-nobrowse', '-readonly']);
const mountPoint = (mountOut.match(/\/Volumes\/[^\n\t]+/) ?? [])[0]?.trim();
check('挂载成功', !!mountPoint, mountPoint ?? mountOut.slice(0, 120));
if (!mountPoint) process.exit(1);

try {
  const app = join(mountPoint, 'Neox.app');
  check('里面有 Neox.app', existsSync(app));

  console.log('\n2) Gatekeeper (用户下载后会不会被拦)');
  const spctl = sh('spctl', ['-a', '-vvv', '-t', 'install', app]);
  const accepted = /accepted/.test(spctl);
  const notarized = /Notarized Developer ID/.test(spctl);
  check('spctl 放行', accepted, spctl.split('\n').filter(Boolean).slice(0, 2).join(' · '));
  check('已公证 (Notarized Developer ID)', notarized,
    notarized ? '' : '没公证的包用户下载后会被 Gatekeeper 拦');

  console.log('\n3) 桥在包里');
  const bridgeApp = join(app, 'Contents/Resources/os-bridge/Neox Computer Use.app');
  check('Neox Computer Use.app 打进包了', existsSync(bridgeApp));
  const bridgeBin = join(bridgeApp, 'Contents/MacOS/neox-os-bridge');
  check('可执行文件在', existsSync(bridgeBin));

  console.log('\n4) 桥的签名 (决定用户升级后要不要重新授权)');
  const sig = sh('codesign', ['-dv', '--verbose=4', bridgeApp]);
  const team = (sig.match(/TeamIdentifier=(\S+)/) ?? [])[1];
  const adhoc = /Signature=adhoc/.test(sig);
  check('不是 ad-hoc 签名', !adhoc,
    adhoc ? 'ad-hoc 的身份是 cdhash, 每次构建都变 → 用户每升级一次就要重新授权' : `TeamIdentifier=${team}`);
  const appSig = sh('codesign', ['-dv', '--verbose=4', app]);
  const appTeam = (appSig.match(/TeamIdentifier=(\S+)/) ?? [])[1];
  check('跟主 app 同一个 Team', !!team && team === appTeam, `bridge=${team} app=${appTeam}`);

  console.log('\n5) 桥能跑');
  const probe = sh(bridgeBin, ['--probe']);
  let parsed = null;
  try { parsed = JSON.parse(probe.trim().split('\n').pop()); } catch { /* ignore */ }
  check('--probe 有回应', !!parsed, probe.trim().slice(0, 120));

  console.log('\n6) 辅助功能列表里显示什么名字');
  const bundleName = sh('defaults', ['read', join(bridgeApp, 'Contents/Info.plist'), 'CFBundleName']).trim();
  check('bundle 目录名 = Neox Computer Use', bridgeApp.endsWith('Neox Computer Use.app'),
    '列表用的是目录名不是 CFBundleDisplayName');
  check('CFBundleName 也对得上', bundleName === 'Neox Computer Use', bundleName);
  check('带图标 (没图标用户不敢勾)', existsSync(join(bridgeApp, 'Contents/Resources/icon.icns')));
} finally {
  sh('hdiutil', ['detach', mountPoint, '-quiet']);
  console.log('\n(已卸载 DMG)');
}

console.log(`\n${failures === 0 ? '✓ 生产包验收通过' : `✗ ${failures} 项不符`}`);
process.exit(failures === 0 ? 0 : 1);
