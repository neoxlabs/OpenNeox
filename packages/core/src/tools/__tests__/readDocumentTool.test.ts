import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as realOs from 'os';

const home = fs.mkdtempSync(path.join(realOs.tmpdir(), 'neox-readdoc-'));
const { estimateTokens } = await import('@neoxlabs/kernel');
vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>();
  return { ...actual, homedir: () => home };
});

const { readDocumentTool } = await import('../readDocumentTool.js');
const { NEOX_HOME_DIRNAME } = await import('@neoxlabs/kernel/platform/neoxHome.js');

describe('read_document 分页', () => {
  it('长文档按页回, 带 next_offset; 顺着读完拼回原文', async () => {
    const id = 'a'.repeat(64);
    const text = Array.from({ length: 20_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
    fs.mkdirSync(path.join(home, NEOX_HOME_DIRNAME, 'documents'), { recursive: true });
    fs.writeFileSync(path.join(home, NEOX_HOME_DIRNAME, 'documents', `${id}.md`), text);

    let offset: number | undefined = 0;
    let joined = '';
    let pages = 0;
    while (offset !== undefined) {
      const r = JSON.parse(await readDocumentTool.function({ file_id: id, offset } as any));
      expect(r.status).toBe('success');
      expect(r.chars).toBe(text.length);
      joined += r.markdown;
      offset = r.next_offset;
      pages++;
    }
    expect(joined).toBe(text);
    expect(pages).toBe(3);
  });

  it('长文档首读带大纲, 大纲 + 首页仍在 8K token 内; 锚点可直接跳到章节', async () => {
    const id = 'b'.repeat(64);
    const md = ['# 摘要', ...Array.from({ length: 400 }, () => '摘要正文内容。'),
      '## 方法', ...Array.from({ length: 400 }, () => '方法正文内容。'),
      '## 结论', ...Array.from({ length: 400 }, () => '结论正文内容。')].join('\n');
    fs.mkdirSync(path.join(home, NEOX_HOME_DIRNAME, 'documents'), { recursive: true });
    fs.writeFileSync(path.join(home, NEOX_HOME_DIRNAME, 'documents', `${id}.md`), md);

    const first = JSON.parse(await readDocumentTool.function({ file_id: id } as any));
    expect(first.status).toBe('success');
    expect(Array.isArray(first.outline)).toBe(true);
    expect(first.outline.length).toBeGreaterThanOrEqual(2);
    expect(first.outline[0].anchor).toMatch(/^#c\d+/);
    expect(estimateTokens(JSON.stringify(first))).toBeLessThanOrEqual(8000);

    /* 大纲里的「方法」锚点能够跳到对应位置 */
    const method = first.outline.find((entry: any) => entry.heading.includes('方法'));
    expect(method).toBeTruthy();
    const jumped = JSON.parse(await readDocumentTool.function({ file_id: id, anchor: method.anchor } as any));
    expect(jumped.status).toBe('success');
    expect(jumped.offset).toBe(Number(method.anchor.replace(/^#c/, '').split('-')[0]));
    expect(jumped.markdown).toContain('方法');
    expect(jumped.outline).toBeUndefined();
  });
});
