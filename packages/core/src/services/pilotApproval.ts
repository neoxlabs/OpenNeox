import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type PilotTool = 'phone' | 'computer';

/** 手机上会改变现实的动作 (读: read_sms / contacts_search / get_location / read_notifications / sensors / snapshot) */
/* batch 整批按写动作处理: 里面可能含点按 / 填字, 令牌绑定整组 steps (pilot:D-05) */
const PHONE_WRITE_ACTIONS = new Set(['send_sms', 'phone_call', 'set_alarm', 'phone_calendar', 'phone_ui', 'batch']);
/** phone_calendar 只有 add 是写, list 是读 */
const PHONE_WRITE_OPS: Record<string, Set<string>> = {
  phone_calendar: new Set(['add']),
  phone_ui: new Set(['tap', 'tap_at', 'type']),
};
/** 电脑上会改变现实的动作 (读: calendar_events / contacts_search) */
const COMPUTER_WRITE_ACTIONS = new Set(['calendar_add', 'apple_reminders', 'send_imessage']);

export const APPROVAL_VERSION = 'v1';
export const APPROVAL_TTL_MS = 10 * 60_000;

export interface ApprovalToken {
  tool: PilotTool;
  action: string;
  digest: string;
  expiresAt: number;
  nonce: string;
}

/** 这个动作会不会改变用户的现实 (日历 / 闹钟 / 消息 / 屏幕上的点按) */
export function isWriteAction(tool: PilotTool, action: string, args?: Record<string, unknown>): boolean {
  const writes = tool === 'phone' ? PHONE_WRITE_ACTIONS : COMPUTER_WRITE_ACTIONS;
  if (!writes.has(action)) return false;
  const ops = PHONE_WRITE_OPS[action];
  if (!ops) return true;
  const op = typeof args?.op === 'string' ? args.op : '';
  return ops.has(op);
}

/** 稳定序列化: 键排序、丢掉 undefined —— 两端 (TS / Dart) 必须逐字节一致, 否则参数绑定失效 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value as number) ? JSON.stringify(value) : 'null';
  if (t === 'string' || t === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return 'null';
}

/** 参数摘要 —— 令牌只对「这一组精确参数」有效, 批了 ¥32 不能改成 ¥320 */
export function argsDigest(args: unknown): string {
  return createHash('sha256').update(canonicalJson(args ?? {}), 'utf8').digest('hex');
}

function macOf(versioned: string, secret: string | Buffer): string {
  return createHmac('sha256', secret).update(versioned, 'utf8').digest('base64url');
}

export interface SignOptions { ttlMs?: number; now?: number; nonce?: string }

/** 签发: v1.<base64url(payload)>.<base64url(hmac)> */
export function signApproval(
  tool: PilotTool,
  action: string,
  args: Record<string, unknown> | undefined,
  secret: string | Buffer,
  opts: SignOptions = {},
): string {
  const now = opts.now ?? Date.now();
  const payload = {
    t: tool,
    a: action,
    d: argsDigest(args),
    e: now + (opts.ttlMs ?? APPROVAL_TTL_MS),
    n: opts.nonce ?? randomBytes(16).toString('hex'),
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const versioned = `${APPROVAL_VERSION}.${body}`;
  return `${versioned}.${macOf(versioned, secret)}`;
}

export interface VerifyExpectation {
  tool: PilotTool;
  action: string;
  args?: Record<string, unknown>;
}
export interface VerifyOptions { now?: number }

/** 验签: 签名不对 / 参数不符 / 过期 / 格式不对 → null */
export function verifyApproval(
  raw: unknown,
  expect: VerifyExpectation,
  secret: string | Buffer,
  opts: VerifyOptions = {},
): ApprovalToken | null {
  if (typeof raw !== 'string' || !raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== APPROVAL_VERSION) return null;
  const [, body, mac] = parts;
  const want = macOf(`${APPROVAL_VERSION}.${body}`, secret);
  const a = Buffer.from(mac, 'utf8');
  const b = Buffer.from(want, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const tool = payload.t;
  const action = payload.a;
  const digest = payload.d;
  const expiresAt = payload.e;
  const nonce = payload.n;
  if ((tool !== 'phone' && tool !== 'computer') || typeof action !== 'string') return null;
  if (typeof digest !== 'string' || typeof nonce !== 'string' || !nonce) return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;

  const now = opts.now ?? Date.now();
  if (expiresAt <= now) return null;
  if (tool !== expect.tool || action !== expect.action) return null;
  if (digest !== argsDigest(expect.args)) return null;

  return { tool, action, digest, expiresAt, nonce };
}

/**
 * 重放: 同一个令牌只能用一次。节点内存里记用过的 nonce (带过期), 进程重启即清空 ——
 * 令牌本来就只有 10 分钟寿命, 重启后旧令牌要么已过期、要么会重新被验签一次, 可接受。
 */
export class ApprovalNonceCache {
  private seen = new Map<string, number>();

  /** true = 第一次见到 (可以用), false = 重放 */
  consume(token: ApprovalToken, now: number = Date.now()): boolean {
    this.sweep(now);
    if (this.seen.has(token.nonce)) return false;
    this.seen.set(token.nonce, token.expiresAt);
    return true;
  }

  get size(): number { return this.seen.size; }

  private sweep(now: number): void {
    for (const [nonce, exp] of this.seen) if (exp <= now) this.seen.delete(nonce);
  }
}

/** 给 phone.exec / computer.exec 的参数补上 approval (只对写动作; 读动作保持原样) */
export function withApproval(
  tool: PilotTool,
  action: string,
  args: Record<string, unknown> | undefined,
  secret: string | Buffer | null,
  opts: SignOptions = {},
): { args: Record<string, unknown>; approval?: string } {
  const safeArgs = args ?? {};
  if (!secret || !isWriteAction(tool, action, safeArgs)) return { args: safeArgs };
  return { args: safeArgs, approval: signApproval(tool, action, safeArgs, secret, opts) };
}
