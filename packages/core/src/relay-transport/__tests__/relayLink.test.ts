import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { RelayLink } from '../relayLink.js';
import { attachBinary, decodeRpcPlaintext, encodeRpcPlaintext, PLAINTEXT_BIN_TAG } from '../rpcPlaintext.js';
import type { RpcMessage } from '../envelopeSchema.js';

const KEY = randomBytes(32);
const hello = JSON.stringify({ type: 'relay_hello', v: 2 });

/** 模拟中转: 把 a 发的每条原样交给 b */
function deliver(parts: Array<Buffer | string>, to: RelayLink) {
  let out: ReturnType<RelayLink['receive']> = null;
  for (const p of parts) out = to.receive(typeof p === 'string' ? Buffer.from(p) : p) ?? out;
  return out;
}

describe('rpcPlaintext', () => {
  it('挂字节: v2 原样带在尾巴, v1 换回 data_base64', () => {
    const data = randomBytes(1000);
    const msg: RpcMessage = { jsonrpc: '2.0', id: 1, result: attachBinary({ offset: 0, eof: true }, data) };
    const v2 = encodeRpcPlaintext(msg, true);
    expect(v2[0]).toBe(PLAINTEXT_BIN_TAG);
    expect(v2.length).toBeLessThan(1200);
    const back = decodeRpcPlaintext(v2)!;
    expect(Buffer.from((back.result as any).data_base64, 'base64').equals(data)).toBe(true);
    expect((back.result as any).data_bin).toBe(1000);
    const v1 = JSON.parse(encodeRpcPlaintext(msg, false).toString());
    expect(Buffer.from(v1.result.data_base64, 'base64').equals(data)).toBe(true);
  });

  it('没挂字节就是普通 JSON', () => {
    const msg: RpcMessage = { jsonrpc: '2.0', id: 2, result: { a: 1 } };
    expect(encodeRpcPlaintext(msg, true).toString()).toBe(JSON.stringify(msg));
  });
});

describe('RelayLink 协商', () => {
  it('先 v1 盖 cap, 对端认了之后双方改走 v2 二进制帧, 大消息分片', () => {
    const phone = new RelayLink({ device: 'phone', ep: 'app:1' });
    const cli = new RelayLink({ device: 'desk', ep: 'cli:1' });
    for (const l of [phone, cli]) {
      l.onOpen();
      expect(l.receive(Buffer.from(hello))).toBeNull();
    }
    /* 手机第一发: 还不知道对端认不认 → v1 */
    const req: RpcMessage = { jsonrpc: '2.0', id: 'r1', method: 'file.fetch', params: {} };
    const first = phone.seal(KEY, { device: 'desk', ep: 'cli:1' }, req);
    expect(typeof first[0]).toBe('string');
    expect(JSON.parse(first[0] as string).cap).toBe(2);
    const got = deliver(first, cli);
    expect(got?.kind).toBe('sealed');
    expect(cli.open(KEY, got as any)?.method).toBe('file.fetch');
    /* CLI 回包: 已知手机认 v2 → 二进制帧, 3MB 字节自动分片 */
    const data = randomBytes(3 * 1024 * 1024);
    const reply: RpcMessage = { jsonrpc: '2.0', id: 'r1', result: attachBinary({ eof: true }, data) };
    const parts = cli.seal(KEY, { device: 'phone', ep: 'app:1' }, reply);
    expect(parts.length).toBeGreaterThan(10);
    expect(parts.every((p) => Buffer.isBuffer(p))).toBe(true);
    const back = deliver(parts, phone);
    const msg = phone.open(KEY, back as any)!;
    expect(Buffer.from((msg.result as any).data_base64, 'base64').equals(data)).toBe(true);
    /* 手机收到过 v2 帧 → 之后也发 v2 */
    expect(Buffer.isBuffer(phone.seal(KEY, { device: 'desk', ep: 'cli:1' }, req)[0])).toBe(true);
  });

  it('中转没说 hello (老中转) → 一直 v1', () => {
    const a = new RelayLink({ device: 'a' });
    a.onOpen();
    a.caps.onPeerCap('b', undefined, 2);
    expect(typeof a.seal(KEY, { device: 'b' }, { jsonrpc: '2.0', id: 1, result: {} })[0]).toBe('string');
  });
});
