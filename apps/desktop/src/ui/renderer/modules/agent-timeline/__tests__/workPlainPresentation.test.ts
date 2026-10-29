import { describe, it, expect } from 'vitest';
import { plainWorkTitle, plainWorkContent, isProcessScript, isPlainInternalTitle, plainInternalKind, plainChangeFromOutput } from '../workPlainPresentation';

describe('plainWorkTitle', () => {
  it('表格工具说"在干什么事", 不说工具名', () => {
    expect(plainWorkTitle('sheet_new_workbook', { name: '周报.xlsx' }, true)).toBe('新建表格「周报」');
    expect(plainWorkTitle('sheet_get_range', {}, true)).toBe('核对表格');
    expect(plainWorkTitle('sheet_export_file', { save_path: '/a/b/周报.xlsx' }, true)).toBe('保存表格「周报」');
  });

  it('文档修改标题带上是哪份文档 (用户: 「不知道编写什么文档的」)', () => {
    expect(plainWorkTitle('word_replace_text', { file_path: '/w/运营周报_W38.docx' }, true)).toBe('修改文档「运营周报_W38」');
    expect(plainWorkTitle('word_get_paragraphs', { file_path: 'x/运营周报.docx' }, true)).toBe('查看文档「运营周报」');
  });

  it('过程脚本不报文件名 —— 报了老板也看不懂', () => {
    expect(plainWorkTitle('write_file', { path: '/tmp/make_ppt.py' }, true)).toBe('准备处理步骤');
    expect(plainWorkTitle('write_file', { path: '/w/方案.md' }, true)).toBe('写好「方案.md」');
  });

  it('命令一律不露命令原文', () => {
    const t = plainWorkTitle('execute_shell', { command: 'python3 make.py --out x' }, true) ?? '';
    expect(t).not.toMatch(/python|make\.py/);
  });

  it('没有白话写法的工具交回原逻辑', () => {
    expect(plainWorkTitle('gcal_list_events', {}, true)).toBeUndefined();
  });
});

describe('plainWorkContent', () => {
  it('技术步骤成功 → 不可展开的一行', () => {
    expect(plainWorkContent('execute_shell', {}, false, true)).toEqual({ type: 'none' });
    expect(plainWorkContent('edit', {}, false, true)).toEqual({ type: 'none' });
    expect(plainWorkContent('sheet_write_range', {}, false, true)).toEqual({ type: 'none' });
  });

  it('失败只说"换个办法", 不贴报错', () => {
    const c = plainWorkContent('execute_shell', {}, true, true);
    expect(c && c.type === 'log' && c.message).toBe('这一步没成功, 正在换个办法');
  });

  it('搜索结果 / 图片等非技术内容不拦', () => {
    expect(plainWorkContent('web_search', {}, false, true)).toBeUndefined();
    expect(plainWorkContent('generate_image', {}, false, true)).toBeUndefined();
  });

  it('文档修改 → 「改了什么」卡, 原文 → 新内容', () => {
    expect(plainWorkContent('word_replace_text', { file_path: 'a.docx', find: '3,180', replace: '2,750' }, false, true))
      .toEqual({ type: 'change', items: [{ before: '3,180', after: '2,750' }] });
    const del = plainWorkContent('word_delete_paragraph', { file_path: 'a.docx', index: 4 }, false, true);
    expect(del).toEqual({ type: 'change', items: [{ label: '删掉第 5 段' }] });
    const cell = plainWorkContent('word_set_cell', { file_path: 'a.docx', table_index: 0, row: 2, col: 1, text: '27.4' }, false, true);
    expect(cell).toEqual({ type: 'change', items: [{ label: '表格 1 · 第 3 行第 2 列', after: '27.4' }] });
  });

  it('表格公式不露原文, 只说在算什么', () => {
    const c = plainWorkContent('sheet_set_cells', {
      file_path: 'a.xlsx',
      cells: [{ cell: 'C9', formula: '=SUM(C2:C8)' }, { cell: 'B3', value: '1280' }],
    }, false, true);
    expect(c).toEqual({ type: 'change', items: [{ label: 'C9', after: '自动求和' }, { label: 'B3', after: '1280' }] });
    expect(JSON.stringify(c)).not.toContain('SUM');
  });

  it('改动多于 6 处只列前 6 处, 其余报个数', () => {
    const cells = Array.from({ length: 9 }, (_, i) => ({ cell: `A${i + 1}`, value: String(i) }));
    const c = plainWorkContent('sheet_set_cells', { file_path: 'a.xlsx', cells }, false, true);
    expect(c && c.type === 'change' && c.items.length).toBe(6);
    expect(c && c.type === 'change' && c.more).toBe(3);
  });

  it('内部步骤的标题能被认出来 (展开列表藏它们), 交付物不会被误认', () => {
    for (const k of ['execute_shell', 'grep', 'list_directory']) {
      expect(isPlainInternalTitle(plainWorkTitle(k, { pattern: '本周概览' }, true) ?? '')).toBe(true);
      expect(isPlainInternalTitle(plainWorkTitle(k, { pattern: 'x' }, false) ?? '')).toBe(true);
    }
    expect(isPlainInternalTitle(plainWorkTitle('write_file', { path: '/tmp/a.py' }, true) ?? '')).toBe(true);
    expect(isPlainInternalTitle(plainWorkTitle('write_file', { path: '/w/方案.md' }, true) ?? '')).toBe(false);
    expect(isPlainInternalTitle(plainWorkTitle('word_replace_text', { file_path: 'a.docx' }, true) ?? '')).toBe(false);
  });

  it('isProcessScript 只认脚本, 不认交付物', () => {
    expect(isProcessScript('a.py')).toBe(true);
    expect(isProcessScript('a.xlsx')).toBe(false);
    expect(isProcessScript('a.md')).toBe(false);
  });
});

describe('2026-09-23 实拍补丁', () => {
  it('在右侧打开要说是哪个文件 —— 一轮开两次不再是两行一样的话', () => {
    expect(plainWorkTitle('open_surface', { kind: 'sheet', source: '/x/咖啡店营业额.xlsx' }, true)).toBe('在右侧打开「咖啡店营业额」');
    expect(plainWorkTitle('open_surface', { title: '三季度简报' }, true)).toBe('在右侧打开「三季度简报」');
    expect(plainWorkTitle('open_surface', {}, true)).toBe('在右侧打开给你看');
  });
  it('藏起来的内部步骤按类归: 处理数据 / 翻看文件 —— 整轮收尾那一行按类报数', () => {
    expect(plainInternalKind('处理中的一步')).toBe('process');
    expect(plainInternalKind('准备处理步骤')).toBe('process');
    expect(plainInternalKind('翻看文件夹')).toBe('browse');
    expect(plainInternalKind('在文件里找「营业额」')).toBe('browse');
    expect(plainInternalKind('新建表格「周报」')).toBeUndefined();
  });
  it('公式写在 value 里也不露原文', () => {
    const c = plainWorkContent('sheet_set_cells', { cells: [{ cell: 'D2', value: '=B2-C2' }, { cell: 'D5', value: '=SUM(D2:D4)' }] }, false, true) as any;
    expect(c.items.map((i: any) => i.after)).toEqual(['自动计算', '自动求和']);
  });
});

/* work:Q-10 —— 改稿卡用工具结果里的真实前后对照, 不是参数 */
describe('plainChangeFromOutput', () => {
  const out = (obj: unknown) => JSON.stringify(obj);

  it('word_edit_paragraph 的结果带 changes → 原文和改后都显示', () => {
    const c = plainChangeFromOutput('word_edit_paragraph', out({
      ok: true, file_path: '/w/周报.docx', index: 3, new_text: '本周营收 120 万',
      changes: [{ index: 3, before: '本周营收 100 万', after: '本周营收 120 万' }],
    }), true) as any;
    expect(c.type).toBe('change');
    expect(c.items[0]).toMatchObject({ label: '第 4 段', before: '本周营收 100 万', after: '本周营收 120 万' });
  });

  it('删段 / 加段分开说', () => {
    const c = plainChangeFromOutput('word_delete_paragraph', out({
      ok: true, changes: [{ index: 5, before: '要删的一段', after: '' }],
    }), true) as any;
    expect(c.items[0]).toMatchObject({ label: '删掉第 6 段', before: '要删的一段' });
    const add = plainChangeFromOutput('word_insert_paragraph', out({
      ok: true, changes: [{ index: 2, before: '', after: '新增的一段' }],
    }), false) as any;
    expect(add.items[0]).toMatchObject({ label: 'Added a paragraph', after: '新增的一段' });
  });

  it('contextual 信封包过一层也能读到 (metadata / content 两种)', () => {
    const changes = [{ index: 0, before: 'A', after: 'B' }];
    expect((plainChangeFromOutput('word_replace_text', out({ tool: 'word_replace_text', status: 'ok', metadata: { changes } }), true) as any).items[0].after).toBe('B');
    expect((plainChangeFromOutput('word_replace_text', out({ tool: 'word_replace_text', status: 'ok', content: JSON.stringify({ changes }) }), true) as any).items[0].before).toBe('A');
  });

  it('没 changes / 非 word 工具 / 非 JSON → 不给卡 (退回按参数拼)', () => {
    expect(plainChangeFromOutput('word_edit_paragraph', out({ ok: true }), true)).toBeUndefined();
    expect(plainChangeFromOutput('sheet_set_cells', out({ changes: [{ index: 0, before: 'A', after: 'B' }] }), true)).toBeUndefined();
    expect(plainChangeFromOutput('word_edit_paragraph', 'not json', true)).toBeUndefined();
    expect(plainChangeFromOutput('word_edit_paragraph', undefined, true)).toBeUndefined();
  });
});
