/**
 * P-07 —— 长文本自动适配: 按字号档自动降, 但**不降到 14pt 以下**; 降到下限还超就报出来,
 * 让上层建议拆页, 而不是继续把字压小 (压到 11pt 投影上根本看不清)。
 */
import { describe, it, expect } from 'vitest';
import { Text, VStack, fitToBounds, MIN_FIT_FONT_PT, type ComposeNode } from '@neoxlabs/pptx-compose';

const BOUNDS = { x: 0, y: 0, width: 400, height: 140 };
const LONG = '这一页的文字多到装不下, 需要按字号档自动收缩, 但收缩必须停在一个下限, 否则投影上根本看不清。'.repeat(4);

function fontSizes(node: ComposeNode): number[] {
  const out: number[] = [];
  const walk = (n: any) => {
    if (n.kind === 'text' && typeof n.layoutParams?.fontSize === 'number') out.push(n.layoutParams.fontSize);
    for (const c of n.children ?? []) walk(c);
  };
  walk(node);
  return out;
}

describe('fitToBounds 字号下限', () => {
  it('装得下 → 不缩字号', () => {
    const r = fitToBounds(
      VStack({ gap: 12 }, [Text('短标题', { fontSize: 24 }), Text('两行正文', { fontSize: 16 })]),
      BOUNDS,
    );
    expect(r.report.density).toBe(1);
    expect(r.report.overflow).toBe(false);
    expect(r.report.fontFloorHit).toBe(false);
  });

  it('正文 14pt 的页面超容量 → 一档都不降 (再降就低于下限), 报溢出交给上层拆页', () => {
    const r = fitToBounds(
      VStack({ gap: 8 }, [Text('标题', { fontSize: 28 }), Text(LONG, { fontSize: 14 })]),
      BOUNDS,
    );
    expect(r.report.overflow).toBe(true);
    expect(r.report.overflowPx).toBeGreaterThan(0);
    expect(r.report.fontFloorHit).toBe(true);
    /* 关键: 密度不降, 字号仍是 14 —— 修之前这里会一路压到 0.72 (10.1pt) */
    expect(r.report.density).toBe(1);
    expect(Math.min(...fontSizes(r.tree))).toBeGreaterThanOrEqual(MIN_FIT_FONT_PT);
  });

  it('正文 16pt 的页面超容量 → 降一档就停 (14.1pt), 不会继续压到下限以下', () => {
    const r = fitToBounds(
      VStack({ gap: 8 }, [Text('标题', { fontSize: 28 }), Text(LONG, { fontSize: 16 })]),
      BOUNDS,
    );
    expect(r.report.overflow).toBe(true);
    expect(r.report.density).toBeLessThan(1);
    expect(r.report.density).toBeGreaterThanOrEqual(0.88);
    /* 16 × 0.88 = 14.1 —— 正好停在下限上 */
    expect(r.report.minFontPt).toBeGreaterThanOrEqual(MIN_FIT_FONT_PT);
    for (const size of fontSizes(r.tree)) {
      if (size > 0 && size < 28) expect(size).toBeGreaterThanOrEqual(MIN_FIT_FONT_PT);
    }
  });

  it('模板里 10-12pt 的图注不卡整页收缩 (它们本来就在下限以下, 按比例缩是原行为)', () => {
    const r = fitToBounds(
      VStack({ gap: 8 }, [
        Text('标题', { fontSize: 28 }),
        Text(LONG, { fontSize: 16 }),
        Text('图注', { fontSize: 11 }),
      ]),
      BOUNDS,
    );
    expect(r.report.density).toBeLessThan(1);
  });
});
