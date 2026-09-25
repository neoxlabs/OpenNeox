#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sameCode, codeFingerprint } from './sync-open/codeEquivalence.mjs';
import { stripProvenance } from './sync-open/stripProvenanceComments.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OPEN = process.env.NEOX_OPEN_REPO || join(homedir(), 'AI/MK/OpenNeox');
const WORK = process.env.NEOX_OPEN_SYNC_WORK || join(homedir(), '.cache/neox-open-sync');
const RAW_REF = 'refs/sync/raw';
const BACKUP_REF = 'refs/open-sync/raw';
const IDENTITY = { name: 'lmk1010', email: '17558303+lmk1010@users.noreply.github.com' };

const args = new Set(process.argv.slice(2));
const noPush = args.has('--no-push');
const skipBuild = args.has('--skip-build');

const log = (m) => console.log(`[sync-open] ${m}`);
const die = (m) => { console.error(`\n[sync-open] ✗ ${m}\n`); process.exit(1); };
const git = (cwd, gitArgs, opts = {}) => execFileSync('git', gitArgs, { cwd, encoding: 'utf8', maxBuffer: 1 << 30, ...opts }).trim();
const run = (cmd, cmdArgs, cwd, env = {}) => {
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) die(`${cmd} ${cmdArgs.join(' ')} 失败 (exit ${r.status}) — 在 ${cwd}`);
};

/* ── 0. 前置: 两边工作区都干净, 开源仓在 main ─────────────────────────────── */
if (git(ROOT, ['status', '--porcelain'])) die('本仓工作区有未提交改动 —— 导出必须对应一个确定的提交');
if (!existsSync(join(OPEN, '.git'))) die(`找不到开源仓: ${OPEN} (用 NEOX_OPEN_REPO 指定)`);
if (git(OPEN, ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') die('开源仓不在 main 分支');
/* 只看已跟踪文件: 未跟踪的本地构建产物 (win-os-bridge 的 exe 等) 不会进提交, 提交树直接由 raw 算出 */
if (git(OPEN, ['status', '--porcelain', '--untracked-files=no'])) die('开源仓工作区有未提交改动 —— 先处理掉 (同步只从本仓来)');
const comSha = git(ROOT, ['rev-parse', 'HEAD']);
log(`本仓 ${comSha.slice(0, 9)} → ${OPEN}`);

/* ── 1. 导出 + 删开发经过注释 ─────────────────────────────────────────────── */
const EXPORT = join(WORK, 'export');
mkdirSync(WORK, { recursive: true });
run(process.execPath, [join(ROOT, 'scripts/export-public-tree.mjs'), EXPORT, '--force'], ROOT);

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  if (e.name === '.git' || e.name === 'node_modules') return [];
  const p = join(dir, e.name);
  return e.isDirectory() ? walk(p) : [p];
});
let stripped = 0;
for (const abs of walk(EXPORT)) {
  const rel = relative(EXPORT, abs);
  if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|css|html)$/.test(rel)) continue;
  const text = readFileSync(abs, 'utf8');
  const r = stripProvenance(text, rel);
  if (r.removed) { writeFileSync(abs, r.text); stripped += r.removed; }
}
log(`删掉 ${stripped} 条开发经过注释`);

/* ── 2. 泄漏闸: 有 block 级命中就停 ─────────────────────────────────────────── */
run(process.execPath, [join(ROOT, 'scripts/check-public-leak.mjs'), EXPORT, '--label=public'], ROOT);

/* ── 3. 公开树自己能构建、能过公开仓 CI 的同一套检查 ─────────────────────────
 *   构建目录单独放, node_modules 在两次同步之间复用 (装一次依赖要几分钟)。 */
if (!skipBuild) {
  const BUILD = join(WORK, 'build');
  mkdirSync(BUILD, { recursive: true });
  run('rsync', ['-a', '--delete', '--exclude', 'node_modules', '--exclude', 'packages/*/node_modules',
    '--exclude', 'apps/*/node_modules', '--exclude', 'packages/editor-engine/out', '--exclude', 'apps/mobile/.dart_tool',
    '--exclude', 'apps/mobile/build', `${EXPORT}/`, `${BUILD}/`], ROOT);
  const npm = (script) => run('npm', ['run', script], BUILD);
  run('npm', ['install', '--no-audit', '--no-fund'], BUILD);
  const publicScripts = JSON.parse(readFileSync(join(BUILD, 'package.json'), 'utf8')).scripts ?? {};
  for (const s of ['type-check', 'check:boundaries', 'check:specifiers', 'check:licenses', 'audit:comments', 'build', 'ui:type-check', 'ui:build-electron']) {
    if (s.startsWith('ui:') && !(s in publicScripts)) continue;
    npm(s);
  }
  run('node', ['--test', 'scripts/__tests__/comment-tools.test.mjs'], BUILD);
  /* 全量并发跑时, 几条性能预算测试 (切词 / shell 冒烟) 偶发超时, 单独跑稳定通过 —— 失败的重试两次 */
  run('npx', ['vitest', 'run', '--reporter=dot', '--retry=2'], BUILD);
  if (spawnSync('flutter', ['--version'], { stdio: 'ignore' }).status === 0 && existsSync(join(BUILD, 'apps/mobile/pubspec.yaml'))) {
    const mobile = join(BUILD, 'apps/mobile');
    run('flutter', ['pub', 'get'], mobile);
    /* agentsdk 是嵌在里面的独立 Dart 包, 它的依赖 (package:test) 要单独装, 否则 analyze 报 uri_does_not_exist */
    if (existsSync(join(mobile, 'agentsdk/pubspec.yaml'))) run('flutter', ['pub', 'get'], join(mobile, 'agentsdk'));
    run('flutter', ['analyze', '--no-fatal-infos', '--no-fatal-warnings'], mobile);
  } else {
    log('跳过移动端检查 (本机没有 flutter 或公开树里没有 apps/mobile)');
  }
  log('公开树构建与检查全部通过');
}

/* ── 4. 把导出物记成一个 raw 提交 (只在开源仓本地, 不进公开历史) ──────────── */
const indexFile = join(WORK, 'raw.index');
rmSync(indexFile, { force: true });
const rawEnv = { ...process.env, GIT_INDEX_FILE: indexFile, GIT_WORK_TREE: EXPORT };
execFileSync('git', ['add', '-A', '--force', '.'], { cwd: EXPORT, env: { ...rawEnv, GIT_DIR: join(OPEN, '.git') }, stdio: 'pipe' });
const rawTree = execFileSync('git', ['write-tree'], { cwd: EXPORT, env: { ...rawEnv, GIT_DIR: join(OPEN, '.git') }, encoding: 'utf8' }).trim();
let prevRaw = '';
try { prevRaw = git(OPEN, ['rev-parse', '--verify', '--quiet', RAW_REF]); } catch { prevRaw = ''; }
const commitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email,
  GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email,
};
const rawCommit = execFileSync('git', ['commit-tree', rawTree, ...(prevRaw ? ['-p', prevRaw] : []), '-m', `raw export of ${comSha}`],
  { cwd: OPEN, env: commitEnv, encoding: 'utf8' }).trim();

const head = git(OPEN, ['rev-parse', 'HEAD']);
let mergedTree;
if (prevRaw) {
  /* -X theirs: 同一处两边都改了 → 用本仓的。退出码 1 只表示有冲突被记录, 树照样写出来。 */
  const r = spawnSync('git', ['merge-tree', '--write-tree', `--merge-base=${prevRaw}`, '-X', 'theirs', head, rawCommit],
    { cwd: OPEN, encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.status !== 0 && r.status !== 1) die(`git merge-tree 失败: ${r.stderr}`);
  mergedTree = r.stdout.split('\n')[0].trim();
} else {
  log('第一次同步: 以开源仓当前版本为起点');
  mergedTree = git(OPEN, ['rev-parse', `${head}^{tree}`]);
}

/* ── 6. 复核: 文件集合与代码以 raw 为准 (见文件头) ─────────────────────────── */
const lsTree = (tree) => new Map(git(OPEN, ['ls-tree', '-r', '-z', '--full-tree', tree]).split('\0').filter(Boolean).map((l) => {
  const [meta, path] = l.split('\t');
  const [mode, , oid] = meta.split(' ');
  return [path, { mode, oid }];
}));
const raw = lsTree(rawTree);
const merged = lsTree(mergedTree);
const blob = (oid) => execFileSync('git', ['cat-file', 'blob', oid], { cwd: OPEN, maxBuffer: 1 << 30 });
const DOC = /\.(md|mdx|txt)$|(^|\/)(LICENSE|NOTICE|COPYING)[^/]*$/i;

const finalIndex = join(WORK, 'final.index');
rmSync(finalIndex, { force: true });
const fEnv = { ...process.env, GIT_INDEX_FILE: finalIndex };
execFileSync('git', ['read-tree', rawTree], { cwd: OPEN, env: fEnv });
let keptComments = 0, keptDocs = 0, forcedToRaw = 0;
const updates = [];
for (const [path, r] of raw) {
  const m = merged.get(path);
  if (!m || m.oid === r.oid || m.mode !== r.mode) continue;
  const mb = blob(m.oid);
  if (mb.includes('<<<<<<< ')) { forcedToRaw++; continue; }
  if (DOC.test(path)) { updates.push(`${m.mode},${m.oid},${path}`); keptDocs++; continue; }
  if (codeFingerprint('', path) !== null && sameCode(mb, blob(r.oid), path)) {
    updates.push(`${m.mode},${m.oid},${path}`); keptComments++; continue;
  }
  forcedToRaw++;
}
for (const u of updates) {
  const [mode, oid, ...p] = u.split(',');
  execFileSync('git', ['update-index', '--cacheinfo', `${mode},${oid},${p.join(',')}`], { cwd: OPEN, env: fEnv });
}
const finalTree = execFileSync('git', ['write-tree'], { cwd: OPEN, env: fEnv, encoding: 'utf8' }).trim();
log(`保留开源仓改写: 注释 ${keptComments} 个文件, 文档 ${keptDocs} 个; 以本仓为准 ${forcedToRaw} 个`);

if (finalTree === git(OPEN, ['rev-parse', `${head}^{tree}`])) {
  log('开源仓已经是最新, 无需提交');
  execFileSync('git', ['update-ref', RAW_REF, rawCommit], { cwd: OPEN });
  process.exit(0);
}

/* ── 7. 提交 (快进 main), 记下 raw, 推送 ────────────────────────────────────── */
const changed = git(OPEN, ['diff', '--shortstat', head, finalTree]);
const msg = `sync: update from upstream ${comSha.slice(0, 9)}\n\n${changed}\n`;
const commit = execFileSync('git', ['commit-tree', finalTree, '-p', head, '-m', msg], { cwd: OPEN, env: commitEnv, encoding: 'utf8' }).trim();
git(OPEN, ['merge', '--ff-only', commit]);
git(OPEN, ['update-ref', RAW_REF, rawCommit]);
log(`开源仓 main → ${commit.slice(0, 9)} (${changed})`);

if (noPush) {
  log('--no-push: 已提交, 未推送。确认后执行: git -C ' + OPEN + ' push origin main');
} else {
  run('git', ['push', 'origin', 'main'], OPEN);
  log('已推送到开源仓');
  const privateRemote = git(ROOT, ['remote', 'get-url', 'origin']);
  const backup = spawnSync('git', ['push', '--force', privateRemote, `${RAW_REF}:${BACKUP_REF}`], { cwd: OPEN, stdio: 'pipe', encoding: 'utf8' });
  log(backup.status === 0 ? 'raw 已备份到私有远端' : `⚠ raw 备份失败 (不影响本次同步): ${backup.stderr.trim().split('\n').pop()}`);
}
