import { describe, it, expect } from 'vitest';
import {
  orderSlidePaths, extractSlideText, extractNotesText, notesPathFromSlideRels, replaceTextInSlideXml, readDeck, slidesToMarkdown,
} from '../pptxText.js';

const SLIDE = `<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>核心数据</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:txBody><a:bodyPr/><a:p><a:pPr lvl="0"/><a:r><a:t>本季度营收 </a:t></a:r><a:r><a:rPr b="1"><a:solidFill><a:srgbClr val="C00000"/></a:solidFill></a:rPr><a:t>1,280</a:t></a:r><a:r><a:t> 万元，同比增长 18%</a:t></a:r></a:p>
<a:p><a:r><a:t>新签客户 36 家</a:t></a:r><a:br/><a:r><a:t>R&amp;D 投入</a:t></a:r></a:p><a:p><a:endParaRPr/></a:p></p:txBody></p:sp>
<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>区域</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>营收</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
<a:tr><a:tc><a:txBody><a:p><a:r><a:t>华东</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>620</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>
</p:spTree></p:cSld></p:sld>`;

describe('结构', () => {
  it('按 sldIdLst 顺序而不是文件名排', () => {
    const pres = '<p:presentation><p:sldIdLst><p:sldId id="257" r:id="rId9"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>';
    const rels = '<Relationships><Relationship Id="rId2" Type="x/slide" Target="slides/slide1.xml"/><Relationship Id="rId9" Type="x/slide" Target="slides/slide2.xml"/></Relationships>';
    expect(orderSlidePaths(pres, rels)).toEqual(['ppt/slides/slide2.xml', 'ppt/slides/slide1.xml']);
  });

  it('标题 / 正文 (跨 run 拼起来, a:br 换行, 转义还原) / 表格分开', () => {
    const t = extractSlideText(SLIDE);
    expect(t.title).toBe('核心数据');
    expect(t.paragraphs).toEqual(['本季度营收 1,280 万元，同比增长 18%', '新签客户 36 家\nR&D 投入']);
    expect(t.tables).toEqual([[['区域', '营收'], ['华东', '620']]]);
  });

  it('备注只取正文占位; 备注路径从 slide rels 解', () => {
    const notes = '<p:notes><p:sp><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:sp><p:sp><p:nvPr><p:ph type="body" idx="1"/></p:nvPr><p:txBody><a:p><a:r><a:t>强调历史新高</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvPr><p:ph type="sldNum"/></p:nvPr><p:txBody><a:p><a:r><a:t>2</a:t></a:r></a:p></p:txBody></p:sp></p:notes>';
    expect(extractNotesText(notes)).toEqual(['强调历史新高']);
    expect(notesPathFromSlideRels('<Relationships><Relationship Id="rId3" Type="http://x/notesSlide" Target="../notesSlides/notesSlide2.xml"/></Relationships>')).toBe('ppt/notesSlides/notesSlide2.xml');
  });
});

describe('replaceTextInSlideXml', () => {
  it('单 run 内替换, 格式不动', () => {
    const r = replaceTextInSlideXml(SLIDE, '1,280', '1,350');
    expect(r.count).toBe(1);
    expect(r.xml).toContain('<a:rPr b="1"><a:solidFill><a:srgbClr val="C00000"/></a:solidFill></a:rPr><a:t>1,350</a:t>');
  });

  it('跨 run 的整句: 只换真正不同的那截, 加粗标红的数字还是加粗标红', () => {
    const r = replaceTextInSlideXml(SLIDE, '营收 1,280 万元', '营收 1,350 万元');
    expect(r.count).toBe(1);
    expect(extractSlideText(r.xml).paragraphs[0]).toBe('本季度营收 1,350 万元，同比增长 18%');
    expect(r.xml).toContain('<a:t>本季度营收 </a:t>');
    expect(r.xml).toContain('<a:srgbClr val="C00000"/></a:solidFill></a:rPr><a:t>1,350</a:t>');
    expect(r.xml).toContain('<a:t> 万元，同比增长 18%</a:t>');
  });

  it('差异本身跨 run 时: 差异起点所在的 run 接住新字, 后面被跨过的字删掉 (只保留公共后缀)', () => {
    /* 公共后缀只有 "0 万元", 差异 "营收 1,28" → "收入 2,00" 从普通 run 起、跨进加粗 run —— 新字进普通 run,
     * 加粗 run 只剩没被跨过的 "0"。整句文字一定对; 格式按"差异起点"归属, 确定可预期。 */
    const r = replaceTextInSlideXml(SLIDE, '营收 1,280 万元', '收入 2,000 万元');
    expect(extractSlideText(r.xml).paragraphs[0]).toBe('本季度收入 2,000 万元，同比增长 18%');
    expect(r.xml).toContain('<a:t>本季度收入 2,00</a:t>');
    expect(r.xml).toContain('<a:srgbClr val="C00000"/></a:solidFill></a:rPr><a:t>0</a:t>');
  });

  it('纯插入 / 纯删除', () => {
    const xml = '<a:p><a:r><a:t>AB</a:t></a:r><a:r><a:t>CD</a:t></a:r></a:p>';
    expect(replaceTextInSlideXml(xml, 'BC', 'BxC').xml).toBe('<a:p><a:r><a:t>ABx</a:t></a:r><a:r><a:t>CD</a:t></a:r></a:p>');
    expect(replaceTextInSlideXml(xml, 'BC', 'B').xml).toBe('<a:p><a:r><a:t>AB</a:t></a:r><a:r><a:t>D</a:t></a:r></a:p>');
  });

  it('同段多处 / 替换里含 find 不会死循环 / 转义', () => {
    const xml = '<a:p><a:r><a:t>Q2 与 Q2</a:t></a:r></a:p>';
    expect(replaceTextInSlideXml(xml, 'Q2', 'Q2Q3')).toEqual({ xml: '<a:p><a:r><a:t>Q2Q3 与 Q2Q3</a:t></a:r></a:p>', count: 2 });
    expect(replaceTextInSlideXml(SLIDE, 'R&D', 'R&D<研发>').xml).toContain('R&amp;D&lt;研发&gt; 投入');
    expect(replaceTextInSlideXml(SLIDE, '不存在', 'x').count).toBe(0);
  });

  it('不碰 <a:pPr> 这类同前缀标签; 表格里也能换', () => {
    const r = replaceTextInSlideXml(SLIDE, '华东', '华东区');
    expect(r.count).toBe(1);
    expect(r.xml).toContain('<a:pPr lvl="0"/>');
    expect(extractSlideText(r.xml).tables[0][1][0]).toBe('华东区');
  });
});

describe('readDeck + markdown', () => {
  it('按顺序读 + 渲染', async () => {
    const files: Record<string, string> = {
      'ppt/presentation.xml': '<p:sldIdLst><p:sldId r:id="rId2"/></p:sldIdLst>',
      'ppt/_rels/presentation.xml.rels': '<Relationship Id="rId2" Target="slides/slide1.xml"/>',
      'ppt/slides/slide1.xml': SLIDE,
    };
    const deck = await readDeck(async (p) => files[p] ?? null);
    expect(deck).toHaveLength(1);
    const md = slidesToMarkdown(deck);
    expect(md).toContain('## 第 1 页 · 核心数据');
    expect(md).toContain('- 本季度营收 1,280 万元，同比增长 18%');
    expect(md).toContain('| 区域 | 营收 |');
    await expect(readDeck(async () => null)).rejects.toThrow(/不是 .pptx/);
  });
});
