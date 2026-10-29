/**
 * 弹性曲线是"活气"的唯一来源, 这份测试守住它别退化成普通缓出。
 *
 * --neox-ease-spring 的定义必须是一条**末段过冲**的 cubic-bezier: 控制点 y 超过 1,
 * 元素到位前会冲过终点再落回来。一旦它被写成 var(--neox-ease-out) 之类的别名,
 * 所有引用它的地方 (新消息落位、chevron 翻转、按钮回弹) 会一起变成匀速滑动 ——
 * 页面照样能用, 没有任何报错, 只是整体"死"掉, 正是最容易悄悄退化的那类改动。
 *
 * 同时约束: 每个平台层要么不覆写它, 要覆写就得自己也是一条过冲曲线。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function walkCss(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkCss(p, out);
    else if (name.endsWith('.css')) out.push(p);
  }
  return out;
}

const DECL = /--neox-ease-spring\s*:\s*([^;]+);/g;

/** 收集全仓库对该 token 的定义, 连同来源文件, 便于失败时直接定位。 */
function springDeclarations(): { file: string; value: string }[] {
  const found: { file: string; value: string }[] = [];
  for (const f of walkCss(RENDERER)) {
    const css = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(DECL)) {
      found.push({ file: relative(RENDERER, f), value: m[1].trim() });
    }
  }
  return found;
}

/** 过冲 = 两个控制点的 y 里至少有一个 > 1。 */
function overshoots(value: string): boolean {
  const m = /^cubic-bezier\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/.exec(value);
  if (!m) return false;
  return Number(m[2]) > 1 || Number(m[4]) > 1;
}

describe('--neox-ease-spring', () => {
  it('至少被定义一次', () => {
    expect(springDeclarations().length).toBeGreaterThan(0);
  });

  it('每处定义都是过冲曲线, 不是别的 easing 的别名', () => {
    const bad = springDeclarations().filter((d) => !overshoots(d.value));
    expect(bad.map((d) => `${d.file}: ${d.value}`)).toEqual([]);
  });

  it('确实有人在用 —— 光有 token 没有引用等于没做', () => {
    let uses = 0;
    for (const f of walkCss(RENDERER)) {
      const css = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      uses += (css.match(/var\(--neox-ease-spring/g) ?? []).length;
    }
    expect(uses).toBeGreaterThan(3);
  });
});
