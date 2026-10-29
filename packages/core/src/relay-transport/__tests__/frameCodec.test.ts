import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  decodeFrame,
  encodeFrames,
  FrameAssembler,
  FrameCaps,
  FRAME_MAX_BYTES,
  isBinaryFrame,
  splitSealed,
} from '../frameCodec.js';
import { decryptAesGcm, encryptAesGcm, randomNonce } from '../envelopeCrypto.js';

const route = { to: 'desk-1', from: 'phone-1', from_ep: 'app:x' };

function roundTrip(frames: Buffer[], asm = new FrameAssembler()): Buffer | null {
  let out: Buffer | null = null;
  for (const f of frames) {
    expect(isBinaryFrame(f)).toBe(true);
    expect(f.length).toBeLessThanOrEqual(FRAME_MAX_BYTES);
    const d = decodeFrame(f)!;
    expect(d.hdr.to).toBe('desk-1');
    expect(d.hdr.from_ep).toBe('app:x');
    const r = asm.push(d.hdr, d.body);
    if (r) out = r;
  }
  return out;
}

describe('frameCodec', () => {
  it('单帧字节跟手机端 relay_frame_test.dart / 中转一致', () => {
    const nonce = Buffer.from([...Array(12).keys()]);
    const [f] = encodeFrames({ to: 'd', from: 'p' }, nonce, Buffer.from([0xaa, 0xbb]));
    const hdr = Buffer.from('{"to":"d","from":"p"}');
    expect(f.equals(Buffer.concat([Buffer.from([0, 2, 0, hdr.length]), hdr, nonce, Buffer.from([0xaa, 0xbb])]))).toBe(true);
  });

  it('小消息一帧, 加解密往返', () => {
    const key = randomBytes(32);
    const nonce = randomNonce();
    const ct = encryptAesGcm(key, nonce, Buffer.from('{"jsonrpc":"2.0"}'));
    const frames = encodeFrames(route, nonce, ct);
    expect(frames).toHaveLength(1);
    const s = splitSealed(roundTrip(frames)!)!;
    expect(decryptAesGcm(key, s.nonce, s.ciphertext).toString()).toBe('{"jsonrpc":"2.0"}');
  });

  it('3MB 消息切片, 乱序到达也能拼回', () => {
    const key = randomBytes(32);
    const nonce = randomNonce();
    const plain = randomBytes(3 * 1024 * 1024);
    const ct = encryptAesGcm(key, nonce, plain);
    const frames = encodeFrames(route, nonce, ct);
    expect(frames.length).toBeGreaterThan(10);
    const shuffled = [...frames].reverse();
    const s = splitSealed(roundTrip(shuffled)!)!;
    expect(decryptAesGcm(key, s.nonce, s.ciphertext).equals(plain)).toBe(true);
  });

  it('缺一片不出结果, 超时后清掉', () => {
    let t = 0;
    const asm = new FrameAssembler(() => t);
    const frames = encodeFrames(route, randomNonce(), randomBytes(600 * 1024));
    expect(roundTrip(frames.slice(1), asm)).toBeNull();
    expect(asm.pending).toBe(1);
    t = 61_000;
    const other = encodeFrames(route, randomNonce(), randomBytes(600 * 1024));
    roundTrip(other.slice(0, 1), asm);
    expect(asm.pending).toBe(1);
  });

  it('重复片 / 坏头被丢', () => {
    const asm = new FrameAssembler();
    const frames = encodeFrames(route, randomNonce(), randomBytes(600 * 1024));
    const d = decodeFrame(frames[0])!;
    expect(asm.push(d.hdr, d.body)).toBeNull();
    expect(asm.push(d.hdr, d.body)).toBeNull();
    expect(decodeFrame(Buffer.from('{"to_device_id":"x"}'))).toBeNull();
    expect(isBinaryFrame(Buffer.from('{"a":1}'))).toBe(false);
    expect(asm.push({ ...d.hdr, i: 99 }, d.body)).toBeNull();
  });

  it('协商: 中转和对端都认才发 v2, 重连重置中转位', () => {
    const caps = new FrameCaps();
    caps.onPeerCap('phone-1', undefined, 2);
    expect(caps.canSend('phone-1')).toBe(false);
    caps.onRelayHello(2);
    expect(caps.canSend('phone-1')).toBe(true);
    expect(caps.canSend('phone-1', 'app:x')).toBe(false);
    expect(caps.canSend('phone-2')).toBe(false);
    caps.resetRelay();
    expect(caps.canSend('phone-1')).toBe(false);
  });
});
