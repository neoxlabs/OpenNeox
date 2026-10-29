/**
 * ULID: 48 位毫秒时间 + 80 位随机, Crockford base32 共 26 位。
 * 时间有序 (按 id 排就是按创建排), 客户端生成 → 离线可建、重发幂等。
 * 同一毫秒内单调递增 (随机部分 +1), 一批里的顺序不会乱。
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256);
  return b;
}

function encodeTime(ms: number): string {
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[ms % 32] + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

/** 16 个 5 位字符 = 80 位随机 */
function encodeRandom(digits: number[]): string {
  return digits.map(d => ALPHABET[d]).join('');
}

let lastMs = -1;
let lastRand: number[] = [];

export function ulid(now: number = Date.now()): string {
  if (now === lastMs) {
    /* 同毫秒: 随机部分 +1 (进位), 保证单调 */
    let i = lastRand.length - 1;
    while (i >= 0 && lastRand[i] === 31) lastRand[i--] = 0;
    if (i >= 0) lastRand[i]++;
  } else {
    const bytes = randomBytes(16);
    lastRand = Array.from(bytes, b => b & 31);
    lastMs = now;
  }
  return encodeTime(now) + encodeRandom(lastRand);
}

/** ULID 里的时间 (毫秒); 不是合法 ULID 返回 null */
export function ulidTime(id: string): number | null {
  if (!ULID_RE.test(id)) return null;
  let ms = 0;
  for (let i = 0; i < 10; i++) ms = ms * 32 + ALPHABET.indexOf(id[i]);
  return ms;
}
