/**
 * word_create 的表格 / 图片 / 超链接
 * ═══════════════════════════════════════════════════════════════════════════
 * 调研报告 (research/report.ts) 产出的正是 markdown 表格 + `[S3](https://…)` 引用 + 配图,
 * 而这三样恰好是老版本整行 escapeXml 之后变成字面文本的三种。
 *
 * 最容易静默错的是**图片位置**: insertImage 按段落编号定位, 而编号用的 W_P_RE
 * 把表格单元格里的段落和表尾那个自闭合 `<w:p/>` 都算进去。数错一个图就插到别处,
 * 而且不报任何错 —— 所以这里专门锁一条"图片落在正确段落之后"。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { wordCreateTool } from '../wordCreateTool.js';

/** 1×1 的合法 PNG */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-wordcreate-'));
  fs.writeFileSync(path.join(dir, 'chart.png'), PNG_1X1);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const run = async (content: string, name = 'out.docx') =>
  JSON.parse(String(await (wordCreateTool.function as any)({
    save_path: path.join(dir, name), content, title: '调研报告', overwrite: true,
  })));

const openDocx = async (file: string) => {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  return {
    doc: await zip.file('word/document.xml')!.async('string'),
    rels: await zip.file('word/_rels/document.xml.rels')!.async('string'),
    types: await zip.file('[Content_Types].xml')!.async('string'),
    /* JSZip 的 files 里连目录条目 (`word/media/`) 也算一项, 过滤掉才是真文件数 */
    media: Object.keys(zip.files).filter((f) => f.startsWith('word/media/') && !f.endsWith('/')),
  };
};

describe('表格', () => {
  it('markdown 表格变成真 Word 表格, 分隔行不进数据', async () => {
    const out = await run([
      '# 来源',
      '',
      '| # | 站点 | 性质 |',
      '|---|------|------|',
      '| S1 | docs.adyen.com | 厂商 |',
      '| S2 | blog.example.com | 二手 |',
    ].join('\n'));

    expect(out.ok).toBe(true);
    expect(out.tables).toBe(1);
    const { doc } = await openDocx(out.file_path);
    expect(doc).toContain('<w:tbl>');
    expect(doc).toContain('docs.adyen.com');
    /* 分隔行只是画线, 不该变成一行数据 */
    expect(doc).not.toContain('---');
  });
});

describe('超链接', () => {
  it('[文字](http…) 变成真可点链接, 且 TargetMode=External', async () => {
    const out = await run('结论见 [S1](https://docs.adyen.com/webhooks) 的原文。');
    expect(out.links).toBe(1);

    const { doc, rels } = await openDocx(out.file_path);
    expect(doc).toContain('<w:hyperlink r:id=');
    expect(doc).toContain('S1');
    /* 少了 TargetMode="External", Word 会把 URL 当包内部件去找并报"无法读取的内容" */
    expect(rels).toContain('TargetMode="External"');
    expect(rels).toContain('docs.adyen.com/webhooks');
    /* 没有 styles.xml, 所以必须是直接格式而不是 rStyle */
    expect(doc).not.toContain('rStyle');
  });

  it('只有超链接没有图片时, 根上也得有 xmlns:r —— 否则 Word 报文件损坏', async () => {
    const out = await run('见 [来源](https://example.com/a)。');
    const { doc } = await openDocx(out.file_path);
    expect(doc).toContain('xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"');
  });

  it('同一个 URL 出现多次只登记一条关系', async () => {
    const out = await run('[a](https://x.dev/p) 和 [b](https://x.dev/p) 指同一处。');
    expect(out.links).toBe(1);
  });

  it('非 http 协议原样留字面, 不塞给 Word 一个打不开的目标', async () => {
    const out = await run('[本地](file:///etc/passwd)');
    expect(out.links).toBe(0);
    const { doc } = await openDocx(out.file_path);
    expect(doc).not.toContain('<w:hyperlink');
  });
});

describe('图片', () => {
  it('![caption](path) 真嵌进 media, 带 caption', async () => {
    const out = await run(['# 标题', '', '![安装耗时对比](chart.png)'].join('\n'));
    expect(out.images).toBe(1);

    const { doc, rels, types, media } = await openDocx(out.file_path);
    expect(media).toHaveLength(1);
    expect(rels).toContain('/image');
    expect(types).toContain('png');
    expect(doc).toContain('安装耗时对比');
  });

  it('⭐️ 表格之后的图片落在正确位置 —— 表格单元格里的段落也算编号', async () => {
    const out = await run([
      '第一段',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '![图](chart.png)',
      '',
      '最后一段',
    ].join('\n'));
    expect(out.images).toBe(1);

    const { doc } = await openDocx(out.file_path);
    /* 图片必须在表格之后、"最后一段"之前 */
    const tblAt = doc.indexOf('<w:tbl>');
    const imgAt = doc.indexOf('<w:drawing>');
    const lastAt = doc.indexOf('最后一段');
    expect(tblAt).toBeGreaterThan(-1);
    expect(imgAt).toBeGreaterThan(tblAt);
    expect(imgAt).toBeLessThan(lastAt);
  });

  it('多张图按文档顺序排, 不因倒序插入而颠倒', async () => {
    fs.writeFileSync(path.join(dir, 'b.png'), PNG_1X1);
    const out = await run(['![第一张](chart.png)', '', '中间', '', '![第二张](b.png)'].join('\n'));
    expect(out.images).toBe(2);
    const { doc } = await openDocx(out.file_path);
    expect(doc.indexOf('第一张')).toBeLessThan(doc.indexOf('第二张'));
  });

  it('读不到的图片只记 warning, 不毁掉整份文档', async () => {
    const out = await run(['正文', '', '![缺的](nope.png)'].join('\n'));
    expect(out.ok).toBe(true);
    expect(out.images).toBe(0);
    expect(String(out.warnings?.[0] ?? '')).toContain('nope.png');
    const { doc } = await openDocx(out.file_path);
    expect(doc).toContain('正文');
  });
});

describe('不回归', () => {
  it('标题和列表照旧', async () => {
    const out = await run(['# 一级', '## 二级', '- 条目一', '- 条目二'].join('\n'));
    const { doc } = await openDocx(out.file_path);
    expect(doc).toContain('一级');
    expect(doc).toContain('• 条目一');
    expect(out.tables).toBe(0);
    expect(out.images).toBe(0);
  });
});
