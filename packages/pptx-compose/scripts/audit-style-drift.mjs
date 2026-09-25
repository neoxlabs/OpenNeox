#!/usr/bin/env node
/* eslint-disable */
/**
 * audit-style-drift — 找出模板里"不从主题派生"的视觉字面量。
 *
 * ════════════════════════════════════════════════════════════════════════
 * 为什么是静态扫描而不是运行时断言
 * ------------------------------------------------------------------------
 * styleSpec.ts 里原本有个 assertWithinSpec(spec, {colors, fontSizes}):
 * "组件如果偷偷用了 spec 之外的值, 在这里拦下来"。它**从来没有被调用过**,
 * 而且按它的写法也不可能被调用 —— 它要求每个颜色都**等于**调色板里的某一个,
 * 但模板里绝大多数颜色是**派生**的 (mixHex / withAlpha / readableAccent /
 * seriesPalette), 那才是对的做法。真跑一次会全线抛异常。
 *
 * 一个名叫 assertWithinSpec 的函数摆在仓库里, 会让人以为风格漂移是被检查的 ——
 * 比没有检查更糟。所以换成这个: 检查"有没有绕过主题直接写死值", 这才是漂移的
 * 真实来源 (今晚已经手工抓到三处: 暖色橙硬编码在所有主题上、corporate 的 surface
 * 色硬编码、卡片阴影色硬编码)。
 *
 * 用法: node scripts/audit-style-drift.mjs        (有问题时退出码 1)
 * ════════════════════════════════════════════════════════════════════════
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'templates');

/* 允许的例外 —— 每一条都要有理由, 不是"先加进去让它过" */
const ALLOW = [
  /* 条件占位: 三元分支里"什么都不画"的空 Shape */
  { re: /rgba\(0,\s*0,\s*0,\s*0\)/, why: '透明占位' },
  /* 压在深色 scrim / 图片上的文字 —— 与主题无关, 图片底色不可知 */
  { re: /'#FFFFFF'/, why: '图片/scrim 上的文字', files: ['cover-hero.ts', 'photo-spread.ts'] },
  /* 遮罩必须是**中性黑**: 用主题色会给照片染色。三档是同一条渐变的停靠点 ——
   * 顶部淡出 0 · 到文字区就位 0.55 (这个值给出白字 ≥4.77 的下界) · 底部 0.68。 */
  { re: /rgba\(0,\s*0,\s*0,\s*0(\.55|\.68)?\)/, why: '图片遮罩 scrim (中性黑, 与主题无关)', files: ['cover-hero.ts', 'photo-spread.ts'] },
  /* 纯黑阴影本就与主题无关 */
  { re: /color:\s*'#000000'/, why: '中性阴影', files: ['feature-grid.ts'] },
  /* readableAccent 内部要朝纯黑/纯白拉 */
  { re: /'#ffffff'|'#000000'/, why: 'readableAccent 的拉伸目标', files: ['motif-bits.ts'] },
];

const COLOR_RE = /'#[0-9A-Fa-f]{3,8}'|rgba?\([^)]*\)/g;

let problems = 0;
const sizes = new Map();

for (const f of readdirSync(DIR).sort()) {
  if (!f.endsWith('.ts') || f === 'themes.ts' || f === 'theme.ts') continue;
  const src = readFileSync(join(DIR, f), 'utf8');
  /* 注释里的颜色不算 —— 我们的注释里到处在引用色值讲问题 */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  for (const m of code.matchAll(COLOR_RE)) {
    const lit = m[0];
    /* 模板字符串里的 rgba(${r},...) 是**构造**派生色的地方 (withAlpha), 不是硬编码 */
    if (lit.includes('${')) continue;
    const ok = ALLOW.some((a) => a.re.test(lit) && (!a.files || a.files.includes(f)));
    if (ok) continue;
    const line = code.slice(0, m.index).split('\n').length;
    console.log(`  ✗ ${f}:${line}  硬编码颜色 ${lit}`);
    problems++;
  }
  for (const m of code.matchAll(/fontSize:\s*(\d+(?:\.\d+)?)/g)) {
    const v = Number(m[1]);
    sizes.set(v, (sizes.get(v) ?? 0) + 1);
  }
}

console.log(problems === 0
  ? '颜色: 未发现绕过主题的硬编码 ✓'
  : `颜色: ${problems} 处硬编码 ✗`);

/* 字号只报告不判错: 模板里的字号是**按角色**给的 (kicker 14 / 正文 18 / 大数 52…),
 * 和 StyleSpec.type 那五档不是一回事。硬要求它们相等会逼出更糟的排版。
 * 但字号种类失控本身是信号 —— 打出来让人看见。 */
const distinct = [...sizes.keys()].sort((a, b) => a - b);
console.log(`字号: ${distinct.length} 种 — ${distinct.join(' ')}`);
if (distinct.length > 22) console.log('  ⚠ 字号种类偏多, 检查是否有随手给的数值');

process.exit(problems === 0 ? 0 : 1);
