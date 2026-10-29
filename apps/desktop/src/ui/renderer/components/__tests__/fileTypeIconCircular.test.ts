import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(DIR, 'FileTypeIcon.tsx'), 'utf8');
const ASSET_DIR = path.join(DIR, '..', 'assets', 'icons', 'file-types');

describe('FileTypeIcon', () => {
  it('素材还在 —— 真 logo 不是"没有素材"的问题', () => {
    const svgs = fs.readdirSync(ASSET_DIR).filter((f) => f.endsWith('.svg'));
    expect(svgs.length, '真 brand logo 素材少于 40 个, 是不是被误删了?').toBeGreaterThan(40);
    /* js/ts 这两个是"实心方块型" logo 的代表 —— 圆裁的意义全在它们身上 */
    expect(svgs).toContain('javascript.svg');
    expect(svgs).toContain('typescript.svg');
  });

  it('默认走真 logo, 不是字母圆盘', () => {
    expect(SRC).toMatch(/variant\s*=\s*'logo'\s*\}/);
  });

  /* 三条渲染路径 = 三个 return: 字母圆盘(disc) / 真 logo / 认不出的兜底。
   * 每一条都必须是圆的 —— 只要有一条是方的, 一列文件里就会圆方混排, 那正是
   * 用户反复指的问题。 */
  it('每条渲染路径都是圆的', () => {
    /* disc 分支自己画圆 */
    expect(SRC).toMatch(/borderRadius:\s*'50%'/);
    /* 真 logo 分支必须有圆裁 + overflow hidden (方块 logo 靠它被裁成圆) */
    const logoBranch = SRC.slice(SRC.indexOf('const colored = colorizeSvg'));
    expect(logoBranch, '真 logo 分支没有圆形裁切').toMatch(/borderRadius:\s*'50%'/);
    expect(logoBranch, '圆角不配 overflow:hidden 是裁不到的').toMatch(/overflow:\s*'hidden'/);
    /* 兜底分支不许再渲染方形通用图标 —— 它必须转投 disc */
    expect(SRC, '认不出类型时又渲染了方形 GenericFileSvg')
      .not.toMatch(/if\s*\(!spec\)\s*\{[\s\S]{0,200}GenericFileSvg/);
  });

  it('小尺寸不许退化成"没有字的纯色点"', () => {
    /* 上一版在 <16px 时 return '' —— 圆点没有类型线索, 用户当场否掉 */
    expect(SRC, 'discLabelForSize 又开始返回空串了')
      .not.toMatch(/discLabelForSize[\s\S]{0,400}return\s*'';/);
  });

  it('字号不许小到读不出 —— 真机量到过 6px', () => {
    const m = /Math\.max\((\d+),\s*Math\.round\(size \* ratio\)\)/.exec(SRC);
    expect(m, 'discFontSize 的下限被挪走了').not.toBeNull();
    expect(Number(m![1]), '字号下限低于 8px, 那不是小, 是一团糊').toBeGreaterThanOrEqual(8);
  });
});
