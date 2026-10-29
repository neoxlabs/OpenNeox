import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/[\\/]$/, '');
const API = 'https://neox-dev.com/api/v1';
const PLUGINS_DIR = join(homedir(), '.neox', 'plugins');
const REGISTRY = join(PLUGINS_DIR, 'registry.json');
const NAME = 'computer-use';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

/** 直接问闸: 现在这台机器上, computer use 开着吗。 */
function gateOpen() {
  const probe = join(PLUGINS_DIR, '.gate-probe.mts');
  writeFileSync(probe, `
    import { isComputerUseEnabled } from '${REPO}/packages/core/src/runtime/computer/computerCapability.js';
    console.log(isComputerUseEnabled() ? 'OPEN' : 'CLOSED');
  `);
  try {
    const out = execFileSync('npx', ['tsx', probe], { cwd: REPO, encoding: 'utf8', timeout: 90_000 });
    return out.trim().split('\n').pop() === 'OPEN';
  } finally {
    rmSync(probe, { force: true });
  }
}

/* ── 备份现状, 跑完恢复 ───────────────────────────────────────────────────── */
const backup = existsSync(REGISTRY) ? readFileSync(REGISTRY, 'utf-8') : null;
const installedDirs = [];

try {
  console.log('0) 从干净状态开始 (卸掉已装的那份)');
  if (backup) {
    const data = JSON.parse(backup);
    if (data.plugins?.[NAME]) {
      const p = data.plugins[NAME].installPath;
      if (p && existsSync(p)) rmSync(p, { recursive: true, force: true });
      delete data.plugins[NAME];
      writeFileSync(REGISTRY, JSON.stringify(data, null, 2));
    }
  }
  check('闸是关的 (没装)', gateOpen() === false);

  console.log('\n1) 市场接口能查到');
  const listRes = await fetch(`${API}/plugins?search=computer`);
  const listJson = await listRes.json();
  const items = listJson.plugins ?? listJson.items ?? [];
  const entry = (Array.isArray(items) ? items : []).find((p) => p.name === NAME);
  check('市场里有这个插件', !!entry, entry ? `${entry.name}@${entry.version}` : '没找到');
  check('manifest 带着 capabilities', Array.isArray(entry?.manifest?.capabilities)
    && entry.manifest.capabilities.includes('computer-use'),
    JSON.stringify(entry?.manifest?.capabilities));
  check('声明了只支持 macOS', entry?.manifest?.platform?.includes?.('darwin') === true);

  console.log('\n2) 制品能下载, 哈希对得上');
  /* 地址和哈希在 source 里 (type/url/sha256), 不是顶层字段 —— 第一版猜的是
   * packageUrl, 拿到 undefined 后 fetch 直接抛 "Invalid URL", 报错离真因很远。 */
  const url = entry.source?.url;
  const declaredSha = entry.source?.sha256;
  check('市场登记了下载地址', !!url, url);
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const actualSha = createHash('sha256').update(buf).digest('hex');
  check('下载得到的字节跟市场登记的哈希一致', actualSha === declaredSha,
    actualSha === declaredSha ? `${actualSha.slice(0, 12)}…` : `登记 ${String(declaredSha).slice(0, 12)}… 实际 ${actualSha.slice(0, 12)}…`);

  console.log('\n3) 安装 (解包 → 落盘 → 写注册表)');
  const pkgPath = join(PLUGINS_DIR, `${NAME}.download.neox-plugin`);
  writeFileSync(pkgPath, buf);
  const installScript = join(PLUGINS_DIR, '.install-probe.mts');
  /* 走 installFromFile —— **客户端点「安装」真正走的就是它** (解包 → 校验签名 →
   * 判信任级别 → 落盘 → 写注册表)。第一版我猜了个 unpackPlugin, 导出名根本不存在,
   * 于是走了"文件复制"的兜底路径 —— 那等于把最该验的一环跳过去了。 */
  writeFileSync(installScript, `
    import { installFromFile } from '${REPO}/apps/desktop/src/plugins/pluginPackager.js';
    const r = await installFromFile('${pkgPath}', { enable: true });
    console.log(JSON.stringify({
      success: r.success, errors: r.errors, warnings: r.warnings,
      name: r.plugin?.name, version: r.plugin?.version,
      installPath: r.plugin?.installPath, trust: r.trustLevel ?? r.plugin?.trustLevel,
    }));
  `);
  let installed = null;
  try {
    const out = execFileSync('npx', ['tsx', installScript], { cwd: REPO, encoding: 'utf8', timeout: 120_000 });
    installed = JSON.parse(out.trim().split('\n').pop());
  } catch (e) {
    console.log(`     安装器抛错: ${String(e.stdout ?? e.message).slice(0, 300)}`);
  } finally {
    rmSync(installScript, { force: true });
  }
  check('安装器把它装上了', installed?.success === true,
    installed ? `${installed.name}@${installed.version} trust=${installed.trust} ${(installed.errors ?? []).join(';')}` : '没有回执');
  if (installed?.installPath) installedDirs.push(installed.installPath);
  const regAfter = existsSync(REGISTRY) ? JSON.parse(readFileSync(REGISTRY, 'utf-8')) : { plugins: {} };
  check('注册表里出现了这个插件', !!regAfter.plugins?.[NAME],
    regAfter.plugins?.[NAME] ? `enabled=${regAfter.plugins[NAME].enabled}` : '');

  console.log('\n4) 装完之后能用');
  check('闸开了', gateOpen() === true);

  console.log('\n5) 卸载之后不能用');
  const reg2 = JSON.parse(readFileSync(REGISTRY, 'utf-8'));
  delete reg2.plugins[NAME];
  writeFileSync(REGISTRY, JSON.stringify(reg2, null, 2));
  check('闸关了', gateOpen() === false);

  rmSync(pkgPath, { force: true });
} finally {
  /* 恢复原状 —— 注册表**和目录**都要恢复。
   *
   * 第一版只写回了 registry.json, 结果注册表指向 computer-use@0.1.0 而那个目录
   * 已经在步骤 0 被删了 —— 启动时读 installPath/plugin.json 直接 ENOENT,
   * capabilities 一条都没打开, 表现是"插件装着但能力闸是关的"。
   * 恢复不完整比不恢复更坏: 它留下一个看起来正常的坏状态。 */
  if (backup) {
    writeFileSync(REGISTRY, backup);
    try {
      const entry = JSON.parse(backup).plugins?.[NAME];
      if (entry?.installPath && !existsSync(entry.installPath)) {
        mkdirSync(entry.installPath, { recursive: true });
        cpSync(join(REPO, 'plugins', NAME), entry.installPath, { recursive: true });
        console.log(`  (顺带把 ${entry.installPath} 也恢复了)`);
      }
    } catch { /* 备份坏了就算了, 上面的 registry 已经写回 */ }
  }
  console.log('\n(已恢复注册表和插件目录)');
}

console.log(`\n${failures === 0 ? '✓ 市场安装全链路通过' : `✗ ${failures} 项不符`}`);
process.exit(failures === 0 ? 0 : 1);
