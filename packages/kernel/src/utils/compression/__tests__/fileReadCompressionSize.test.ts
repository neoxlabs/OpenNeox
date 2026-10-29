/*
 * 文件读取压缩: 行数少但单行超长时不许把结果压得更大
 *
 * 曾经的 bug: head/tail 按行切 (15 行 + 7 行), 两行各 5000 字符的文件里
 * 头尾各自切一次 → 输出约 20000 字符, 是原文的两倍。
 */
import { describe, expect, it } from 'vitest';
import { ToolCompressor } from '../toolCompressor.js';

async function compressFile(content: string): Promise<{ content: string; originalLength: number; compressedLength: number }> {
  const result = await new ToolCompressor().compress('Read', content, {});
  return result as any;
}

describe('文件读取压缩: 行少但单行超长', () => {
  it('两行各 5000 字符, 输出必须比原文短', async () => {
    const content = 'a'.repeat(5000) + '\n' + 'b'.repeat(5000);
    const result = await compressFile(content);
    expect(result.compressedLength).toBeLessThan(result.originalLength);
    expect(result.content.length).toBeLessThan(content.length);
  });

  it('单行 10000 字符, 输出必须比原文短', async () => {
    const content = 'x'.repeat(10000);
    const result = await compressFile(content);
    expect(result.content.length).toBeLessThan(content.length);
  });
});
