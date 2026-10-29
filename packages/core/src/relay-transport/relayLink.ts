/**
 * relayLink.ts — 一条中转连接上 v1/v2 的收发处理, Pilot 云端 (cloud-runtime/relayClient) 和
 * CLI 远程 (phone-endpoint/cliPhoneEndpoint) 共用; 电脑客户端 cloudRelayClient 同一套规则。
 *
 *   收: v2 帧拼齐 / v1 信封解 base64 → 统一成 { from, fromEp, nonce, ciphertext };
 *       relay_hello 和对端 cap 在这里记下, 调用方不用管。
 *   发: 对端和中转都认 v2 → 二进制帧 (大消息自动分片, 文件字节不进 base64);
 *       否则 v1 信封盖 cap:2, 对端认得就会改发 v2。
 */
import { decryptAesGcm, encryptAesGcm, randomNonce } from './envelopeCrypto.js';
import { makeEnvelope, parseEnvelope } from './envelopeSchema.js';
import type { RawWsData, RelayControlFrame, RpcMessage } from './envelopeSchema.js';
import {
  decodeFrame,
  encodeFrames,
  FrameAssembler,
  FrameCaps,
  FRAME_VERSION,
  isBinaryFrame,
  splitSealed,
} from './frameCodec.js';
import { decodeRpcPlaintext, encodeRpcPlaintext } from './rpcPlaintext.js';

export interface SealedIncoming {
  kind: 'sealed';
  from: string;
  fromEp?: string;
  nonce: Buffer;
  ciphertext: Buffer;
}
export type RelayIncoming = { kind: 'control'; frame: RelayControlFrame } | SealedIncoming;

export interface RelayPeer {
  device: string;
  ep?: string;
}

function asBuffer(data: RawWsData): Buffer | null {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (data instanceof Uint8Array) return Buffer.from(data);
  return null;
}

export class RelayLink {
  readonly caps = new FrameCaps();
  private readonly assembler = new FrameAssembler();

  constructor(private readonly self: RelayPeer) {}

  /** 每次 WS 连上调: 中转版本以这条连接的 relay_hello 为准 */
  onOpen(): void {
    this.caps.resetRelay();
  }

  canSendFrames(peer: RelayPeer): boolean {
    return this.caps.canSend(peer.device, peer.ep);
  }

  /** 收到一条 WS 消息: 控制帧 / 一条完整密文 / null (分片没齐、relay_hello、坏数据) */
  receive(data: RawWsData): RelayIncoming | null {
    const buf = asBuffer(data);
    if (buf && isBinaryFrame(buf)) {
      const f = decodeFrame(buf);
      if (!f) return null;
      const whole = this.assembler.push(f.hdr, f.body);
      const s = whole && splitSealed(whole);
      if (!s) return null;
      this.caps.onPeerCap(f.hdr.from, f.hdr.from_ep, FRAME_VERSION);
      return { kind: 'sealed', from: f.hdr.from, fromEp: f.hdr.from_ep, ...s };
    }
    const env = parseEnvelope(data);
    if (!env) return null;
    if ('type' in env) {
      if (env.type === 'relay_hello') {
        this.caps.onRelayHello(env.v);
        return null;
      }
      return { kind: 'control', frame: env };
    }
    this.caps.onPeerCap(env.from_device_id, env.from_endpoint, env.cap);
    return {
      kind: 'sealed',
      from: env.from_device_id,
      fromEp: env.from_endpoint,
      nonce: Buffer.from(env.nonce, 'base64'),
      ciphertext: Buffer.from(env.ciphertext, 'base64'),
    };
  }

  /** 解密成 RpcMessage (带字节的明文也认); 解不开抛错 */
  open(key: Buffer, s: SealedIncoming): RpcMessage | null {
    return decodeRpcPlaintext(decryptAesGcm(key, s.nonce, s.ciphertext));
  }

  /** 加密封装, 返回要 ws.send 的若干条 (Buffer = 二进制帧, string = v1 信封) */
  seal(key: Buffer, to: RelayPeer, msg: RpcMessage): Array<Buffer | string> {
    const v2 = this.canSendFrames(to);
    const nonce = randomNonce();
    const ciphertext = encryptAesGcm(key, nonce, encodeRpcPlaintext(msg, v2));
    if (v2) {
      return encodeFrames(
        { to: to.device, from: this.self.device, to_ep: to.ep, from_ep: this.self.ep },
        nonce,
        ciphertext,
      );
    }
    return [
      JSON.stringify(
        makeEnvelope({
          toDeviceId: to.device,
          fromDeviceId: this.self.device,
          toEndpoint: to.ep,
          fromEndpoint: this.self.ep,
          nonce,
          ciphertext,
          cap: FRAME_VERSION,
        }),
      ),
    ];
  }
}
