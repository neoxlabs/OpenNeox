/**
 * FileAdapter integration test —— 跑真实临时文件, 覆盖:
 *   - init: 行数 + sparseIndex 正确
 *   - readLines: 从头 / 跨稀疏锚点 / 末尾 / 越界
 *   - CRLF 去尾
 *   - UTF-8 多字节不被截断 (行边界就是 \n, 测试确认 decode 正确)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileAdapter } from '../fileAdapter.js';

let tmpDir: string;

async function makeFile(name: string, content: string | Buffer): Promise<string> {
  const p = join(tmpDir, name);
  await writeFile(p, content);
  return p;
}

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'fileAdapter-'));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('FileAdapter', () => {
  it('counts lines and reads from head', async () => {
    const content = 'line0\nline1\nline2\nline3\nline4';
    const p = await makeFile('small.txt', content);
    const a = new FileAdapter(p);
    const meta = await a.init();
    expect(meta.lineCount).toBe(5);
    const lines = await a.readLines(0, 3);
    expect(lines).toEqual(['line0', 'line1', 'line2']);
    await a.close();
  });

  it('handles trailing newline (line count = \\n count)', async () => {
    const content = 'a\nb\nc\n';
    const p = await makeFile('trailing.txt', content);
    const a = new FileAdapter(p);
    const meta = await a.init();
    expect(meta.lineCount).toBe(3);
    const lines = await a.readLines(0, 10);
    expect(lines).toEqual(['a', 'b', 'c']);
    await a.close();
  });

  it('strips CRLF \\r', async () => {
    const content = 'a\r\nb\r\nc';
    const p = await makeFile('crlf.txt', content);
    const a = new FileAdapter(p);
    await a.init();
    const lines = await a.readLines(0, 3);
    expect(lines).toEqual(['a', 'b', 'c']);
    await a.close();
  });

  it('reads correctly across sparse index (>1000 lines)', async () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `line${i}`);
    const content = lines.join('\n') + '\n';
    const p = await makeFile('large.txt', content);
    const a = new FileAdapter(p);
    const meta = await a.init();
    expect(meta.lineCount).toBe(2500);

    // 读锚点后的一段 (line 1050-1053) —— 要从 sparse anchor 1000 往后扫 50 行
    const mid = await a.readLines(1050, 1053);
    expect(mid).toEqual(['line1050', 'line1051', 'line1052']);

    // 读锚点处 (line 2000) —— 应该直接命中 sparseOffsets[2]
    const atAnchor = await a.readLines(2000, 2002);
    expect(atAnchor).toEqual(['line2000', 'line2001']);

    // 读末尾
    const last = await a.readLines(2498, 2501);
    expect(last).toEqual(['line2498', 'line2499']);

    await a.close();
  });

  it('preserves UTF-8 multibyte chars', async () => {
    // 中文 / emoji 都 > 1 字节, 确认 \n 边界切片后 decode 正确
    const content = '你好\nworld 🌍\n中文 emoji 混合 🎉\n';
    const p = await makeFile('utf8.txt', content);
    const a = new FileAdapter(p);
    const meta = await a.init();
    expect(meta.lineCount).toBe(3);
    const lines = await a.readLines(0, 3);
    expect(lines[0]).toBe('你好');
    expect(lines[1]).toBe('world 🌍');
    expect(lines[2]).toBe('中文 emoji 混合 🎉');
    await a.close();
  });

  it('clamps out-of-range reads instead of throwing', async () => {
    const p = await makeFile('short.txt', 'a\nb\nc');
    const a = new FileAdapter(p);
    await a.init();
    expect(await a.readLines(10, 20)).toEqual([]);
    expect(await a.readLines(-5, 2)).toEqual(['a', 'b']);
    await a.close();
  });

  it('handles empty file', async () => {
    const p = await makeFile('empty.txt', '');
    const a = new FileAdapter(p);
    const meta = await a.init();
    expect(meta.lineCount).toBe(0);
    expect(await a.readLines(0, 1)).toEqual([]);
    await a.close();
  });

  it('detects UTF-8 BOM and skips it in decoded output', async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const body = Buffer.from('line0\nline1\n', 'utf-8');
    const p = await makeFile('utf8-bom.txt', Buffer.concat([bom, body]));
    const a = new FileAdapter(p);
    const meta = await a.init();
    expect(meta.detectedBomEncoding).toBe('utf-8');
    expect(meta.bomSize).toBe(3);
    expect(meta.lineCount).toBe(2);
    const lines = await a.readLines(0, 2);
    expect(lines).toEqual(['line0', 'line1']);
    await a.close();
  });

  it('decodes UTF-16 LE with BOM', async () => {
    const bom = Buffer.from([0xff, 0xfe]);
    // 'abc\nde' 作为 UTF-16LE
    const encode = (s: string) => {
      const b = Buffer.alloc(s.length * 2);
      for (let i = 0; i < s.length; i++) b.writeUInt16LE(s.charCodeAt(i), i * 2);
      return b;
    };
    const content = Buffer.concat([bom, encode('abc\nde\n'), encode('最后')]);
    const p = await makeFile('utf16le.txt', content);
    const a = new FileAdapter(p);
    const meta = await a.init();
    expect(meta.detectedBomEncoding).toBe('utf-16le');
    expect(meta.encoding).toBe('utf-16le');
    expect(meta.bomSize).toBe(2);
    expect(meta.lineCount).toBe(3);
    const lines = await a.readLines(0, 3);
    expect(lines).toEqual(['abc', 'de', '最后']);
    await a.close();
  });

  it('decodes UTF-16 BE with BOM', async () => {
    const bom = Buffer.from([0xfe, 0xff]);
    const encode = (s: string) => {
      const b = Buffer.alloc(s.length * 2);
      for (let i = 0; i < s.length; i++) b.writeUInt16BE(s.charCodeAt(i), i * 2);
      return b;
    };
    const content = Buffer.concat([bom, encode('hi\nworld')]);
    const p = await makeFile('utf16be.txt', content);
    const a = new FileAdapter(p);
    const meta = await a.init();
    expect(meta.detectedBomEncoding).toBe('utf-16be');
    expect(meta.lineCount).toBe(2);
    const lines = await a.readLines(0, 2);
    expect(lines).toEqual(['hi', 'world']);
    await a.close();
  });

  it('setEncoding switches decoder (same stride → no rebuild)', async () => {
    // 写一段 windows-1252 的文本 (法文 é = 0xE9)
    const content = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x0a, 0xe9, 0x0a]);
    const p = await makeFile('latin1.txt', content);
    const a = new FileAdapter(p);
    await a.init();
    expect((await a.readLines(0, 2))[1]).not.toBe('é'); // utf-8 decode 会乱
    const meta2 = await a.setEncoding('windows-1252');
    expect(meta2.lineCount).toBe(2); // stride 没变, lineCount 稳定
    expect(await a.readLines(0, 2)).toEqual(['hello', 'é']);
    await a.close();
  });
});
