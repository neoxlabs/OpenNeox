
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CRASH_LIMITS } from './types.js';

export interface NativeCrashInfo {
  /** .ips 文件路径 (本机路径, 只用于日志, 不进上报载荷) */
  file: string;
  procName: string;
  signal?: string;
  exceptionType?: string;
  terminationIndicator?: string;
  captureTime?: string;
  /** `模块!符号` 形态, ≤20 帧 */
  frames: string[];
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 解析一份 .ips 的内容。解析不出来返回 null (格式不认识就当没有)。 */
export function parseIps(content: string, file = '<ips>'): NativeCrashInfo | null {
  if (!content || !content.trim()) return null;
  const nl = content.indexOf('\n');
  const headerRaw = nl >= 0 ? content.slice(0, nl) : content;
  const bodyRaw = nl >= 0 ? content.slice(nl + 1) : '';
  const header = safeJson(headerRaw) ?? {};
  const body = safeJson(bodyRaw);
  if (!body || typeof body !== 'object') return null;

  const images: any[] = Array.isArray(body.usedImages) ? body.usedImages : [];
  const threads: any[] = Array.isArray(body.threads) ? body.threads : [];

  /* faultingThread 是权威索引; 老一点的格式只有 threads[].triggered。都没有就退到第 0 个线程。 */
  let thread: any = typeof body.faultingThread === 'number' ? threads[body.faultingThread] : undefined;
  if (!thread) thread = threads.find((t) => t?.triggered === true) ?? threads[0];
  const rawFrames: any[] = Array.isArray(thread?.frames) ? thread.frames : [];

  const frames: string[] = [];
  for (const fr of rawFrames) {
    if (frames.length >= CRASH_LIMITS.nativeFrames) break;
    const img = images[fr?.imageIndex] ?? {};
    const rawName = typeof img.name === 'string' && img.name
      ? img.name
      : (typeof img.path === 'string' ? path.basename(img.path) : '');
    const modName = rawName || 'unknown';
    const sym = typeof fr?.symbol === 'string' && fr.symbol
      ? fr.symbol
      : (typeof fr?.imageOffset === 'number' ? `+0x${fr.imageOffset.toString(16)}` : '?');
    frames.push(`${modName}!${sym}`);
  }

  const exc = body.exception ?? {};
  return {
    file,
    procName: String(body.procName || header.app_name || header.name || ''),
    signal: typeof exc.signal === 'string' ? exc.signal : undefined,
    exceptionType: typeof exc.type === 'string' ? exc.type : undefined,
    terminationIndicator: typeof body.termination?.indicator === 'string' ? body.termination.indicator : undefined,
    captureTime: typeof body.captureTime === 'string'
      ? body.captureTime
      : (typeof header.timestamp === 'string' ? header.timestamp : undefined),
    frames,
  };
}

/** 系统原生崩溃报告目录 (只有 macOS 有)。 */
export function defaultDiagnosticReportsDir(): string {
  return path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports');
}

/**
 * 找本机这段时间之后的原生崩溃报告。
 * 只认文件名形如 `<进程名>-YYYY-MM-DD-HHMMSS.ips` 的, 且进程名在白名单里 ——
 * 目录里还躺着别的 App 的崩溃报告, 别捡错。
 */
export function findNativeCrashReports(
  opts: { dir?: string; since?: number; procNames?: string[] } = {},
): NativeCrashInfo[] {
  const dir = opts.dir ?? defaultDiagnosticReportsDir();
  const procNames = opts.procNames ?? ['node', 'Neox', 'Electron'];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const out: NativeCrashInfo[] = [];
  for (const name of names) {
    if (!name.endsWith('.ips')) continue;
    const base = name.slice(0, -'.ips'.length);
    if (!procNames.some((p) => base === p || base.startsWith(`${p}-`))) continue;
    const file = path.join(dir, name);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (opts.since !== undefined && mtimeMs < opts.since) continue;
    let content = '';
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const info = parseIps(content, file);
    if (info) out.push(info);
  }
  out.sort((a, b) => (a.captureTime ?? '').localeCompare(b.captureTime ?? ''));
  return out;
}
