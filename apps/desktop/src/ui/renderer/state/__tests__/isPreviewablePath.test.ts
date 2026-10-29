
import { describe, it, expect } from 'vitest';
import { isPreviewablePath } from '../openSurfaceFromPath';

describe('isPreviewablePath · 该点得开的', () => {
  it('常见相对路径', () => {
    for (const p of ['src/a.ts', 'packages/core/src/index.tsx', './a/b.py', 'a/b/c.go']) {
      expect(isPreviewablePath(p), p).toBe(true);
    }
  });

  it('绝对路径与 Windows 路径', () => {
    expect(isPreviewablePath('/Users/x/repo/a.ts')).toBe(true);
    expect(isPreviewablePath('C:\\repo\\a.ts')).toBe(true);
  });

  it('文档 / 表格 / 演示 / 图片类', () => {
    for (const p of ['docs/a.md', 'data/b.csv', 'sheet/c.xlsx', 'deck/d.pptx',
                     'report/e.pdf', 'img/f.png', 'doc/g.docx']) {
      expect(isPreviewablePath(p), p).toBe(true);
    }
  });

  it('纯文本类 —— 2026-05-25 修过的回归 (当时点击无反应)', () => {
    for (const p of ['logs/app.log', 'notes/a.txt']) {
      expect(isPreviewablePath(p), p).toBe(true);
    }
  });

  it('单文件名形态 (无斜杠) 在合理长度内也放行', () => {
    expect(isPreviewablePath('main.ts')).toBe(true);
    expect(isPreviewablePath('README.md')).toBe(true);
  });
});

describe('isPreviewablePath · 该拦住的', () => {
  it('空 / 超长', () => {
    expect(isPreviewablePath('')).toBe(false);
    expect(isPreviewablePath('a/'.repeat(200) + 'x.ts')).toBe(false);
  });

  it('含空格的不是路径 (多半是句子)', () => {
    expect(isPreviewablePath('src/a b.ts')).toBe(false);
    expect(isPreviewablePath('改了 src/a.ts')).toBe(false);
    expect(isPreviewablePath('python make_report.py --out a.xlsx')).toBe(false);
    expect(isPreviewablePath('npm run build && open dist/a.pdf')).toBe(false);
  });

  it('交给人看的成品文件名带空格照样是文件 (2026-10-04: Work 交付的 docx 不能点)', () => {
    expect(isPreviewablePath('Attention Is All You Need 论文中文翻译.docx')).toBe(true);
    expect(isPreviewablePath('Q3 Sales Report.xlsx')).toBe(true);
    expect(isPreviewablePath('/Users/x/Desktop/期中 成绩 对比.png')).toBe(true);
    expect(isPreviewablePath(`${'课'.repeat(80)}.pptx`)).toBe(true);
  });

  it('URL 不走文件 surface', () => {
    expect(isPreviewablePath('https://example.com/a.ts')).toBe(false);
    expect(isPreviewablePath('http://x/y.md')).toBe(false);
  });

  it('省略号路径 —— agent 写的 backend/.../Foo.java 必然 stat 失败', () => {
    expect(isPreviewablePath('backend/.../dal/mysql/Foo.java')).toBe(false);
    expect(isPreviewablePath('src/…/a.ts')).toBe(false);
  });

  it('没有扩展名的不放行', () => {
    expect(isPreviewablePath('src/components')).toBe(false);
    expect(isPreviewablePath('/usr/local/bin')).toBe(false);
  });

  it('未登记的扩展名不放行 —— 开出来也没有 viewer', () => {
    for (const p of ['a/b.exe', 'a/b.zip', 'a/b.bin', 'a/b.avi']) {
      expect(isPreviewablePath(p), p).toBe(false);
    }
  });

  it('只有扩展名不算文件 —— 「用 `.svg` 插入课件」说的是格式', () => {
    for (const p of ['.svg', '.png', '.pptx', '.xlsx']) {
      expect(isPreviewablePath(p), p).toBe(false);
    }
    expect(isPreviewablePath('示意图.svg')).toBe(true);
  });

  it('视频有右栏播放器了 (2026-10-03) —— mp4 / mov / webm 可点开', () => {
    for (const p of ['a/b.mp4', 'a/b.mov', 'a/b.webm']) {
      expect(isPreviewablePath(p), p).toBe(true);
    }
  });

  it('单文件名形态过短 / 过长都拒绝 (避免把普通词误认成文件)', () => {
    expect(isPreviewablePath('a.ts')).toBe(true);      /* 4 字, 边界内 */
    expect(isPreviewablePath('x.c')).toBe(false);      /* 3 字, 太短 */
    expect(isPreviewablePath(`${'n'.repeat(70)}.ts`)).toBe(false);
  });

  it('版本号 / 普通句子里的点不被误认', () => {
    expect(isPreviewablePath('v1.2.3')).toBe(false);
    expect(isPreviewablePath('etc.')).toBe(false);
  });

  it('带 query 的仍然拒绝, 但**行号锚点已改成接受** (2026-08-29 #56)', () => {
    /* query: extOf 切后取最后一段 'raw=1' → 无扩展名 → 拒。对这个用途拒绝是安全方向,
     * 聊天里的文件路径极少带 query, 放行的话点开会拿着带 query 的串去 fs.stat 必然失败。 */
    expect(isPreviewablePath('src/a.ts?raw=1')).toBe(false);

    expect(isPreviewablePath('src/a.ts#L10')).toBe(true);
    expect(isPreviewablePath('src/a.ts:42')).toBe(true);
  });

  it('大小写扩展名同样认', () => {
    expect(isPreviewablePath('src/A.TS')).toBe(true);
    expect(isPreviewablePath('docs/B.MD')).toBe(true);
  });
});
