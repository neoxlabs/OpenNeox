#!/usr/bin/env node
/**
 * 把 release/ 里的桌面安装包发到本仓库的 GitHub Releases, 并且**只保留最新那一版**。
 *
 * 为什么是 GitHub Releases: 公开仓库用它分发不花钱, 而且 `/releases/latest/download/<名字>`
 * 这个别名永远指向最新一次发布 —— 客户端里因此可以写死一个常量地址 (见
 * apps/desktop/src/ui/electron/updateSource.ts), 发版只上传资源, 不改代码不改配置。
 *
 * 为什么只留一版: 每个平台一套包接近 1GB, 而旧版本没人会去装 —— 想回退的人会去翻
 * tag 自己构建。留着只会让仓库体积一路涨, 对"免费额度够不够"这件事是唯一的变量。
 * 所以本脚本发完新版就删掉更早的 release 和它们的 tag。
 *
 * 用法:
 *   npm run desktop:publish -- --dry-run     # 只打印会做什么
 *   npm run desktop:publish                  # 真发
 *   npm run desktop:publish -- --keep 3      # 多留几版
 *
 * 前置: 装了 gh 并且 `gh auth status` 是通的。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_DIR = join(ROOT, 'release');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const KEEP = Math.max(1, Number(args[args.indexOf('--keep') + 1]) || 1);

const gh = (...a) => execFileSync('gh', a, { cwd: ROOT, encoding: 'utf8' });
const say = (...m) => console.log(...m);

function repoSlug() {
  /* 从 git remote 取, 而不是写死 —— fork 出去的人跑这个脚本应该发到自己的仓库。 */
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const m = /github\.com[/:]([^/]+\/[^/.]+)/.exec(url);
  if (!m) throw new Error(`origin 不是 GitHub 仓库: ${url}`);
  return m[1];
}

/**
 * 认领 release/ 里该上传的产物。
 *
 * 只收装得上的形态和 electron-builder 的更新 feed, 其余 (blockmap、未签名中间产物、
 * builder-debug.yml 之类) 一概不传 —— 传上去既占空间又让 assets 列表读不懂。
 */
function collectAssets() {
  if (!existsSync(RELEASE_DIR)) throw new Error(`没有 release/ 目录, 先跑 npm run dist:mac (或 dist:win)`);
  const wanted = (n) =>
    /\.(dmg|zip|exe|AppImage|deb|rpm)$/i.test(n) || /^latest(-mac|-linux)?\.yml$/i.test(n);
  return readdirSync(RELEASE_DIR)
    .filter(wanted)
    .filter((n) => statSync(join(RELEASE_DIR, n)).isFile())
    .sort();
}

/** 产物名 → latest.json 里的键。认不出来的返回 null, 由调用方忽略。 */
export function manifestKeyFor(name) {
  if (/\.dmg$/i.test(name)) return /arm64/i.test(name) ? 'macArm' : 'macIntel';
  if (/portable/i.test(name) && /\.exe$/i.test(name)) return 'winPortable';
  if (/\.exe$/i.test(name)) return /arm64/i.test(name) ? 'winArm64' : 'winX64';
  return null;
}

export function buildManifest(version, assets, downloadBase, notes) {
  /* 客户端按平台各读各的版本号 (见 pickPlatformLatestVersion): mac 和 win 允许错开发布。
   * 这个脚本一次发一个版本, 所以两者都填同一个值, 但字段留着, 错开发布时才不用改格式。 */
  const manifest = {
    version,
    macVersion: version,
    winVersion: version,
    updatedAt: new Date().toISOString(),
    releaseNotes: notes || '',
  };
  for (const name of assets) {
    const key = manifestKeyFor(name);
    if (key && !manifest[key]) manifest[key] = `${downloadBase}/${encodeURIComponent(name)}`;
  }
  return manifest;
}

function main() {
  const slug = repoSlug();
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const tag = `v${version}`;
  const assets = collectAssets();
  if (!assets.length) throw new Error('release/ 里没有可发布的产物');

  /* 资源地址一律走 /releases/latest/download/ 而不是 /download/<tag>/ —— 只保留一版时
   * 两者指向同一个文件, 但前者在下一次发版后自动跟过去, 旧 manifest 万一被缓存住也不会
   * 把用户钉死在一个已经删掉的 tag 上。 */
  const downloadBase = `https://github.com/${slug}/releases/latest/download`;
  const notes = `OpenNeox ${version}`;

  const manifest = buildManifest(version, assets, downloadBase, notes);
  const manifestPath = join(RELEASE_DIR, 'latest.json');
  say(`仓库   ${slug}`);
  say(`版本   ${tag}`);
  say(`产物   ${assets.length} 个:`);
  for (const a of assets) {
    const mb = (statSync(join(RELEASE_DIR, a)).size / 1048576).toFixed(0);
    say(`       ${a.padEnd(46)} ${mb.padStart(6)} MB`);
  }
  say(`latest.json:\n${JSON.stringify(manifest, null, 2)}`);

  if (DRY) {
    const olds = listOldReleases(slug, tag);
    say(`\n[dry-run] 会删掉 ${olds.length} 个旧 release: ${olds.join(', ') || '(无)'}`);
    say('[dry-run] 没有实际改动');
    return;
  }

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const exists = (() => {
    try { gh('release', 'view', tag, '--repo', slug); return true; } catch { return false; }
  })();
  if (exists) {
    say(`\n${tag} 已存在, 覆盖上传资源`);
    gh('release', 'upload', tag, ...assets.map((a) => join(RELEASE_DIR, a)), manifestPath,
       '--repo', slug, '--clobber');
  } else {
    say(`\n创建 ${tag}`);
    gh('release', 'create', tag, ...assets.map((a) => join(RELEASE_DIR, a)), manifestPath,
       '--repo', slug, '--title', `OpenNeox ${version}`, '--notes', notes, '--latest');
  }

  /* 删旧版放在**新版发布成功之后** —— 中途失败时用户仍然有一个能装的 release,
   * 而不是新的没传上去、旧的已经没了。 */
  const olds = listOldReleases(slug, tag).slice(KEEP - 1);
  for (const old of olds) {
    say(`删除旧 release ${old}`);
    gh('release', 'delete', old, '--repo', slug, '--yes', '--cleanup-tag');
  }
  say(`\n完成。更新源: ${downloadBase}/latest.json`);
}

/** 除 keepTag 外的全部 release tag, 新的在前。 */
function listOldReleases(slug, keepTag) {
  try {
    const out = gh('release', 'list', '--repo', slug, '--limit', '100', '--json', 'tagName,createdAt');
    return JSON.parse(out)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => r.tagName)
      .filter((t) => t !== keepTag);
  } catch {
    return [];
  }
}

/* 被 import 时只暴露纯函数, 不发任何东西 —— 测试要能直接验 manifest 的拼装规则。 */
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
