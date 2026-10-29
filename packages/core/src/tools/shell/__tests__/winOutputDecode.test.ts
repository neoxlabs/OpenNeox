/**
 * Windows 输出解码自愈回归 .
 *
 * cmd 内建命令对 pipe 输出按 ACP (GBK) 字节, 外部程序输出 UTF-8。
 * decodeShellChunk: 纯 UTF-8 零改动; 含替换字符 � 时按 ACP 重解。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createShellOutputDecoder, decodeShellChunk, resetAcpCacheForTest } from '../winOutputDecode.js';

const ORIG_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!;
function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: p });
}

/* "中文测试" 的 GBK 字节 (iconv-lite 不可用, 直接硬编码已知序列) */
const GBK_BYTES = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]);

describe('decodeShellChunk (win32 输出自愈)', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', ORIG_PLATFORM);
    resetAcpCacheForTest();
  });

  it('纯 UTF-8 输出零改动 (外部程序路径: node/git/rg)', () => {
    setPlatform('win32');
    const buf = Buffer.from('hello 中文\n', 'utf8');
    expect(decodeShellChunk(buf)).toBe('hello 中文\n');
  });

  it('GBK 字节 (cmd echo 中文) 按 ACP 重解出正确中文', () => {
    setPlatform('win32');
    const out = decodeShellChunk(GBK_BYTES);
    expect(out).toBe('中文测试');
  });

  it('非 win32 不重解 (保持 utf8 结果)', () => {
    setPlatform('darwin');
    const out = decodeShellChunk(GBK_BYTES);
    expect(out).not.toBe('中文测试');
  });

  it('ASCII 字节直接返回 (无替换字符, 不走重解)', () => {
    setPlatform('win32');
    expect(decodeShellChunk(Buffer.from('plain ascii'))).toBe('plain ascii');
  });

  it('同一块里 GBK 行和 UTF-8 行混写 (Java: System.out GBK + logback UTF-8), 各自解对', () => {
    setPlatform('win32');
    const buf = Buffer.concat([
      Buffer.from('INFO 启动RabbitMQ监听\n', 'utf8'),
      GBK_BYTES, Buffer.from('\n'),
      Buffer.from('INFO 关闭\n', 'utf8'),
    ]);
    expect(decodeShellChunk(buf)).toBe('INFO 启动RabbitMQ监听\n中文测试\nINFO 关闭\n');
  });
});

describe('createShellOutputDecoder (跨 chunk 有状态)', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', ORIG_PLATFORM);
    resetAcpCacheForTest();
  });

  const feed = (parts: Buffer[]): string => {
    const dec = createShellOutputDecoder();
    return parts.map((p) => dec.write(p)).join('') + dec.end();
  };

  for (const p of ['win32', 'darwin']) {
    it(`${p}: UTF-8 汉字被 chunk 切成两半也不乱`, () => {
      setPlatform(p);
      const all = Buffer.from('启动成功 ok\n下一行', 'utf8');
      for (let cut = 1; cut < all.length; cut++) {
        expect(feed([all.subarray(0, cut), all.subarray(cut)])).toBe('启动成功 ok\n下一行');
      }
    });
  }

  it('win32: GBK 半行被切在双字节中间, 留到下一块拼好', () => {
    setPlatform('win32');
    const all = Buffer.concat([Buffer.from('x '), GBK_BYTES]);
    for (let cut = 1; cut < all.length; cut++) {
      expect(feed([all.subarray(0, cut), all.subarray(cut)])).toBe('x 中文测试');
    }
  });

  it('半行不等换行立刻吐 (进度条 / 提示符)', () => {
    setPlatform('win32');
    const dec = createShellOutputDecoder();
    expect(dec.write(Buffer.from('Password: '))).toBe('Password: ');
  });
});
