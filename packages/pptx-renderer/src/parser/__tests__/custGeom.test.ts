/**
 * custGeom 往返
 *
 * 解析器原来只读 prstGeom, custGeom 一律落成 'rect' —— 右侧 PPT 预览 (parsePptx → SlideView)
 * 把每个自定义形状画成外接矩形框。导出是对的, 只有我们自己的预览看不见。
 * 这里钉住: 导出的 custGeom 解析回来仍是 geom:'custom' + 真实路径, 只描边的保持只描边, 弧线不丢。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { Presentation, exportPptx, parsePptx } from '../../index.js';

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

describe('custGeom 解析', () => {
  it('填充路径 + 只描边的环, 解析回来都是 custom 且保留路径', async () => {
    const ppt = Presentation.create({ slideSize: { width: 1280, height: 720 } });
    const s = ppt.slides.add();
    s.shapes.add({
      geometry: 'custom',
      customPath: { d: 'M0 0 L100 0 L60 100 Z', viewBox: { width: 100, height: 100 } },
      position: { left: 100, top: 100, width: 300, height: 200 },
      fill: '#8C6A34',
    });
    s.shapes.add({
      geometry: 'custom',
      customPath: {
        d: 'M0,50 A50,50 0 1 0 100,50 A50,50 0 1 0 0,50 Z',
        viewBox: { width: 100, height: 100 },
        strokeOnly: true,
      },
      position: { left: 600, top: 100, width: 200, height: 200 },
      border: { color: '#14233C', width: 1 },
    });

    const bytes = (await exportPptx(ppt)).bytes();
    const parsed = await parsePptx(bytes);
    const shapes = parsed.slides[0]!.shapes.filter((x: any) => x.kind === 'shape') as any[];
    const customs = shapes.filter((x) => x.geom === 'custom');
    expect(customs.length).toBe(2);

    const filled = customs.find((x) => !x.customPath.strokeOnly)!;
    expect(filled.customPath.d).toMatch(/^M/);
    expect(filled.customPath.d).toContain('Z');
    expect(filled.fill?.kind).toBe('solid');

    const ring = customs.find((x) => x.customPath.strokeOnly)!;
    expect(ring).toBeDefined();
    /* 弧线必须回到 SVG 的 A 指令, 不能在往返里丢成直线 */
    expect(ring.customPath.d).toMatch(/A[\d.]+ [\d.]+ 0 [01] [01]/);
    expect(ring.border?.color).toBeTruthy();
  });
});
