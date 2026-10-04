import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as realOs from 'os';

const home = fs.mkdtempSync(path.join(realOs.tmpdir(), 'neox-readdoc-'));
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
});
