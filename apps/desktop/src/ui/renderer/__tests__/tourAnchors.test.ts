
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const TOUR = join(ROOT, 'components/TourOverlay.tsx');

/** 遍历渲染层源码, 跳过自己 (__tests__) 和引导本体 */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === '__tests__' || name === 'node_modules' || name === 'assets') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(tsx|ts)$/.test(name)) continue;
      if (full === TOUR) continue; // 引导本体只是**引用**锚点, 不是锚点的定义处
      out.push(full);
    }
  };
  walk(ROOT);
  return out;
}

const tourSrc = readFileSync(TOUR, 'utf8');
const declared = [...tourSrc.matchAll(/sel:\s*'\[data-tour="([^"]+)"\]'/g)].map((m) => m[1]);

/* 渲染层里真正挂出来的 data-tour 值 */
const rendered = new Set<string>();
for (const file of sources()) {
  for (const m of readFileSync(file, 'utf8').matchAll(/data-tour="([^"]+)"/g)) rendered.add(m[1]);
}

describe('引导锚点', () => {
  it('对照组: 引导里确实声明了锚点, 渲染层也确实挂了锚点', () => {
    expect(declared.length).toBeGreaterThanOrEqual(3);
    expect(rendered.size).toBeGreaterThanOrEqual(3);
  });

  it('引导里每个 sel 都能在渲染层找到对应的 data-tour', () => {
    const missing = declared.filter((d) => !rendered.has(d));
    expect(missing, `引导指向了不存在的锚点: ${missing.join(' / ')}。`
      + '组件改版后锚点断链时引导不会报错, 只会把气泡飘到屏幕中间讲一段用户根本找不到的功能。').toEqual([]);
  });

  it('引导不许再用样式类当锚点 (改样式=静默断链)', () => {
    const classSels = [...tourSrc.matchAll(/sel:\s*'([^']+)'/g)]
      .map((m) => m[1])
      .filter((s) => !s.startsWith('[data-tour='));
    expect(classSels, `这些锚点还在用样式类: ${classSels.join(' / ')}`).toEqual([]);
  });
});
