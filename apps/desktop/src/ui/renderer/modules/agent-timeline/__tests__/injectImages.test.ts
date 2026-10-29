import { describe, expect, it } from 'vitest';

type Att = { type?: string; data?: unknown; name?: string };

function collectInjectImages(attachments: Att[]): Array<{ mediaType: string; data: string; name?: string }> {
  const out: Array<{ mediaType: string; data: string; name?: string }> = [];
  for (const a of attachments) {
    if (a.type !== 'image') continue;
    const d = a.data;
    if (typeof d !== 'string') continue;
    const m = /^data:([^;,]+);base64,(.*)$/.exec(d);
    if (!m) continue;
    out.push({ mediaType: m[1], data: m[2], name: a.name });
  }
  return out;
}

describe('附件 → 引擎图片格式', () => {
  it('dataURL 拆成 mediaType + 纯 base64 (不带 data: 前缀)', () => {
    const r = collectInjectImages([{ type: 'image', data: 'data:image/png;base64,AAAB', name: 'a.png' }]);
    expect(r).toEqual([{ mediaType: 'image/png', data: 'AAAB', name: 'a.png' }]);
  });

  it('jpeg / webp 等其它 mediaType 同样拆得出来', () => {
    const r = collectInjectImages([
      { type: 'image', data: 'data:image/jpeg;base64,XYZ' },
      { type: 'image', data: 'data:image/webp;base64,QQ==' },
    ]);
    expect(r.map(x => x.mediaType)).toEqual(['image/jpeg', 'image/webp']);
  });

  it('非图片附件跳过 —— 文档类走 parse 成文本那条路, 不归这里', () => {
    expect(collectInjectImages([{ type: 'file', data: 'data:application/pdf;base64,AAA' }])).toEqual([]);
  });

  it('不是 dataURL 的图片附件跳过, 不猜格式', () => {
    expect(collectInjectImages([
      { type: 'image', data: '/Users/x/a.png' },
      { type: 'image', data: 'https://example.com/a.png' },
      { type: 'image' },
    ])).toEqual([]);
  });

  it('空附件列表 → 空数组 (调用方据此决定不传 images 字段)', () => {
    expect(collectInjectImages([])).toEqual([]);
  });
});

function toAttachmentData(img: { mediaType?: string; data: string }): string {
  return img.data.startsWith('data:')
    ? img.data
    : `data:${img.mediaType || 'image/png'};base64,${img.data}`;
}

describe('队列图片 → attachment (必须装回 dataURL)', () => {
  it('裸 base64 补回 data: 前缀 —— 这就是 400 的那一刀', () => {
    expect(toAttachmentData({ mediaType: 'image/png', data: 'AAAB' }))
      .toBe('data:image/png;base64,AAAB');
  });

  it('保留原 mediaType, 不一律当 png', () => {
    expect(toAttachmentData({ mediaType: 'image/jpeg', data: 'XYZ' }))
      .toBe('data:image/jpeg;base64,XYZ');
  });

  it('已经是 dataURL 的不套第二层', () => {
    expect(toAttachmentData({ mediaType: 'image/png', data: 'data:image/png;base64,AAAB' }))
      .toBe('data:image/png;base64,AAAB');
  });

  it('拆包 → 装回 是恒等的 (round-trip)', () => {
    const original = 'data:image/webp;base64,QQ==';
    const [split] = collectInjectImages([{ type: 'image', data: original }]);
    expect(toAttachmentData(split)).toBe(original);
  });
});
