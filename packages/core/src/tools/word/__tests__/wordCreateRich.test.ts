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
import { wordCreateTool, zhPunct } from '../wordCreateTool.js';

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

describe('加粗', () => {
  it('**加粗** 变成真粗体 run, 星号不进正文 (10-15 QA: 周报里「**汇报人：**」原样进了 Word)', async () => {
    const out = await run('**汇报人：** 李明\n1. **客户拜访：** 完成 3 家\n\n| 项 | **值** |\n|---|---|\n| a | **1** |');
    const { doc } = await openDocx(out.file_path ?? path.join(dir, 'out.docx'));
    expect(doc).not.toContain('**');
    expect(doc).toMatch(/<w:r><w:rPr><w:b\/>[^]*?<w:t xml:space="preserve">汇报人：<\/w:t>/);
    expect(doc).toContain('李明');
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
    /* 10-21 起是真 Word 项目符号 (numbering.xml), 不再写字面「•」 */
    expect(doc).toMatch(/<w:numId w:val="1"\/><\/w:numPr><\/w:pPr><w:r><w:t xml:space="preserve">条目一/);
    expect(out.tables).toBe(0);
    expect(out.images).toBe(0);
  });
});

describe('中文标点 (10-21)', () => {
  it('紧跟汉字的半角 , : ; 转全角, 时间 / 链接 / 英文不动', () => {
    expect(zhPunct('材料准备:身份证,学历')).toBe('材料准备：身份证，学历');
    expect(zhPunct('报到时间 9:30,地点')).toBe('报到时间 9:30，地点');
    expect(zhPunct('见附件(联系人表)')).toBe('见附件（联系人表）');
    expect(zhPunct('[官网](https://a.com/中文)')).toBe('[官网](https://a.com/中文)');
    expect(zhPunct('Hello, world: ok')).toBe('Hello, world: ok');
  });
});

describe('版式 (10-21)', () => {
  const runP = async (content: string, extra: Record<string, unknown>) =>
    JSON.parse(String(await (wordCreateTool.function as any)({ save_path: path.join(dir, 'p.docx'), content, overwrite: true, ...extra })));
  const part = async (file: string, name: string) => (await JSZip.loadAsync(fs.readFileSync(file))).file(name)?.async('string');

  it('第一行 # 变大标题, 其余标题升一级; 样式表 / 编号 / 设置 / 页脚都在, 关系与类型都登记', async () => {
    const out = await runP('# 年度总结\n## 一、工作回顾\n### （一）业务\n正文', {});
    expect(out.preset).toBe('report');
    const doc = (await part(out.file_path, 'word/document.xml'))!;
    expect(doc).toContain('<w:pStyle w:val="Title"/>');
    expect(doc).toMatch(/Heading1"\/><\/w:pPr>[^]*?一、工作回顾/);
    expect(doc).toMatch(/Heading2"\/><\/w:pPr>[^]*?（一）业务/);
    for (const p of ['styles.xml', 'numbering.xml', 'settings.xml', 'footer1.xml']) {
      expect(await part(out.file_path, `word/${p}`)).toBeTruthy();
      expect(await part(out.file_path, '[Content_Types].xml')).toContain(`/word/${p}`);
    }
    expect(await part(out.file_path, 'word/styles.xml')).toContain('w:eastAsia="宋体"');
    expect(await part(out.file_path, 'word/footer1.xml')).toContain('NUMPAGES');
  });

  it('公文: 仿宋三号正文、固定行距、单双页页码分左右', async () => {
    const out = await runP('# 关于开展安全检查的通知\n各部门：\n## 一、检查范围\n全部门\n[right]办公室\n[right]2026年10月21日', { preset: 'gov' });
    const styles = (await part(out.file_path, 'word/styles.xml'))!;
    expect(styles).toContain('仿宋_GB2312');
    expect(styles).toContain('w:line="579" w:lineRule="exact"');
    expect(await part(out.file_path, 'word/footer2.xml')).toContain('w:val="left"');
    expect(await part(out.file_path, 'word/settings.xml')).toContain('evenAndOddHeaders');
    expect(await part(out.file_path, 'word/document.xml')).toContain('<w:jc w:val="right"/>');
  });

  it('toc: 目录条目 + 书签 + updateFields; 标题太少不出目录', async () => {
    const out = await runP('# 论文\n## 绪论\n## 方法\n## 结论', { preset: 'academic' });
    const doc = (await part(out.file_path, 'word/document.xml'))!;
    expect(doc).toContain('TOC \\o "1-3"');
    expect(doc).toContain('w:name="_Toc_nx_1"');
    expect(await part(out.file_path, 'word/settings.xml')).toContain('updateFields');
    const few = await runP('# 短文\n## 只有一节', { toc: true });
    expect(await part(few.file_path, 'word/document.xml')).not.toContain('TOC \\o');
  });

  it('页眉 / 分页 / 引用 / 编号段; 没有的版式退回 report', async () => {
    const out = await runP('# 手册\n> 注意事项\n1. 第一步\n\\newpage\n第二页', { header: 'Neox 公司', preset: 'nope' });
    expect(out.preset).toBe('report');
    const doc = (await part(out.file_path, 'word/document.xml'))!;
    expect(doc).toContain('<w:pStyle w:val="Quote"/>');
    expect(doc).toContain('<w:br w:type="page"/>');
    expect(doc).toContain('<w:p><w:r><w:t xml:space="preserve">1. 第一步');
    expect(await part(out.file_path, 'word/header1.xml')).toContain('Neox 公司');
  });
});
