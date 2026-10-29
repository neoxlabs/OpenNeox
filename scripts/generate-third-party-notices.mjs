import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function collect() {
  /* npm ls 在存在 peer 冲突时 exit 非 0 但仍输出完整 JSON — 忽略 exit code */
  let raw;
  try {
    raw = execSync('npm ls --omit=dev --all --json --package-lock-only', {
      cwd: root, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
  } catch (e) {
    raw = e.stdout?.toString() ?? '';
  }
  if (!raw.trim()) throw new Error('npm ls 无输出 — 请先 npm install');
  return JSON.parse(raw);
}

const seen = new Map(); // name@version → { license, repo }

function licenseOf(pkgDir) {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const lic = typeof pj.license === 'string'
      ? pj.license
      : pj.license?.type ?? (Array.isArray(pj.licenses) ? pj.licenses.map((l) => l.type).join(' OR ') : 'UNKNOWN');
    const repo = typeof pj.repository === 'string' ? pj.repository : pj.repository?.url ?? '';
    return { lic, repo };
  } catch {
    return { lic: 'UNKNOWN', repo: '' };
  }
}

function walk(node, name) {
  if (!node || typeof node !== 'object') return;
  const version = node.version;
  if (name && version && !name.startsWith('@neoxlabs/')) {
    const key = `${name}@${version}`;
    if (!seen.has(key)) {
      /* resolved path: node.path 仅 --all 时存在; 兜底按 node_modules 常规位置猜 */
      const dir = node.path ?? path.join(root, 'node_modules', name);
      const { lic, repo } = licenseOf(dir);
      seen.set(key, { name, version, lic: node.license ?? lic, repo });
    }
  }
  for (const [depName, child] of Object.entries(node.dependencies ?? {})) {
    walk(child, depName);
  }
}

const tree = collect();
walk(tree, null);

const entries = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

/* 许可健康检查 */
const copyleft = entries.filter((e) => /\b(GPL|AGPL)\b/i.test(e.lic) && !/\bL?GPL\b.*\bOR\b|\bOR\b.*\bGPL\b/i.test(e.lic) && !/^L GPL|^LGPL/i.test(e.lic));
const dual = entries.filter((e) => /\bOR\b/i.test(e.lic));

const lines = [];
lines.push('# Third-Party Notices');
lines.push('');
lines.push(`> 自动生成 (scripts/generate-third-party-notices.mjs) · ${new Date().toISOString().slice(0, 10)}`);
lines.push(`> 覆盖生产依赖解析树 ${entries.length} 个包 (不含 devDependencies 与 @neoxlabs/* 自有包)。`);
lines.push('');
lines.push('## 双许可选择声明');
lines.push('');
lines.push('对以下提供多许可选项的依赖, Neox 选择其中**非 copyleft** 的许可路径:');
lines.push('');
for (const e of dual) {
  const pick = e.lic.split(/\s+OR\s+/i).find((l) => !/GPL/i.test(l)) ?? e.lic;
  lines.push(`- \`${e.name}@${e.version}\` (${e.lic}) → 选择 **${pick.replace(/[()]/g, '').trim()}**`);
}
if (dual.length === 0) lines.push('- (无)');
lines.push('');
lines.push('## 依赖清单');
lines.push('');
lines.push('| Package | Version | License | Repository |');
lines.push('|---|---|---|---|');
for (const e of entries) {
  const repo = e.repo.replace(/^git\+/, '').replace(/\.git$/, '');
  lines.push(`| ${e.name} | ${e.version} | ${e.lic} | ${repo} |`);
}
lines.push('');

fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), lines.join('\n'));
console.log(`✅ THIRD_PARTY_NOTICES.md 已生成: ${entries.length} 个包, 双许可 ${dual.length} 个`);

if (copyleft.length > 0) {
  console.error(`\n⚠️  发现 ${copyleft.length} 个纯 copyleft (GPL/AGPL) 生产依赖 — 闭源分发前必须处置:`);
  for (const e of copyleft) console.error(`   · ${e.name}@${e.version} (${e.lic})`);
  process.exitCode = 2;
}
