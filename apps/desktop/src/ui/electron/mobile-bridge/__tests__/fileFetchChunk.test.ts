import { describe, expect, it } from 'vitest';
import {
  FILE_FETCH_CHUNK_BYTES,
  FILE_FETCH_CHUNK_BYTES_CLOUD,
  RELAY_ENVELOPE_LIMIT_BYTES,
  fileFetchChunkCap,
  fileFetchChunkLength,
  relayEnvelopeBytesForChunk,
} from '../fileFetchChunk.js';

describe('file.fetch chunk budget', () => {
  it('手机原来按 150KB 要的块, 封进云中转信封就超线了 (根因)', () => {
    expect(relayEnvelopeBytesForChunk(150 * 1024)).toBeGreaterThan(RELAY_ENVELOPE_LIMIT_BYTES);
  });

  it('云中转的块大小必须留在信封上限之内', () => {
    expect(relayEnvelopeBytesForChunk(FILE_FETCH_CHUNK_BYTES_CLOUD)).toBeLessThan(RELAY_ENVELOPE_LIMIT_BYTES);
  });

  it('LAN 直连用大块 (2MB 帧), 云中转用小块', () => {
    expect(fileFetchChunkCap('lan')).toBe(FILE_FETCH_CHUNK_BYTES);
    expect(fileFetchChunkCap('cloud')).toBe(FILE_FETCH_CHUNK_BYTES_CLOUD);
    /* 没 transport 信息时按保守的那档 (云) 走, 不能默认大块 */
    expect(fileFetchChunkCap(undefined)).toBe(FILE_FETCH_CHUNK_BYTES_CLOUD);
  });

  it('服务端收口: 老 App 按 150KB / 512KB 要, 云中转也只给 96KB', () => {
    const size = 2 * 1024 * 1024;
    expect(fileFetchChunkLength('cloud', 150 * 1024, size, 0)).toBe(FILE_FETCH_CHUNK_BYTES_CLOUD);
    expect(fileFetchChunkLength('cloud', FILE_FETCH_CHUNK_BYTES, size, 0)).toBe(FILE_FETCH_CHUNK_BYTES_CLOUD);
    /* LAN 直连照旧给请求的大小 */
    expect(fileFetchChunkLength('lan', 150 * 1024, size, 0)).toBe(150 * 1024);
  });

  it('最后一块按剩余长度夹, 不越过文件尾', () => {
    const size = FILE_FETCH_CHUNK_BYTES_CLOUD + 10;
    expect(fileFetchChunkLength('cloud', FILE_FETCH_CHUNK_BYTES_CLOUD, size, FILE_FETCH_CHUNK_BYTES_CLOUD)).toBe(10);
  });
});
