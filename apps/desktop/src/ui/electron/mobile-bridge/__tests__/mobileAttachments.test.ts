import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { createHash } from 'crypto';
import {
  beginUpload,
  appendUploadChunk,
  finishUpload,
  resolveIncomingAttachments,
  toDesktopAttachments,
  parseFileAttachment,
  AttachmentError,
  MAX_UPLOAD_CHUNK_B64_LEN,
  __resetUploadsForTest,
} from '../mobileAttachments';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

async function makeXlsx(): Promise<Buffer> {
  const XLSX: any = await import('xlsx').then((m: any) => m.default ?? m);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['月份', '收入', '支出'],
    ['1 月', 1200, 800],
    ['2 月', 1500, 950],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, '预算');
  return Buffer.from(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}

beforeEach(() => __resetUploadsForTest());

describe('parseFileAttachment', () => {
  it('xlsx → markdown 表格 (不再是 zip 乱码)', async () => {
    const r = await parseFileAttachment('预算.xlsx', await makeXlsx());
    expect(r.channel).toBe('local-xlsx');
    expect(r.sheets).toBe(1);
    expect(r.markdown).toContain('## 预算');
    expect(r.markdown).toContain('| 月份 | 收入 | 支出 |');
    expect(r.markdown).toContain('| 2 月 | 1500 | 950 |');
  });

  it('csv / txt 直接当文本', async () => {
    const r = await parseFileAttachment('a.txt', Buffer.from('你好\n第二行', 'utf-8'));
    expect(r.markdown).toBe('你好\n第二行');
    const c = await parseFileAttachment('a.csv', Buffer.from('a,b\n1,2', 'utf-8'));
    expect(c.markdown).toContain('| a | b |');
  });

  it('二进制且不认识的扩展名 → 明确报错, 不塞乱码', async () => {
    const bin = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x10]);
    await expect(parseFileAttachment('x.bin', bin)).rejects.toBeInstanceOf(AttachmentError);
  });
});

describe('分片上传 → session.input 引用', () => {
  it('按片收, 封口后 resolve 拼回原字节并消费掉 upload_id', () => {
    const bytes = Buffer.alloc(300 * 1024, 7);
    const { upload_id } = beginUpload('dev-1', { kind: 'file', name: 'big.csv', mime: 'text/csv', size_bytes: bytes.length });
    const chunkBytes = Math.floor(MAX_UPLOAD_CHUNK_B64_LEN / 4) * 3;
    let index = 0;
    for (let off = 0; off < bytes.length; off += chunkBytes) {
      appendUploadChunk('dev-1', { upload_id, index: index++, data_base64: bytes.subarray(off, off + chunkBytes).toString('base64') });
    }
    expect(finishUpload('dev-1', { upload_id }).size_bytes).toBe(bytes.length);
    const items = resolveIncomingAttachments('dev-1', [{ kind: 'file', name: 'big.csv', upload_id }]);
    expect(items[0].bytes.equals(bytes)).toBe(true);
    expect(items[0].name).toBe('big.csv');
    /* 引用即消费: 第二次引用要报错 */
    expect(() => resolveIncomingAttachments('dev-1', [{ kind: 'file', upload_id }])).toThrow(AttachmentError);
  });

  it('别的设备拿不到我的 upload_id; 乱序片直接拒', () => {
    const { upload_id } = beginUpload('dev-1', { kind: 'image', name: 'p.jpg', mime: 'image/jpeg' });
    expect(() => appendUploadChunk('dev-2', { upload_id, index: 0, data_base64: 'AAAA' })).toThrow(AttachmentError);
    expect(() => appendUploadChunk('dev-1', { upload_id, index: 1, data_base64: 'AAAA' })).toThrow(/out of order/);
  });

  it('没封口就引用 → 报错而不是静默跳过 (跳过 = 模型收到「看一下这些附件」却啥都没有)', () => {
    const { upload_id } = beginUpload('dev-1', { kind: 'file', name: 'a.txt', mime: 'text/plain' });
    appendUploadChunk('dev-1', { upload_id, index: 0, data_base64: Buffer.from('hi').toString('base64') });
    expect(() => resolveIncomingAttachments('dev-1', [{ kind: 'file', upload_id }])).toThrow(/not finished/);
  });

  it('内联小附件照旧收', () => {
    const items = resolveIncomingAttachments('dev-1', [
      { kind: 'file', name: 'n.md', mime: 'text/markdown', data_base64: Buffer.from('# t').toString('base64') },
    ]);
    expect(items[0].bytes.toString()).toBe('# t');
  });

  it('mime 里的 / 保留 (曾被当文件名洗成 "image jpeg", 拼出的 data URL 网关不认, 整轮 400)', async () => {
    const items = resolveIncomingAttachments('dev-1', [
      { kind: 'image', name: 'camera.jpg', mime: 'image/jpeg', data_base64: Buffer.from([9, 9]).toString('base64') },
      { kind: 'image', name: 'x.jpg', mime: 'image/../../etc', data_base64: Buffer.from([1]).toString('base64') },
    ]);
    expect(items[0].mime).toBe('image/jpeg');
    expect(items[1].mime).toBe('application/octet-stream');
    const out: any[] = await toDesktopAttachments(items);
    expect(out[0].data.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(out[1].data.startsWith('data:image/jpeg;base64,')).toBe(true);
  });
});

describe('toDesktopAttachments', () => {
  const written: string[] = [];
  afterAll(() => Promise.all(written.map((p) => fs.rm(p, { force: true }))));

  it('file → 跟桌面拖文件同一形状: data 空 + fileId(sha256) + 文档缓存落盘; image → data:URL', async () => {
    const xlsx = await makeXlsx();
    written.push(path.join(os.homedir(), NEOX_HOME_DIRNAME, 'documents', `${createHash('sha256').update(xlsx).digest('hex')}.md`));
    const out = await toDesktopAttachments([
      { kind: 'file', name: '预算.xlsx', mime: 'application/octet-stream', bytes: xlsx },
      { kind: 'image', name: 'p.png', mime: 'image/png', bytes: Buffer.from([1, 2, 3]) },
    ]);
    const doc: any = out[0];
    expect(doc.type).toBe('file');
    expect(doc.data).toBe('');
    expect(doc.fileId).toBe(createHash('sha256').update(xlsx).digest('hex'));
    expect(doc.channel).toBe('local-xlsx');
    expect(doc.chars).toBeGreaterThan(20);
    const cached = await fs.readFile(path.join(os.homedir(), NEOX_HOME_DIRNAME, 'documents', `${doc.fileId}.md`), 'utf-8');
    expect(cached).toContain('| 月份 | 收入 | 支出 |');
    const img: any = out[1];
    expect(img.type).toBe('image');
    expect(img.data).toBe(`data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`);
  });

  it('有工作区: 原件存 uploads/ (重名加序号, 同内容复用), 读不出文字的格式不报错只给路径', async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-mobile-att-'));
    try {
      const xlsx = await makeXlsx();
      written.push(path.join(os.homedir(), NEOX_HOME_DIRNAME, 'documents', `${createHash('sha256').update(xlsx).digest('hex')}.md`));
      const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0xff, 0xfe]);
      const out: any[] = await toDesktopAttachments([
        { kind: 'file', name: '预算.xlsx', mime: 'application/octet-stream', bytes: xlsx },
        { kind: 'file', name: '../../资料.zip', mime: 'application/zip', bytes: zip },
        { kind: 'image', name: 'p.png', mime: 'image/png', bytes: Buffer.from([1, 2, 3]) },
        { kind: 'image', name: 'p.png', mime: 'image/png', bytes: Buffer.from([4, 5, 6]) },
        { kind: 'image', name: 'p.png', mime: 'image/png', bytes: Buffer.from([1, 2, 3]) },
      ], { workspacePath: ws });
      expect(out[0].path).toBe(path.join(ws, 'uploads', '预算.xlsx'));
      expect(out[0].fileId).toBeTruthy();
      expect(await fs.readFile(out[0].path)).toEqual(xlsx);
      /* 文件名里的路径被去掉, 写不出工作区 */
      expect(out[1].path).toBe(path.join(ws, 'uploads', '资料.zip'));
      expect(out[1].status).toBe('saved');
      expect(out[1].fileId).toBeUndefined();
      expect(out[2].path).toBe(path.join(ws, 'uploads', 'p.png'));
      expect(out[3].path).toBe(path.join(ws, 'uploads', 'p (2).png'));
      expect(out[4].path).toBe(path.join(ws, 'uploads', 'p.png'));
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  it('没工作区 (聊天模式): 读不出文字的格式照旧报错', async () => {
    await expect(toDesktopAttachments([
      { kind: 'file', name: 'a.zip', mime: 'application/zip', bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0xff, 0xfe]) },
    ])).rejects.toBeInstanceOf(AttachmentError);
  });
});
