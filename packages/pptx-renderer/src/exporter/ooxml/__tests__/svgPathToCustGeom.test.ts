import { describe, it, expect } from 'vitest';
import {
  svgPathToCustGeom,
  tokenizeSvgPath,
  normalizeSvgPath,
  arcEndpointToCenter,
  SvgPathParseError,
  CUST_GEOM_SPACE,
} from '../svgPathToCustGeom.js';

const box = { viewBoxWidth: 100, viewBoxHeight: 100 };

describe('tokenize', () => {
  it('切开指令和数字, 支持无分隔的负数', () => {
    expect(tokenizeSvgPath('M0 0L10-20')).toEqual([
      { cmd: 'M', args: [0, 0] },
      { cmd: 'L', args: [10, -20] },
    ]);
  });

  it('隐式重复: L 带 4 个数 = 两段 L', () => {
    expect(tokenizeSvgPath('L1 2 3 4')).toEqual([
      { cmd: 'L', args: [1, 2] },
      { cmd: 'L', args: [3, 4] },
    ]);
  });

  it('M 的后续组按规范当 lineTo (大小写跟随)', () => {
    expect(tokenizeSvgPath('M1 2 3 4')).toEqual([
      { cmd: 'M', args: [1, 2] },
      { cmd: 'L', args: [3, 4] },
    ]);
    expect(tokenizeSvgPath('m1 2 3 4')).toEqual([
      { cmd: 'm', args: [1, 2] },
      { cmd: 'l', args: [3, 4] },
    ]);
  });

  it('吃得下 .5 / 1e-3 这种数字写法', () => {
    expect(tokenizeSvgPath('M.5 1e2')).toEqual([{ cmd: 'M', args: [0.5, 100] }]);
  });

  it('arc 的 flag 连写也能解开 (a1 1 0 011 1)', () => {
    const t = tokenizeSvgPath('A1 1 0 011 1');
    expect(t).toEqual([{ cmd: 'A', args: [1, 1, 0, 0, 1, 1, 1] }]);
  });

  it('参数个数不对要报错, 不能悄悄画错', () => {
    expect(() => tokenizeSvgPath('L1')).toThrow(SvgPathParseError);
    expect(() => tokenizeSvgPath('M0 0 X')).toThrow(SvgPathParseError);
  });
});

describe('normalize', () => {
  it('相对坐标转绝对', () => {
    const r = normalizeSvgPath(tokenizeSvgPath('M10 10 l5 5 l5 -5'));
    expect(r).toEqual([
      { cmd: 'M', args: [10, 10] },
      { cmd: 'L', args: [15, 15] },
      { cmd: 'L', args: [20, 10] },
    ]);
  });

  it('H/V 展开成 L', () => {
    const r = normalizeSvgPath(tokenizeSvgPath('M0 0 H50 V30'));
    expect(r).toEqual([
      { cmd: 'M', args: [0, 0] },
      { cmd: 'L', args: [50, 0] },
      { cmd: 'L', args: [50, 30] },
    ]);
  });

  it('S 的隐含控制点 = 当前点关于上一个第二控制点的映射', () => {
    const r = normalizeSvgPath(tokenizeSvgPath('M0 0 C10 0 20 10 20 20 S40 30 40 40'));
    /* 上一段第二控制点 (20,10), 当前点 (20,20) → 映射得 (20,30) */
    expect(r[2]).toEqual({ cmd: 'C', args: [20, 30, 40, 30, 40, 40] });
  });

  it('T 的隐含控制点同理 (二次)', () => {
    const r = normalizeSvgPath(tokenizeSvgPath('M0 0 Q10 10 20 0 T40 0'));
    /* Q 控制点 (10,10), 当前点 (20,0) → 映射得 (30,-10) */
    expect(r[2]).toEqual({ cmd: 'Q', args: [30, -10, 40, 0] });
  });

  it('Z 之后当前点回到子路径起点', () => {
    const r = normalizeSvgPath(tokenizeSvgPath('M10 10 L20 20 Z l5 5'));
    expect(r[r.length - 1]).toEqual({ cmd: 'L', args: [15, 15] });
  });
});

describe('arc 端点参数 → 圆心参数', () => {
  it('半圆: (0,0)→(10,0), r=5, sweep=1 → 圆心 (5,0), 扫过 180°', () => {
    const c = arcEndpointToCenter(0, 0, 5, 5, 0, 0, 1, 10, 0)!;
    expect(c.cx).toBeCloseTo(5, 6);
    expect(c.cy).toBeCloseTo(0, 6);
    expect(Math.abs(c.deltaAngle)).toBeCloseTo(Math.PI, 6);
    expect(c.deltaAngle).toBeGreaterThan(0);          /* sweep=1 → 正向 */
  });

  it('sweep=0 时扫过角为负 (反向)', () => {
    const c = arcEndpointToCenter(0, 0, 5, 5, 0, 0, 0, 10, 0)!;
    expect(c.deltaAngle).toBeLessThan(0);
  });

  it('半径太小时按规范放大到刚好够', () => {
    const c = arcEndpointToCenter(0, 0, 1, 1, 0, 0, 1, 10, 0)!;
    expect(c.rx).toBeCloseTo(5, 6);
    expect(c.ry).toBeCloseTo(5, 6);
  });

  it('起终点重合 / 半径为 0 → null (调用方降级成直线)', () => {
    expect(arcEndpointToCenter(0, 0, 5, 5, 0, 0, 1, 0, 0)).toBeNull();
    expect(arcEndpointToCenter(0, 0, 0, 5, 0, 0, 1, 10, 0)).toBeNull();
  });
});

describe('生成 custGeom XML', () => {
  it('坐标映射到 21600 空间', () => {
    const xml = svgPathToCustGeom('M0 0 L100 100 Z', box);
    expect(xml).toContain(`<a:path w="${CUST_GEOM_SPACE}" h="${CUST_GEOM_SPACE}"`);
    expect(xml).toContain('<a:moveTo><a:pt x="0" y="0"/></a:moveTo>');
    expect(xml).toContain(`<a:lnTo><a:pt x="${CUST_GEOM_SPACE}" y="${CUST_GEOM_SPACE}"/></a:lnTo>`);
    expect(xml).toContain('<a:close/>');
  });

  it('非方形 viewBox: x/y 各按自己的边归一化', () => {
    const xml = svgPathToCustGeom('M200 50 Z', { viewBoxWidth: 400, viewBoxHeight: 100 });
    /* 200/400 = 0.5 → 10800; 50/100 = 0.5 → 10800 */
    expect(xml).toContain('<a:pt x="10800" y="10800"/>');
  });

  it('三次贝塞尔 → cubicBezTo, 三个点齐全', () => {
    const xml = svgPathToCustGeom('M0 0 C25 0 75 100 100 100', box);
    expect(xml).toContain(
      '<a:cubicBezTo><a:pt x="5400" y="0"/><a:pt x="16200" y="21600"/><a:pt x="21600" y="21600"/></a:cubicBezTo>',
    );
  });

  it('二次贝塞尔 → quadBezTo, 两个点', () => {
    const xml = svgPathToCustGeom('M0 0 Q50 100 100 0', box);
    expect(xml).toContain('<a:quadBezTo><a:pt x="10800" y="21600"/><a:pt x="21600" y="0"/></a:quadBezTo>');
  });

  it('圆弧 → arcTo, 角度单位是 1/60000 度', () => {
    const xml = svgPathToCustGeom('M0 50 A50 50 0 0 1 100 50', box);
    expect(xml).toMatch(/<a:arcTo wR="10800" hR="10800" stAng="-?\d+" swAng="\d+"\/>/);
    /* 180° = 180 * 60000 */
    expect(xml).toContain('swAng="10800000"');
  });

  it('带 x 轴旋转的弧降级成贝塞尔 (OOXML arcTo 表达不了旋转)', () => {
    const xml = svgPathToCustGeom('M0 50 A50 25 45 0 1 100 50', box);
    expect(xml).not.toContain('<a:arcTo');
    expect(xml).toContain('<a:cubicBezTo>');
  });

  it('strokeOnly 走 fill="none" (分隔线这种只描边的路径)', () => {
    expect(svgPathToCustGeom('M0 0 L100 0', { ...box, strokeOnly: true })).toContain('fill="none"');
    expect(svgPathToCustGeom('M0 0 L100 0', box)).toContain('fill="norm"');
  });

  it('空 path / 非法 viewBox 要报错', () => {
    expect(() => svgPathToCustGeom('', box)).toThrow(SvgPathParseError);
    expect(() => svgPathToCustGeom('M0 0', { viewBoxWidth: 0, viewBoxHeight: 100 })).toThrow(SvgPathParseError);
  });

  it('多子路径 (带洞的形状) 全部保留', () => {
    const xml = svgPathToCustGeom('M0 0 L100 0 L100 100 Z M25 25 L75 25 L75 75 Z', box);
    expect(xml.match(/<a:moveTo>/g)).toHaveLength(2);
    expect(xml.match(/<a:close\/>/g)).toHaveLength(2);
  });
});

describe('真实图形: 明康截图里那个带艺术细节的箭头', () => {
  /* 一个"胶囊 + 尖头"的复合箭头 —— 预设形状画不出来的那种 */
  const ARROW = 'M0 30 L60 30 L60 0 L100 50 L60 100 L60 70 L0 70 A20 20 0 0 1 0 30 Z';

  it('转换不抛错, 指令全部落地', () => {
    const xml = svgPathToCustGeom(ARROW, box);
    expect(xml.match(/<a:lnTo>/g)!.length).toBe(6);
    expect(xml).toContain('<a:arcTo');
    expect(xml).toContain('<a:close/>');
  });

  it('输出是良构 XML 片段 (标签配对)', () => {
    const xml = svgPathToCustGeom(ARROW, box);
    const open = (xml.match(/<a:[a-zA-Z]+(?![^>]*\/>)[^>]*>/g) ?? []).length;
    const close = (xml.match(/<\/a:[a-zA-Z]+>/g) ?? []).length;
    expect(open).toBe(close);
  });
});

describe('圆角化 roundPathCorners', () => {
  it('正方形四角磨圆: 每个角变成 L + Q', async () => {
    const { roundPathCorners } = await import('../svgPathToCustGeom.js');
    const r = roundPathCorners('M0 0 L100 0 L100 100 L0 100 Z', 10);
    expect((r.match(/Q/g) ?? []).length).toBe(4);
    expect(r.endsWith('Z')).toBe(true);
    /* 起点被挪到第一条边的切点上, 不再是原顶点 */
    expect(r.startsWith('M0 0')).toBe(false);
  });

  it('半径超过邻边一半时自动收敛, 不产生自交', async () => {
    const { roundPathCorners } = await import('../svgPathToCustGeom.js');
    const r = roundPathCorners('M0 0 L10 0 L10 10 L0 10 Z', 999);
    /* 边长 10 → 半径被夹到 5, 切点落在边中点 */
    expect(r).toContain('L5 0');
  });

  it('开放路径的首尾端点不磨 (它们是端点不是拐角)', async () => {
    const { roundPathCorners } = await import('../svgPathToCustGeom.js');
    const r = roundPathCorners('M0 0 L50 0 L50 50', 8);
    expect(r.startsWith('M0 0')).toBe(true);
    expect(r.trimEnd().endsWith('L50 50')).toBe(true);
    expect((r.match(/Q/g) ?? []).length).toBe(1);   /* 只有中间那个角 */
  });

  it('含曲线的路径原样返回 (曲线拐角本来就圆滑)', async () => {
    const { roundPathCorners } = await import('../svgPathToCustGeom.js');
    const d = 'M0 0 C10 0 20 10 20 20 L0 20 Z';
    expect(roundPathCorners(d, 10)).toContain('C');
  });

  it('radius <= 0 直接原样返回', async () => {
    const { roundPathCorners } = await import('../svgPathToCustGeom.js');
    expect(roundPathCorners('M0 0 L1 1', 0)).toBe('M0 0 L1 1');
  });

  it('圆角后的 path 仍能转成合法 custGeom', async () => {
    const { roundPathCorners } = await import('../svgPathToCustGeom.js');
    const wing = roundPathCorners('M0 0 L104 0 L160 60 L104 120 L0 120 L56 60 Z', 14);
    const xml = svgPathToCustGeom(wing, { viewBoxWidth: 160, viewBoxHeight: 120 });
    expect((xml.match(/<a:quadBezTo>/g) ?? []).length).toBe(6);   /* 六个角全磨到 */
    expect(xml).toContain('<a:close/>');
  });
});
