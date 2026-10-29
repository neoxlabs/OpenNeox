/**
 * P-15 —— PPT 生成后自检补六项: 空页 / 只有标题 / 图片拉伸 / 文字出页 / 字号过小 / 对比度过低。
 *
 * 全部是 **warn 提示**, 不进 MUST_FIX_KINDS (总控裁决原则 1: 先提示, 不硬拦)。
 * 这里手工造最小 pptx (只给 presentation.xml + slide XML), 因为要精确控制形状、图片像素和颜色。
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { formatAdvisoryLines, inspectPptxBytes, isMustFix } from '../pptxInspect.js';

const EMU = 9525;                       /* 1px = 9525 EMU */
const SLIDE_W = 1280 * EMU;
const SLIDE_H = 720 * EMU;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface Box { x: number; y: number; w: number; h: number }

/** 一个 <p:sp>; 不给 text 就是纯色块 (装饰, 没有 run) */
function sp(o: Box & {
  id: number; name?: string; text?: string; size?: number; color?: string; fill?: string;
  /** custGeom = 任意路径 (箭头/折线), 包围盒不代表实际像素 */
  cust?: boolean;
  /** 描边色 (折线图的数据线) */
  line?: string;
}): string {
  const xfrm = `<a:xfrm><a:off x="${o.x * EMU}" y="${o.y * EMU}"/><a:ext cx="${o.w * EMU}" cy="${o.h * EMU}"/></a:xfrm>`;
  const geom = o.cust
    ? '<a:custGeom><a:pathLst><a:path w="100" h="100"><a:moveTo><a:pt x="0" y="0"/></a:moveTo>'
      + '<a:lnTo><a:pt x="100" y="100"/></a:lnTo></a:path></a:pathLst></a:custGeom>'
    : '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
  const fill = o.fill ? `<a:solidFill><a:srgbClr val="${o.fill}"/></a:solidFill>` : '<a:noFill/>';
  const ln = o.line
    ? `<a:ln w="19050"><a:solidFill><a:srgbClr val="${o.line}"/></a:solidFill></a:ln>`
    : '';
  const body = o.text
    ? `<a:p><a:r><a:rPr lang="zh-CN" sz="${(o.size ?? 18) * 100}">`
      + `<a:solidFill><a:srgbClr val="${o.color ?? '222222'}"/></a:solidFill>`
      + '<a:latin typeface="PingFang SC"/><a:ea typeface="PingFang SC"/></a:rPr>'
      + `<a:t>${esc(o.text)}</a:t></a:r></a:p>`
    : '<a:p><a:endParaRPr lang="zh-CN"/></a:p>';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${o.id}" name="${o.name ?? `Box ${o.id}`}"/>`
    + '<p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
    + `<p:spPr>${xfrm}${geom}${fill}${ln}</p:spPr>`
    + `<p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${body}</p:txBody></p:sp>`;
}

function pic(o: Box & { id: number; rid: string }): string {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${o.id}" name="Picture ${o.id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>`
    + `<p:blipFill><a:blip r:embed="${o.rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>`
    + `<p:spPr><a:xfrm><a:off x="${o.x * EMU}" y="${o.y * EMU}"/>`
    + `<a:ext cx="${o.w * EMU}" cy="${o.h * EMU}"/></a:xfrm></p:spPr></p:pic>`;
}

function slide(name: string, ...shapes: string[]): string {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
    + ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<p:cSld name="${name}"><p:spTree>${shapes.join('')}</p:spTree></p:cSld></p:sld>`;
}

/** 最小的合法 PNG 头 (探测尺寸只需签名 + IHDR 的宽高) */
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(48);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0, 0, 0, 13], 8);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  const put = (off: number, v: number) => {
    b[off] = (v >>> 24) & 255; b[off + 1] = (v >>> 16) & 255; b[off + 2] = (v >>> 8) & 255; b[off + 3] = v & 255;
  };
  put(16, w); put(20, h);
  return b;
}

async function mkPptx(slides: string[], media?: Record<string, Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', '<?xml version="1.0" encoding="UTF-8"?>'
    + '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
    + `<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/></p:presentation>`);
  slides.forEach((xml, i) => zip.file(`ppt/slides/slide${i + 1}.xml`, xml));
  if (media) {
    for (const [name, bytes] of Object.entries(media)) {
      zip.file(name, bytes);
      zip.file('ppt/slides/_rels/slide1.xml.rels', '<?xml version="1.0" encoding="UTF-8"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"'
        + ' Target="../media/image1.png"/></Relationships>');
    }
  }
  return zip.generateAsync({ type: 'uint8array' });
}

const find = (report: Awaited<ReturnType<typeof inspectPptxBytes>>, kind: string, slideNo?: number) =>
  report.issues.find((x) => x.kind === kind && (slideNo == null || x.slide === slideNo));

describe('pptx 自检: P-15 六项提示', () => {
  it('空页: 只有装饰色块没有内容 → empty-slide', async () => {
    const report = await inspectPptxBytes(await mkPptx([
      slide('bullet-list', sp({ id: 1, x: 0, y: 0, w: 400, h: 200, fill: 'EEEEEE' })),
    ]));
    const issue = find(report, 'empty-slide');
    expect(issue).toBeTruthy();
    expect(issue!.severity).toBe('warn');
    expect(isMustFix(issue!)).toBe(false);
  });

  it('只有标题 → title-only, 并行回执里带页码', async () => {
    const report = await inspectPptxBytes(await mkPptx([
      slide('cover-hero', sp({ id: 1, x: 80, y: 240, w: 900, h: 120, text: '季度汇报', size: 56 })),
      slide('bullet-list', sp({ id: 1, x: 80, y: 80, w: 800, h: 70, text: '营收情况', size: 36 })),
    ]));
    const issue = find(report, 'title-only', 2);
    expect(issue).toBeTruthy();
    expect(issue!.message).toMatch(/只有标题/);
    expect(formatAdvisoryLines(report).some((l) => l.startsWith('第 2 页:') && l.includes('只有标题'))).toBe(true);
  });

  it('封面只有标题不报 title-only', async () => {
    const report = await inspectPptxBytes(await mkPptx([
      slide('cover-hero', sp({ id: 1, x: 80, y: 240, w: 900, h: 120, text: '季度汇报', size: 56 })),
    ]));
    expect(find(report, 'title-only')).toBeUndefined();
  });

  it('图片被拉伸变形 → image-stretched (裁切过的 cover 不算)', async () => {
    const report = await inspectPptxBytes(
      await mkPptx([
        slide('hero-image-quote',
          pic({ id: 2, rid: 'rId2', x: 100, y: 100, w: 400, h: 100 }),   /* 方图塞进 4:1 的框 */
        ),
      ], { 'ppt/media/image1.png': png(200, 200) }),
    );
    const issue = find(report, 'image-stretched', 1);
    expect(issue).toBeTruthy();
    expect(issue!.message).toMatch(/拉伸变形/);
  });

  it('文字排出页面底部 → text-off-page', async () => {
    const long = '这一页的文字量远超文本框能容纳的高度, 于是多出来的行会一直排到页面之外, 观众完全看不到。'.repeat(3);
    const report = await inspectPptxBytes(await mkPptx([
      slide('bullet-list', sp({ id: 1, x: 80, y: 650, w: 320, h: 40, text: long, size: 20 })),
    ]));
    const issue = find(report, 'text-off-page', 1);
    expect(issue).toBeTruthy();
    expect(issue!.message).toMatch(/排出页面底部/);
  });

  it('字号过小 → font-too-small', async () => {
    const report = await inspectPptxBytes(await mkPptx([
      slide('bullet-list',
        sp({ id: 1, x: 80, y: 80, w: 800, h: 70, text: '营收情况', size: 36 }),
        sp({ id: 2, x: 80, y: 200, w: 800, h: 40, text: '这个小字看不清', size: 8 })),
    ]));
    expect(find(report, 'font-too-small', 1)).toBeTruthy();
  });

  it('文字与底色对比度过低 → low-contrast (浅灰底上的白字)', async () => {
    const report = await inspectPptxBytes(await mkPptx([
      slide('bullet-list',
        sp({ id: 1, x: 80, y: 80, w: 800, h: 70, text: '营收情况', size: 36 }),
        sp({ id: 2, x: 80, y: 200, w: 600, h: 240, fill: 'F5F5F5' }),
        sp({ id: 3, x: 120, y: 280, w: 400, h: 60, text: '白字压浅灰底', size: 20, color: 'FFFFFF' })),
    ]));
    const issue = find(report, 'low-contrast', 1);
    expect(issue).toBeTruthy();
    expect(issue!.message).toMatch(/对比度只有/);
    expect(isMustFix(issue!)).toBe(false);
  });

  it('正常页 (深字浅底) 不误报 low-contrast', async () => {
    const report = await inspectPptxBytes(await mkPptx([
      slide('bullet-list',
        sp({ id: 1, x: 80, y: 80, w: 800, h: 70, text: '营收情况', size: 36 }),
        sp({ id: 2, x: 80, y: 200, w: 600, h: 240, fill: 'FFFFFF' }),
        sp({ id: 3, x: 120, y: 280, w: 400, h: 60, text: '正常深色字', size: 20, color: '222222' })),
    ]));
    expect(find(report, 'low-contrast')).toBeUndefined();
  });

  it('自定义几何 (箭头 / 折线) 的包围盒不是底色, 不误报对比度', async () => {
    const report = await inspectPptxBytes(await mkPptx([
      slide('process-flow',
        sp({ id: 1, x: 80, y: 80, w: 800, h: 70, text: '推进路径', size: 36 }),
        /* 跨越整页的箭头 custGeom —— 包围盒盖住文字, 实际像素不在这里 */
        sp({ id: 2, x: 80, y: 200, w: 1000, h: 400, fill: 'C07975', cust: true }),
        sp({ id: 3, x: 120, y: 280, w: 400, h: 60, text: '看数', size: 20, color: '7C664C' })),
    ]));
    expect(find(report, 'low-contrast')).toBeUndefined();
  });

  it('描边色 (折线图的数据线) 不是底色, 不误报对比度', async () => {
    const report = await inspectPptxBytes(await mkPptx([
      slide('chart-focus',
        sp({ id: 1, x: 80, y: 80, w: 800, h: 70, text: '月度趋势', size: 36 }),
        /* noFill + 深红描边 —— 原来的解析把描边当成了"整片红底" */
        sp({ id: 2, x: 80, y: 200, w: 1000, h: 300, line: '8B0000', cust: true }),
        sp({ id: 3, x: 300, y: 260, w: 60, h: 24, text: '120', size: 20, color: '2A1F1A' })),
    ]));
    expect(find(report, 'low-contrast')).toBeUndefined();
  });

  it('六项提示都不是必修 (总控裁决: 提示不是闸)', async () => {
    const long = '文字量远超文本框, 多出来的行排到页面之外。'.repeat(20);
    const report = await inspectPptxBytes(await mkPptx([
      slide('bullet-list', sp({ id: 1, x: 80, y: 600, w: 300, h: 40, text: long, size: 8, color: 'FFFFFF' })),
    ]));
    for (const kind of ['text-off-page', 'font-too-small']) {
      const issue = find(report, kind, 1);
      expect(issue, kind).toBeTruthy();
      expect(isMustFix(issue!), kind).toBe(false);
    }
  });
});
