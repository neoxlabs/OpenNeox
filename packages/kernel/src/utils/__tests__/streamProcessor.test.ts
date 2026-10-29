import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import {
  StreamProcessor,
  getStreamProcessor,
  processLargeString,
  parseLargeJSON,
  safeJSONParse,
} from '../streamProcessor.js';

describe('StreamProcessor.processLargeString', () => {
  it('小字符串单个块原样处理', async () => {
    const p = new StreamProcessor({ chunkSize: 100 });
    const out = await p.processLargeString('hello', (chunk) => chunk.toUpperCase());
    expect(out).toEqual(['HELLO']);
  });

  it('按 chunkSize/2 个字符切块，顺序保持', async () => {
    const p = new StreamProcessor({ chunkSize: 10 });
    const out = await p.processLargeString('abcdefghij', (chunk, i) => `${i}:${chunk}`);
    expect(out).toEqual(['0:abcde', '1:fghij']);
  });

  it('多字节字符不会被 surrogate 切断', async () => {
    const p = new StreamProcessor({ chunkSize: 4 });
    const text = '😀'.repeat(10);
    const out = await p.processLargeString(text, (chunk) => chunk);
    expect(out.join('')).toBe(text);
    for (const chunk of out) {
      expect(/^[\uD800-\uDBFF][\uDC00-\uDFFF]$/.test(chunk)).toBe(true);
    }
  });

  it('空字符串返回空结果', async () => {
    const p = new StreamProcessor({ chunkSize: 10 });
    expect(await p.processLargeString('', (c) => c)).toEqual([]);
  });

  it('进度回调按块累计，字节数正确', async () => {
    const p = new StreamProcessor({ chunkSize: 10 });
    const progress: any[] = [];
    await p.processLargeString('abcdefghij', (c) => c, (x) => progress.push(x));
    expect(progress).toHaveLength(2);
    expect(progress[0].processedChunks).toBe(1);
    expect(progress[1].processedChunks).toBe(2);
    expect(progress[1].processedBytes).toBe(10);
    expect(progress[1].totalBytes).toBe(10);
  });

  it('处理器抛错时整个调用 reject', async () => {
    const p = new StreamProcessor({ chunkSize: 10 });
    await expect(p.processLargeString('abcdefghij', () => { throw new Error('processor failed'); })).rejects.toThrow('processor failed');
  });

  it('异步处理器抛错也同样 reject', async () => {
    const p = new StreamProcessor({ chunkSize: 10 });
    await expect(p.processLargeString('abc', async () => { throw new Error('async failed'); })).rejects.toThrow('async failed');
  });

  it('processingDelay > 0 时等待后再处理', async () => {
    const p = new StreamProcessor({ chunkSize: 10, processingDelay: 1 });
    const out = await p.processLargeString('abcd', (c) => c);
    expect(out).toEqual(['abcd']);
  });
});

describe('StreamProcessor.processLargeBuffer', () => {
  it('按字节切块且保持顺序', async () => {
    const p = new StreamProcessor({ chunkSize: 4 });
    const out = await p.processLargeBuffer(Buffer.from('abcdef'), (chunk, i) => `${i}:${chunk.toString()}`);
    expect(out).toEqual(['0:abcd', '1:ef']);
  });

  it('空 Buffer 返回空结果', async () => {
    const p = new StreamProcessor({ chunkSize: 4 });
    expect(await p.processLargeBuffer(Buffer.alloc(0), (c) => c.length)).toEqual([]);
  });
});

describe('StreamProcessor JSON', () => {
  it('小 JSON 直接解析', async () => {
    const p = new StreamProcessor({ chunkSize: 100 });
    await expect(p.processLargeJSON('{"a":1}')).resolves.toEqual({ a: 1 });
  });

  it('非法 JSON reject', async () => {
    const p = new StreamProcessor({ chunkSize: 100 });
    await expect(p.processLargeJSON('{oops')).rejects.toThrow();
  });

  it('大 JSON 分块路径开始/结束各回调一次进度', async () => {
    const p = new StreamProcessor({ chunkSize: 10 });
    const progress: any[] = [];
    const value = { a: 'x'.repeat(100) };
    const out = await p.processLargeJSON(JSON.stringify(value), (x) => progress.push(x));
    expect(out).toEqual(value);
    expect(progress).toHaveLength(2);
    expect(progress[0].processedChunks).toBe(0);
    expect(progress[1].processedChunks).toBe(1);
  });
});

describe('createTransformStream', () => {
  it('按顺序转换并对错误走 error 事件', async () => {
    const p = new StreamProcessor();
    const t = p.createTransformStream(async (n: number) => {
      if (n === 2) throw new Error('bad chunk');
      return n * 10;
    });
    const data: number[] = [];
    const err = await new Promise<Error | null>((resolve) => {
      t.on('data', (x) => data.push(x));
      t.on('error', resolve);
      t.on('end', () => resolve(null));
      Readable.from([1, 2, 3]).pipe(t);
    });
    expect(err?.message).toBe('bad chunk');
    expect(data).toEqual([10]);
  });

  it('正常处理时按顺序输出', async () => {
    const p = new StreamProcessor();
    const t = p.createTransformStream((x: number, i: number) => i + x);
    const data: number[] = [];
    await new Promise<void>((resolve) => {
      t.on('data', (x) => data.push(x));
      t.on('end', resolve);
      Readable.from([10, 10, 10]).pipe(t);
    });
    expect(data).toEqual([10, 11, 12]);
  });
});

describe('便捷函数', () => {
  it('processLargeString 使用全局单例', async () => {
    expect(getStreamProcessor()).toBe(getStreamProcessor());
    const out = await processLargeString('abc', (c) => c);
    expect(out).toEqual(['abc']);
  });

  it('parseLargeJSON 使用全局单例', async () => {
    await expect(parseLargeJSON('{"x":1}')).resolves.toEqual({ x: 1 });
  });

  it('safeJSONParse 合法 / 非法 / fallback', async () => {
    await expect(safeJSONParse('{"a":1}')).resolves.toEqual({ a: 1 });
    await expect(safeJSONParse('not json')).resolves.toBeUndefined();
    await expect(safeJSONParse('not json', { fallback: true })).resolves.toEqual({ fallback: true });
  });

  it('safeJSONParse 大字符串走异步解析', async () => {
    const big = JSON.stringify({ s: 'x'.repeat(120_000) });
    const out = await safeJSONParse<{ s: string }>(big);
    expect(out?.s.length).toBe(120_000);
  });
});
