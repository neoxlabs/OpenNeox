import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { Presentation } from '../../builder/index.js';
import { exportPptx } from '../index.js';

async function unzip(ppt: Presentation): Promise<JSZip> {
  const file = await exportPptx(ppt as never);
  return JSZip.loadAsync((file as unknown as { bytes(): Uint8Array }).bytes());
}

describe('讲稿 (speaker notes)', () => {
  it('有讲稿的页写出 notesSlide, 并在 rels / content types / presentation 里登记', async () => {
    const ppt = Presentation.create({ slideSize: { width: 1280, height: 720 } });
    ppt.slides.add().notes = '开场白\n第二行 <&>';
    ppt.slides.add();
    const zip = await unzip(ppt);

    const notes1 = await zip.file('ppt/notesSlides/notesSlide1.xml')!.async('string');
    expect(notes1).toContain('开场白');
    expect(notes1).toContain('第二行 &lt;&amp;&gt;');
    expect(zip.file('ppt/notesSlides/notesSlide2.xml')).toBeNull();
    expect(zip.file('ppt/notesMasters/notesMaster1.xml')).not.toBeNull();

    expect(await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')).toContain('notesSlides/notesSlide1.xml');
    expect(await zip.file('ppt/slides/_rels/slide2.xml.rels')!.async('string')).not.toContain('notesSlide');
    const types = await zip.file('[Content_Types].xml')!.async('string');
    expect(types).toContain('/ppt/notesSlides/notesSlide1.xml');
    expect(types).toContain('/ppt/notesMasters/notesMaster1.xml');
    expect(await zip.file('ppt/presentation.xml')!.async('string')).toContain('notesMasterIdLst');
    expect(await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')).toContain('notesMasters/notesMaster1.xml');
  });

  it('整份没有讲稿时不多写任何 notes 部件', async () => {
    const ppt = Presentation.create({ slideSize: { width: 1280, height: 720 } });
    ppt.slides.add();
    const zip = await unzip(ppt);
    expect(Object.keys(zip.files).some((f) => f.includes('notes'))).toBe(false);
    expect(await zip.file('ppt/presentation.xml')!.async('string')).not.toContain('notesMasterIdLst');
  });
});
