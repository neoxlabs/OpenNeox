
import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const LEGACY = "neox-open-settings";
const CANON = "neox:open-settings";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '__tests__') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 去掉注释 —— 本文件和 AppShell 的说明里都引着那个旧名字 */
const strip = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const FILES = walk(ROOT).map((f) => ({ f, src: strip(fs.readFileSync(f, 'utf8')) }));

describe('设置页跳转事件', () => {
  test('没有任何地方再 dispatch 旧的连字符事件名', () => {
    const bad = FILES
      .filter(({ src }) => new RegExp(`dispatchEvent\\([^)]*['"\`]${LEGACY}`).test(src))
      .map(({ f }) => path.relative(ROOT, f));
    expect(bad, `这些文件还在派旧事件名 (detail.tab 会被丢掉): ${bad.join(', ')}`).toEqual([]);
  });

  test('正名仍然有人派 —— 别把链路整个删没了', () => {
    const good = FILES.filter(({ src }) => src.includes(`'${CANON}'`));
    expect(good.length).toBeGreaterThan(3);
  });

  test('SettingsPage 监听正名并且认 detail.tab', () => {
    const src = fs.readFileSync(path.join(ROOT, 'pages/settings/SettingsPage.tsx'), 'utf8');
    expect(src).toMatch(new RegExp(`addEventListener\\('${CANON}'`));
    expect(src).toMatch(/detail\?\.tab/);
  });

  test('AppShell 保留的旧名监听必须把 tab 转交, 不许再丢', () => {
    const src = strip(fs.readFileSync(path.join(ROOT, 'app/AppShell.tsx'), 'utf8'));
    const i = src.indexOf(`addEventListener('${LEGACY}'`);
    expect(i, 'AppShell 不再监听旧名 —— 若是刻意删除, 请一并删掉这条断言').toBeGreaterThan(-1);
    /* 监听所在的那个 effect 里必须出现"转交"动作 */
    const block = src.slice(Math.max(0, i - 900), i);
    expect(block, '旧名监听没有把 detail.tab 转交给正名').toMatch(new RegExp(`CustomEvent\\('${CANON}'`));
  });
});
