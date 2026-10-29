import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { auditSource } from '../audit-comments.mjs';

const auditScript = join(process.cwd(), 'scripts/audit-comments.mjs');
const verifyScript = join(process.cwd(), 'scripts/verify-comment-only.mjs');

test('audit only matches comments, not strings or templates', () => {
  const source = [
    "const prompt = '用户说 2026-01-01 🧪';",
    'const template = `拍板 Codex 2026-01-02`;',
    '// 用户反馈 2026-01-03',
    '/* 对齐惯例 Codex */',
  ].join('\n');
  const hits = auditSource(source, 'packages/demo/src/example.ts', process.cwd());
  assert.deepEqual(hits.map(({ category }) => category), ['date', 'user-quote', 'history', 'provenance']);
  assert.equal(hits.filter((hit) => hit.line === 1).length, 0);
});

test('audit detects development-history comments without matching source strings', () => {
  const source = [
    "const prompt = '用户反馈：真机实测 T-42';",
    '// 真机实测发现 worker 名额不足时需要拒绝入队',
    '/* 根因是旧版协议把状态写进 payload */',
    '// 使用原来的值作为本轮比较基线',
  ].join('\n');
  const hits = auditSource(source, 'packages/demo/src/example.ts', process.cwd());
  assert.deepEqual(hits.map(({ category, line }) => `${category}:${line}`), ['history:2', 'history:3']);
});

test('audit recognizes all five categories', () => {
  const source = [
    '// 2026-09-19',
    '// 用户：反馈',
    '// 对标 Claude Code 的实现',
    '// 改进#42，修：边界',
    '// shipped ✅',
  ].join('\n');
  const categories = new Set(auditSource(source, 'apps/demo/src/example.ts').map(({ category }) => category));
  assert.deepEqual([...categories].sort(), ['date', 'emoji', 'history', 'process', 'provenance', 'user-quote']);
});

async function gitFixture(source) {
  const cwd = await mkdtemp(join(tmpdir(), 'openneox-comment-tools-'));
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
  await writeFile(join(cwd, 'fixture.tsx'), source);
  execFileSync('git', ['add', 'fixture.tsx'], { cwd });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd });
  return cwd;
}

test('verify passes for comment-only changes and rejects logic changes', async (t) => {
  const cwd = await gitFixture('const value = "stable";\nexport const App = () => <div>{value}</div>;\n');
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'fixture.tsx'), '// added comment\nconst value = "stable";\nexport const App = () => <div>{value}</div>;\n');
  execFileSync('node', [verifyScript, 'HEAD'], { cwd, stdio: 'pipe' });

  await writeFile(join(cwd, 'fixture.tsx'), '// changed comment\nconst value = "changed";\nexport const App = () => <div>{value}</div>;\n');
  assert.throws(() => execFileSync('node', [verifyScript, 'HEAD'], { cwd, stdio: 'pipe' }));
});

test('audit walks token-level comments, not just node-level ones', () => {
  /* JSX 里的 {/* … *\/} 是闭合花括号的前导 trivia: 只走 forEachChild 会整段扫不到,
   * 这正是它一度漏报几百条注释的原因。 */
  const source = [
    'export const App = () => (',
    '  <div>',
    '    {/* 2026-01-04 用户反馈: 这里要换行 */}',
    '    <span />',
    '  </div>',
    ');',
  ].join('\n');
  const categories = auditSource(source, 'apps/demo/src/example.tsx').map(({ category }) => category);
  assert.ok(categories.includes('date'), 'JSX 注释里的日期必须被扫到');
  assert.ok(categories.includes('user-quote'), 'JSX 注释里的用户转述必须被扫到');
});

test('audit covers css and html comments', () => {
  const css = ['/* 2026-01-05 用户: 这里太挤 */', '.a { margin: 8px; }'].join('\n');
  assert.ok(auditSource(css, 'apps/demo/src/a.css').length > 0, 'css 注释必须被扫到');

  const html = ['<!-- 2026-01-06 踩过: 这一行不能删 -->', '<div></div>'].join('\n');
  assert.ok(auditSource(html, 'apps/demo/src/a.html').length > 0, 'html 注释必须被扫到');
});

test('verify rejects css changes that are not comment-only', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'openneox-comment-tools-css-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
  await writeFile(join(cwd, 'fixture.css'), '/* 说明 */\n.a { margin: 8px; }\n');
  execFileSync('git', ['add', 'fixture.css'], { cwd });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd });

  await writeFile(join(cwd, 'fixture.css'), '/* 换个说法 */\n.a { margin: 8px; }\n');
  execFileSync('node', [verifyScript, 'HEAD'], { cwd, stdio: 'pipe' });

  await writeFile(join(cwd, 'fixture.css'), '/* 换个说法 */\n.a { margin: 12px; }\n');
  assert.throws(() => execFileSync('node', [verifyScript, 'HEAD'], { cwd, stdio: 'pipe' }));
});
