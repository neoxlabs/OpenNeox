/**
 * 背景 / 母版装饰 / 表格 (需求：「大问题 为什么没有背景」)。
 * fixture: neox-bench/pptx/公司模板.pptx —— python-pptx 造的「公司模板」: 母版深色底 + 底部橙条 + 右上角文字,
 * 5 页分别是 继承母版 / 本页渐变 / 本页图片 / showMasterSp=0 / 表格。没有这份文件的机器跳过。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { parsePptx } from '../index.js';
import type { Presentation } from '../../model/types.js';

const FIXTURE = path.join(os.homedir(), 'AI/MK/neox-bench/pptx/公司模板.pptx');

describe.skipIf(!fs.existsSync(FIXTURE))('母版 / 版式 / 背景 / 表格', () => {
  let pres: Presentation;
  beforeAll(async () => {
    (globalThis as any).DOMParser = DOMParser;
    pres = await parsePptx(new Uint8Array(fs.readFileSync(FIXTURE)));
  });

  const hasBar = (i: number) => pres.slides[i].shapes.some((s) => s.kind === 'shape' && s.fill?.kind === 'solid' && s.fill.color === '#E07A1F');
  /* 精确匹配: 第 4 页自己的正文里就写着 "不该有橙条和 NEOX 公司", 用 includes 会误命中 */
  const hasBrand = (i: number) => pres.slides[i].shapes.some((s) => s.kind === 'text' && s.paragraphs.some((p) => p.runs.map((r) => r.text).join('').trim() === 'NEOX 公司'));

  it('没设背景的页继承母版的深色底, 母版的色条和文字画在本页下面', () => {
    expect(pres.slides[0].background).toEqual({ kind: 'solid', color: '#1F2A44' });
    expect(hasBar(0)).toBe(true);
    expect(hasBrand(0)).toBe(true);
    /* 母版装饰在最底层: 排在本页标题前面 */
    const firstOwn = pres.slides[0].shapes.findIndex((s) => s.kind === 'text' && s.paragraphs.some((p) => p.runs.some((r) => r.text.includes('母版深色背景'))));
    expect(firstOwn).toBeGreaterThan(0);
  });

  it('本页自己的渐变 / 图片背景覆盖母版; 装饰仍在', () => {
    expect(pres.slides[1].background?.kind).toBe('grad');
    expect(hasBar(1)).toBe(true);
    const bg = pres.slides[2].background;
    expect(bg?.kind).toBe('pic');
    expect(bg && bg.kind === 'pic' && bg.src.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('showMasterSp="0": 背景照样继承, 装饰不画', () => {
    expect(pres.slides[3].background).toEqual({ kind: 'solid', color: '#1F2A44' });
    expect(hasBar(3)).toBe(false);
    expect(hasBrand(3)).toBe(false);
  });

  it('表格读出来了: 3×3, 表头 / 斑马标记在', () => {
    const t = pres.slides[4].shapes.find((s) => s.kind === 'table');
    expect(t && t.kind === 'table' && t.rows.length).toBe(3);
    if (t?.kind !== 'table') return;
    expect(t.rows[1].cells.map((c) => c.paragraphs?.[0]?.runs.map((r) => r.text).join(''))).toEqual(['华东', '620', '21%']);
    expect(t.hasHeader).toBe(true);
    expect(t.zebra).toBe(true);
  });
});
