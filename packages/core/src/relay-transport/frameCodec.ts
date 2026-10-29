import { randomBytes } from 'node:crypto';
import { NONCE_LEN } from './envelopeCrypto.js';

export const FRAME_MAGIC = 0x00;
export const FRAME_VERSION = 2;
/** relay 单帧上限 256KB (relay.go maxEnvelopeBytes), 留 6KB 余量 */
export const FRAME_MAX_BYTES = 250 * 1024;
/** 头最多给这么多, 剩下的都是 body */
const HDR_BUDGET = 512;
/** 一条消息拼回后的上限 —— 防对端乱发把内存吃光 */
export const MESSAGE_MAX_BYTES = 64 * 1024 * 1024;
const MAX_PARTIALS = 32;
const PARTIAL_TTL_MS = 60_000;

export interface FrameRoute {
  to: string;
  from: string;
  to_ep?: string;
  from_ep?: string;
}

export interface FrameHeader extends FrameRoute {
  /** 分片消息 id (同一条消息的各片相同) */
  mid?: string;
  i?: number;
  n?: number;
}

export function isBinaryFrame(raw: unknown): raw is Buffer {
  return Buffer.isBuffer(raw) && raw.length > 0 && raw[0] === FRAME_MAGIC;
}

function frame(hdr: FrameHeader, body: Buffer): Buffer {
  const h = Buffer.from(JSON.stringify(hdr), 'utf8');
  if (h.length > HDR_BUDGET) throw new Error(`frame header too large: ${h.length}`);
  const pre = Buffer.alloc(4);
  pre[0] = FRAME_MAGIC;
  pre[1] = FRAME_VERSION;
  pre.writeUInt16BE(h.length, 2);
  return Buffer.concat([pre, h, body]);
}

function cleanRoute(r: FrameRoute): FrameRoute {
  return {
    to: r.to,
    from: r.from,
    ...(r.to_ep ? { to_ep: r.to_ep } : {}),
    ...(r.from_ep ? { from_ep: r.from_ep } : {}),
  };
}

/** 加密好的一条消息 → 若干帧 (小消息一帧) */
export function encodeFrames(route: FrameRoute, nonce: Buffer, ciphertext: Buffer, maxFrame = FRAME_MAX_BYTES): Buffer[] {
  const body = Buffer.concat([nonce, ciphertext]);
  const r = cleanRoute(route);
  const budget = maxFrame - 4 - HDR_BUDGET;
  if (body.length <= budget) return [frame(r, body)];
  if (body.length > MESSAGE_MAX_BYTES) throw new Error(`message too large: ${body.length}`);
  const n = Math.ceil(body.length / budget);
  const mid = randomBytes(8).toString('hex');
  const out: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    out.push(frame({ ...r, mid, i, n }, body.subarray(i * budget, Math.min(body.length, (i + 1) * budget))));
  }
  return out;
}

export function decodeFrame(raw: Buffer): { hdr: FrameHeader; body: Buffer } | null {
  if (raw.length < 4 || raw[0] !== FRAME_MAGIC || raw[1] !== FRAME_VERSION) return null;
  const n = raw.readUInt16BE(2);
  if (n === 0 || raw.length <= 4 + n) return null;
  let hdr: FrameHeader;
  try {
    hdr = JSON.parse(raw.subarray(4, 4 + n).toString('utf8'));
  } catch {
    return null;
  }
  if (!hdr || typeof hdr.to !== 'string' || typeof hdr.from !== 'string') return null;
  return { hdr, body: raw.subarray(4 + n) };
}

/** body (nonce + 密文) 拆开 */
export function splitSealed(body: Buffer): { nonce: Buffer; ciphertext: Buffer } | null {
  if (body.length <= NONCE_LEN) return null;
  return { nonce: body.subarray(0, NONCE_LEN), ciphertext: body.subarray(NONCE_LEN) };
}

interface Partial {
  n: number;
  parts: (Buffer | undefined)[];
  got: number;
  bytes: number;
  at: number;
}

/** 分片拼装。一片丢了整条作废 (60s 后清掉), 上层按请求超时重试 —— 不做重传, 中转不存东西。 */
export class FrameAssembler {
  private partials = new Map<string, Partial>();

  constructor(private readonly now: () => number = Date.now) {}

  /** 喂一帧; 一条消息齐了返回完整 body (nonce + 密文), 否则 null */
  push(hdr: FrameHeader, body: Buffer): Buffer | null {
    if (hdr.mid === undefined) return body;
    const { mid, i, n } = hdr;
    if (typeof mid !== 'string' || !Number.isInteger(i) || !Number.isInteger(n)) return null;
    if (n! < 2 || i! < 0 || i! >= n! || n! * FRAME_MAX_BYTES > MESSAGE_MAX_BYTES * 2) return null;
    this.prune();
    const key = `${hdr.from}|${hdr.from_ep ?? ''}|${mid}`;
    let p = this.partials.get(key);
    if (!p) {
      if (this.partials.size >= MAX_PARTIALS) {
        /* 挤掉最老的一条 */
        const oldest = this.partials.keys().next().value;
        if (oldest !== undefined) this.partials.delete(oldest);
      }
      p = { n: n!, parts: new Array(n!), got: 0, bytes: 0, at: this.now() };
      this.partials.set(key, p);
    }
    if (p.n !== n || p.parts[i!]) return null;
    p.bytes += body.length;
    if (p.bytes > MESSAGE_MAX_BYTES) {
      this.partials.delete(key);
      return null;
    }
    /* 拷一份: ws 收到的 Buffer 可能是共享池里的一段 */
    p.parts[i!] = Buffer.from(body);
    p.got++;
    if (p.got < p.n) return null;
    this.partials.delete(key);
    return Buffer.concat(p.parts as Buffer[]);
  }

  get pending(): number {
    return this.partials.size;
  }

  private prune(): void {
    const cutoff = this.now() - PARTIAL_TTL_MS;
    for (const [k, p] of this.partials) {
      if (p.at < cutoff) this.partials.delete(k);
    }
  }
}

/**
 * 记录谁认 v2: 中转发过 relay_hello{v>=2}, 且对端发来过 cap>=2 的信封或 v2 帧, 才对它发 v2。
 * 重连后中转可能换成老版本, 所以 relay 那一位每次连上都要重置。
 */
export class FrameCaps {
  relayV2 = false;
  private peers = new Set<string>();

  static key(device: string, ep?: string): string {
    return `${device}|${ep ?? ''}`;
  }

  onRelayHello(v: unknown): void {
    this.relayV2 = typeof v === 'number' && v >= FRAME_VERSION;
  }

  onPeerCap(device: string, ep: string | undefined, cap: unknown): void {
    if (typeof cap === 'number' && cap >= FRAME_VERSION) this.peers.add(FrameCaps.key(device, ep));
  }

  canSend(device: string, ep?: string): boolean {
    return this.relayV2 && this.peers.has(FrameCaps.key(device, ep));
  }

  resetRelay(): void {
    this.relayV2 = false;
  }
}
