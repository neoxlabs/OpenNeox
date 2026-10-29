
/** LAN 直连: 单帧 2MB, 512KB 块 base64 后 ~683KB, 余量足够 */
export const FILE_FETCH_CHUNK_BYTES = 512 * 1024;

/** 云中转: 单条 envelope 250KB, 见文件头 */
export const FILE_FETCH_CHUNK_BYTES_CLOUD = 96 * 1024;

/** 云中转信封上限 (NeoxCloud relay.go maxEnvelopeBytes 256KB, 客户端自己留 6KB 余量) */
export const RELAY_ENVELOPE_LIMIT_BYTES = 250 * 1024;

/** 云中转 v2 (二进制帧, 传输层自动分片, 见 relay-transport/frameCodec.ts): 一块不再受单帧上限,
 *  1MB 一块 ≈ 6 帧。手机并发拉几块, 一张原图一两个来回 */
export const FILE_FETCH_CHUNK_BYTES_FRAMES = 1024 * 1024;

/** 'frames' = 云中转且两端已协商到 v2 */
export type FileFetchTransport = 'lan' | 'cloud' | 'frames' | undefined;

/** 这条 transport 上一块最多给多少原始字节。只有确认是 LAN 直连 / v2 才用大块 —— 拿不到
 *  transport 时按云中转的保守值走, 大不了多几次往返, 不能发不出去。 */
export function fileFetchChunkCap(transport: FileFetchTransport): number {
  if (transport === 'lan') return FILE_FETCH_CHUNK_BYTES;
  if (transport === 'frames') return FILE_FETCH_CHUNK_BYTES_FRAMES;
  return FILE_FETCH_CHUNK_BYTES_CLOUD;
}

export function fileFetchChunkLength(
  transport: FileFetchTransport,
  requested: number,
  sizeBytes: number,
  offset: number,
): number {
  const cap = fileFetchChunkCap(transport);
  const want = Number.isFinite(requested) ? requested | 0 : cap;
  return Math.min(want > 0 ? want : cap, cap, sizeBytes - offset);
}

/**
 * 一块原始字节封进云中转信封后的大致字节数 (含 envelope 字段的粗略开销).
 *
 * 只用于把「多大一块才发得出去」算清楚 —— 加密本身在 cloudRelayClient 里做。
 */
export function relayEnvelopeBytesForChunk(bytes: number): number {
  const dataBase64 = Math.ceil(bytes / 3) * 4; // data_base64
  const ciphertext = dataBase64 + 16; // AES-GCM tag
  const ciphertextBase64 = Math.ceil(ciphertext / 3) * 4; // 信封里的 ciphertext
  return ciphertextBase64 + 256; // + to/from device id / nonce / ts 等字段
}
