import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

/* 本文件在 apps/desktop/resources/os-bridge/ → 往上四级才是仓库根 */
const REPO = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/[\\/]$/, '');
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

/** 在一个假的 HOME 里跑工具装配, 回报三个 computer_* 工具在不在。 */
function toolsVisibleWith(registryJson) {
  const home = mkdtempSync(join(tmpdir(), 'neox-gate-'));
  mkdirSync(join(home, '.neox', 'plugins'), { recursive: true });
  if (registryJson !== null) {
    writeFileSync(join(home, '.neox', 'plugins', 'registry.json'), registryJson);
  }
  const probe = `
    import { isComputerUseEnabled } from '${REPO}/packages/core/src/runtime/computer/computerCapability.js';
    import { COMPUTER_TOOL_NAMES } from '${REPO}/packages/core/src/runtime/computer/computerToolDefs.js';
    console.log(JSON.stringify({ enabled: isComputerUseEnabled(), names: COMPUTER_TOOL_NAMES }));
  `;
  const file = join(home, 'probe.mts');
  writeFileSync(file, probe);
  try {
    const out = execFileSync('npx', ['tsx', file], {
      cwd: REPO, encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 90_000,
    });
    return JSON.parse(out.trim().split('\n').pop());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

console.log('1) 没装任何插件');
const none = toolsVisibleWith(JSON.stringify({ version: 1, plugins: {} }));
check('闸是关的', none.enabled === false);

console.log('\n2) 完全没有注册表文件 (全新用户)');
const fresh = toolsVisibleWith(null);
check('闸是关的', fresh.enabled === false);

console.log('\n3) 装了别的插件, 没声明这个能力');
const other = toolsVisibleWith(JSON.stringify({
  version: 1,
  plugins: { notion: { enabled: true, manifest: { name: 'notion', capabilities: ['connector'] } } },
}));
check('闸是关的', other.enabled === false);

console.log('\n4) 装了 computer-use 但被禁用了');
const disabled = toolsVisibleWith(JSON.stringify({
  version: 1,
  plugins: { 'computer-use': { enabled: false, manifest: { name: 'computer-use', capabilities: ['computer-use'] } } },
}));
check('闸是关的', disabled.enabled === false);

console.log('\n5) 装了并启用');
const on = toolsVisibleWith(JSON.stringify({
  version: 1,
  plugins: { 'computer-use': { enabled: true, manifest: { name: 'computer-use', capabilities: ['computer-use'] } } },
}));
check('闸是开的', on.enabled === (process.platform === 'darwin'),
  process.platform === 'darwin' ? '' : '(非 macOS 一律关, 这是对的)');

console.log(`\n${failures === 0 ? '✓ 能力闸五种情形全部符合预期' : `✗ ${failures} 项不符`}`);
process.exit(failures === 0 ? 0 : 1);
