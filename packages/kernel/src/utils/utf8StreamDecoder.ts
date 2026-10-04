/**
 * utf8StreamDecoder — 使用 StringDecoder 跨 chunk 解码 SSE 字节流。
 * 每条流独立创建实例，并在结束时调用 end() 刷出残留字节。
 */

import { StringDecoder } from 'node:string_decoder';

export interface Utf8ChunkDecoder {
  (chunk: unknown): string;
  /** 流结束时调一次 —— 残留的半个字符在这里以 � 形式吐出 (正常流为空串) */
  end(): string;
}

export function createUtf8ChunkDecoder(): Utf8ChunkDecoder {
  const decoder = new StringDecoder('utf8');
  const decode = ((chunk: unknown): string => {
    if (chunk === null || chunk === undefined) return '';
    if (Buffer.isBuffer(chunk)) return decoder.write(chunk);
    /* 已经是字符串 = 上游流本身开了 encoding, 没有半字符问题, 原样返回 */
    if (typeof chunk === 'string') return chunk;
    if (chunk instanceof Uint8Array) return decoder.write(Buffer.from(chunk));
    return String(chunk);
  }) as Utf8ChunkDecoder;
  decode.end = () => decoder.end();
  return decode;
}
