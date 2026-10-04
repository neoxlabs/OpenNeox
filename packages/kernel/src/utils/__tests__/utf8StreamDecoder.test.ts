/** 验证分块 UTF-8 解码保留跨 chunk 的多字节字符，并显式暴露坏字节。 */
import { describe, expect, it } from 'vitest';
import { createUtf8ChunkDecoder } from '../utf8StreamDecoder.js';

const TEXT = '工作区仓库数量及修改 · emoji 🚀 混排';

describe('createUtf8ChunkDecoder', () => {
  it('任意字节边界切开都能还原 (逐字节喂也一样)', () => {
    const bytes = Buffer.from(TEXT, 'utf8');
    for (let cut = 1; cut < bytes.length; cut++) {
      const decode = createUtf8ChunkDecoder();
      const out = decode(bytes.subarray(0, cut)) + decode(bytes.subarray(cut)) + decode.end();
      expect(out, `切在第 ${cut} 字节`).toBe(TEXT);
    }

    const oneByOne = createUtf8ChunkDecoder();
    let acc = '';
    for (const b of bytes) acc += oneByOne(Buffer.from([b]));
    acc += oneByOne.end();
    expect(acc).toBe(TEXT);
  });

  it('对照: 老写法 chunk.toString() 正是 � 的来源', () => {
    const bytes = Buffer.from('工作区', 'utf8');
    const broken = bytes.subarray(0, 4).toString() + bytes.subarray(4).toString();
    expect(broken).not.toBe('工作区');
    expect(broken).toContain('�');
  });

  it('字符串 chunk 原样返回 (上游已开 encoding 的流)', () => {
    const decode = createUtf8ChunkDecoder();
    expect(decode('已经是文本')).toBe('已经是文本');
  });

  it('真正损坏的字节仍然暴露成 �, 不吞', () => {
    const decode = createUtf8ChunkDecoder();
    const out = decode(Buffer.from([0xe5, 0xb7])) + decode.end();
    expect(out).toContain('�');
  });

  it('Uint8Array 也认', () => {
    const decode = createUtf8ChunkDecoder();
    expect(decode(new Uint8Array(Buffer.from('区', 'utf8'))) + decode.end()).toBe('区');
  });
});
