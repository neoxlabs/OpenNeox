
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { CRASH_LIMITS } from './types.js';

export interface ScrubOptions {
  /** 当前工作区路径 —— 命中后只保留最后一段目录名 */
  workspaceDir?: string;
}

/* 凭证形态 —— 宁可多遮不可漏遮。都是「长度够长才可能是真 key」, 避免把普通单词遮掉。 */
const SECRET_PATTERNS: RegExp[] = [
  /* OpenAI / 各家兼容: sk-xxxxxxxxxxxxxxxx */
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /* Stripe 风格 sk_live_ / pk_test_ */
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /* Google API key */
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /* GitHub token */
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /* Authorization: Bearer xxx */
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /* key=value / key: value 形态 (api_key / token / secret / password …) */
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{6,}["']?/gi,
];

/** 把凭证形态的串替换成 [REDACTED] (保留 `key=` 这样的键名, 便于看出是哪类泄露)。 */
export function maskSecrets(input: string): string {
  if (!input) return input;
  let out = input;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match) => {
      const kv = /^([A-Za-z_-]+)\s*[:=]\s*/.exec(match);
      return kv ? `${kv[1]}=[REDACTED]` : '[REDACTED]';
    });
  }
  return out;
}

/** 把用户名换成 `~`、工作区路径只留最后一段。 */
export function scrubPaths(input: string, opts: ScrubOptions = {}): string {
  if (!input) return input;
  let s = input;

  /* 1. 工作区路径 —— 只留最后一段 */
  const ws = opts.workspaceDir?.trim();
  if (ws) {
    const last = path.basename(ws) || ws;
    for (const form of new Set([ws, ws.replace(/\//g, '\\'), ws.replace(/\\/g, '/')])) {
      if (form && form !== '/' && form !== '\\') s = s.split(form).join(last);
    }
  }

  /* 2. 本机 home → ~ (三种写法都试, macOS/Linux 用正斜杠, Windows 两种都出现) */
  const home = os.homedir();
  if (home) {
    for (const form of new Set([home, home.replace(/\//g, '\\'), home.replace(/\\/g, '/')])) {
      if (form) s = s.split(form).join('~');
    }
  }

  /* 3. 残留的他人 / 其它机器路径 —— 用户名段一律抹成 ~ */
  s = s.replace(/\/Users\/[^/\s"')]+/g, '~');
  s = s.replace(/\/home\/[^/\s"')]+/g, '~');
  s = s.replace(/[A-Za-z]:\\Users\\[^\\\s"')]+/g, '~');
  return s;
}

/** 完整脱敏: 路径 + 凭证。对外发送的文本必须过这一道。 */
export function sanitizeText(input: string, opts: ScrubOptions = {}): string {
  return maskSecrets(scrubPaths(input, opts));
}

/** message 压成一行并截断到 500 字 (换行会把上报的 JSON 撑得很难读)。 */
export function truncateMessage(input: string, max: number = CRASH_LIMITS.messageChars): string {
  if (!input) return '';
  const s = input.replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/** 栈 → 帧数组 (≤40), 逐帧脱敏。拿不到栈时返回空数组。 */
export function normalizeStack(
  stack: string | undefined,
  opts: ScrubOptions = {},
  max: number = CRASH_LIMITS.stackFrames,
): string[] {
  if (!stack) return [];
  const lines = String(stack)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  /* 只要 `at ...` 的帧行; 一条都没有时 (某些原生库只给一段文本) 退回原始行 */
  const frames = lines.filter((l) => l.startsWith('at '));
  const picked = (frames.length ? frames : lines).slice(0, max);
  return picked.map((l) => sanitizeText(l, opts));
}

/* node 内部帧 / 三方库帧对归并没有区分度 —— 跳过去找第一帧「我们自己的」代码。 */
const NOISE_FRAME = /(node:internal|internal\/|node_modules|processTicksAndRejections|new Promise|async )/i;

/** 首个有意义的栈帧 (跳过 node 内部与 node_modules)。 */
export function firstMeaningfulFrame(frames: string[]): string {
  for (const f of frames) {
    if (f && !NOISE_FRAME.test(f)) return f;
  }
  return frames.find((f) => !!f) ?? '';
}

/** dedupeKey = hash(kind + 首个有意义栈帧)。同一处崩一次只算一条。 */
export function computeDedupeKey(kind: string, frames: string[]): string {
  const basis = `${kind}:${firstMeaningfulFrame(frames)}`;
  return createHash('sha256').update(basis).digest('hex').slice(0, 16);
}
