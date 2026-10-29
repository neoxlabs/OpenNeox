/**
 * rpcPlaintext.ts — 加密前的明文: JSON-RPC 后面可以直接挂原始字节.
 *
 * 文件块以前塞在 JSON 的 data_base64 里, 字节先胀 4/3。v2 帧本来就是二进制, 字节不用再进 JSON:
 *   普通:   JSON 文本 (首字节 '{')
 *   带字节: [0x01][jsonLen u32 BE][JSON][原始字节], JSON 里 result.data_bin = 字节数
 * 跟手机 relay_frame.dart 的 encodeRpcPlaintext/decodeRpcPlaintext 一致。
 *
 * handler 用 attachBinary(result, buf) 把字节挂到 result 上 (不进 JSON);
 * 发送时走 v2 就拼成带字节明文, 走 v1 / LAN 就自动换回 data_base64, 老对端照样读。
 */
import type { RpcMessage } from './envelopeSchema.js';

export const PLAINTEXT_BIN_TAG = 0x01;

const attachments = new WeakMap<object, Buffer>();

/** 把一段字节挂到 handler 的 result 上 (发的时候按通道决定原样带还是 base64) */
export function attachBinary<T extends object>(result: T, data: Buffer): T {
  attachments.set(result, data);
  return result;
}

export function binaryOf(result: unknown): Buffer | undefined {
  return result && typeof result === 'object' ? attachments.get(result) : undefined;
}

/** RpcMessage → 明文字节。binaryOk = 这条走 v2 帧 */
export function encodeRpcPlaintext(msg: RpcMessage, binaryOk: boolean): Buffer {
  const bin = binaryOf(msg.result);
  if (!bin) return Buffer.from(JSON.stringify(msg), 'utf8');
  const r = msg.result as Record<string, unknown>;
  if (!binaryOk) {
    return Buffer.from(JSON.stringify({ ...msg, result: { ...r, data_base64: bin.toString('base64') } }), 'utf8');
  }
  const json = Buffer.from(JSON.stringify({ ...msg, result: { ...r, data_bin: bin.length } }), 'utf8');
  const head = Buffer.alloc(5);
  head[0] = PLAINTEXT_BIN_TAG;
  head.writeUInt32BE(json.length, 1);
  return Buffer.concat([head, json, bin]);
}

/** 明文字节 → RpcMessage。带字节的, 字节挂回 result (attachBinary) 并补 data_base64 给老代码读 */
export function decodeRpcPlaintext(buf: Buffer): RpcMessage | null {
  let json: string;
  let bin: Buffer | undefined;
  if (buf.length > 0 && buf[0] === PLAINTEXT_BIN_TAG) {
    if (buf.length < 5) return null;
    const n = buf.readUInt32BE(1);
    if (buf.length < 5 + n) return null;
    json = buf.subarray(5, 5 + n).toString('utf8');
    bin = buf.subarray(5 + n);
  } else {
    json = buf.toString('utf8');
  }
  let msg: any;
  try { msg = JSON.parse(json); } catch { return null; }
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return null;
  if (bin && msg.result && typeof msg.result === 'object') {
    msg.result.data_base64 = bin.toString('base64');
    attachBinary(msg.result, bin);
  }
  return msg as RpcMessage;
}
