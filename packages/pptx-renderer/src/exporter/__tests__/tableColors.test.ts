import { describe, expect, it } from 'vitest';
import { Presentation } from '../../builder/index.js';
import { exportPptx } from '../index.js';

async function slideXml(build: (ppt: Presentation) => void): Promise<string> {
  const ppt = Presentation.create({ slideSize: { width: 1280, height: 720 } });
  build(ppt);
  const file = await exportPptx(ppt as never);
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync((file as unknown as { bytes(): Uint8Array }).bytes());
  return zip.file('ppt/slides/slide1.xml')!.async('string');
}

const HEADER = ['厂区', '产线'];

function addTable(ppt: Presentation, extra: Record<string, unknown>) {
  ppt.slides.add().tables.add({
    position: { left: 72, top: 200, width: 800, height: 200 },
    headers: HEADER,
    rows: [['华东', '5']],
    ...extra,
  } as never);
}

describe('表格字色', () => {
  it('不传 headerColor / bodyColor 时保持老行为 (表头白字)', async () => {
    const xml = await slideXml((ppt) => addTable(ppt, {}));
    expect(xml.toUpperCase()).toContain('FFFFFF');
    /* 正文默认墨色仍存在 */
    expect(xml.toUpperCase()).toContain('1D2A2F');
  });

  it('传 headerColor 时表头用这个颜色, 不再写死白色', async () => {
    const xml = await slideXml((ppt) => addTable(ppt, { headerColor: '0A1018' }));
    expect(xml.toUpperCase()).toContain('0A1018');
    /* 表头 run 不再是白字 */
    const headerPart = xml.slice(xml.indexOf('厂区'), xml.indexOf('厂区') + 600);
    expect(headerPart.toUpperCase()).not.toContain('FFFFFF');
  });

  it('传 bodyColor 时正文 run 用这个颜色', async () => {
    const xml = await slideXml((ppt) => addTable(ppt, { bodyColor: 'E8F0FA' }));
    expect(xml.toUpperCase()).toContain('E8F0FA');
  });

  it('单元格自己指定的 color 优先于全局参数', async () => {
    const xml = await slideXml((ppt) => {
      ppt.slides.add().tables.add({
        position: { left: 72, top: 200, width: 800, height: 200 },
        headers: HEADER,
        rows: [[
          { paragraphs: [{ runs: [{ text: '华东', style: { color: '#FF00AA' } }] }] },
          '5',
        ]],
        headerColor: '0A1018',
        bodyColor: 'E8F0FA',
      } as never);
    });
    expect(xml.toUpperCase()).toContain('FF00AA');
  });
});
