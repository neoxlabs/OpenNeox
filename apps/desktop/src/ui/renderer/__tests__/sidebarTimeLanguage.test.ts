import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const sidebar = strip(readFileSync(resolve(HERE, '../modules/shell/Sidebar.tsx'), 'utf8'));

describe('侧栏相对时间的语言', () => {
  it('渲染时按当前语言重算, 不直接用构建期的 timeText 快照', () => {
    expect(sidebar).toMatch(/formatRelativeTime\(s\.ts, isZh \? 'zh' : 'en'\)/);
  });

  it('拿不到 ts 才回落快照 —— 回落仍在, 不是把它删了', () => {
    expect(sidebar).toMatch(/s\.ts \? formatRelativeTime\([\s\S]{0,60}: \(s\.timeText \?\? ''\)/);
  });

  /* hover tooltip 一直是按 isZh 现算的 —— 可见文字必须跟它一致, 否则同一行两种语言 */
  it('可见文字和 hover tooltip 用同一个语言判据', () => {
    expect(sidebar).toMatch(/toLocaleString\(isZh \? 'zh-CN' : 'en-US'/);
  });
});
