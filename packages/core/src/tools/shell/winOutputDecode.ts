/**
 * Windows 输出解码自愈 (效率审计配套)
 *
 * 背景: execute_shell 在 Windows 上默认 shell 从 PowerShell 5.1 回落 cmd.exe 后,
 * cmd 对 pipe/重定向输出按【系统 ANSI 代码页 (ACP, 中文系统=GBK)】写字节,
 * 而外部程序 (node / git / rg ...) 输出 UTF-8 —— Node 侧单一解码器必有一方乱码。
 * (PowerShell 路径用 `[Console]::OutputEncoding=UTF8` 统一成 UTF-8, 无此问题。)
 *
 * 策略: 先按 UTF-8 严格解码, 出现替换字符 U+FFFD 说明可能是 ACP 字节 →
 * 用 TextDecoder 按系统代码页重解。纯 UTF-8 输出零副作用 (外部程序不受影响)。
 * 混合输出 (echo 中文 + node 中文 同屏) 是已知极限, 无法在单一解码器下两全。
 *
 * 零依赖: Node 20+ / Electron 默认 full-icu, TextDecoder 原生支持 gbk 等代码页。
 */
import { execFileSync } from 'node:child_process';

let cachedAcp: string | null | undefined;

/** 系统 ANSI 代码页 (注册表 ACP), 拿不到按 936 兜底 (中文系统默认)。 */
function getWindowsAcp(): string {
  if (typeof cachedAcp === 'string') return cachedAcp;
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP'],
      { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const m = out.match(/ACP\s+REG_SZ\s+(\d+)/i);
    cachedAcp = m?.[1] ?? '936';
  } catch {
    cachedAcp = '936';
  }
  return cachedAcp;
}

export function resetAcpCacheForTest(): void {
  cachedAcp = undefined;
}

const EMPTY = Buffer.alloc(0);
const utf8Fatal = new TextDecoder('utf-8', { fatal: true });

function isValidUtf8(b: Uint8Array): boolean {
  try { utf8Fatal.decode(b); return true; } catch { return false; }
}

/** ACP → WHATWG 标签; 双字节代码页额外给「首字节」判定, 用来留住被 chunk 切开的半个字 */
function acpCodec(): { label: string; isLead?: (c: number) => boolean } {
  switch (getWindowsAcp()) {
    case '936': return { label: 'gbk', isLead: (c) => c >= 0x81 && c <= 0xfe };
    case '950': return { label: 'big5', isLead: (c) => c >= 0x81 && c <= 0xfe };
    case '949': return { label: 'euc-kr', isLead: (c) => c >= 0x81 && c <= 0xfe };
    case '932': return { label: 'shift_jis', isLead: (c) => (c >= 0x81 && c <= 0x9f) || (c >= 0xe0 && c <= 0xfc) };
    default: return { label: `windows-${getWindowsAcp()}` };
  }
}

function decodeAcp(b: Uint8Array): string {
  // 非标准代码页 TextDecoder 不认 → 回退 gbk
  for (const label of [acpCodec().label, 'gbk']) {
    try { return new TextDecoder(label).decode(b); } catch { /* 换下一个 */ }
  }
  return Buffer.from(b).toString('utf8');
}

/** 一行: 合法 UTF-8 就按 UTF-8, 否则 (仅 Windows) 按 ACP */
function decodeLine(b: Buffer): string {
  if (b.length === 0) return '';
  if (process.platform !== 'win32' || isValidUtf8(b)) return b.toString('utf8');
  return decodeAcp(b);
}

/** 若干完整行: 整块合法走快路径, 否则逐行判 */
function decodeLines(b: Buffer): string {
  if (process.platform !== 'win32' || isValidUtf8(b)) return b.toString('utf8');
  let out = '';
  let start = 0;
  while (start < b.length) {
    const nl = b.indexOf(0x0a, start);
    const end = nl < 0 ? b.length : nl + 1;
    out += decodeLine(b.subarray(start, end));
    start = end;
  }
  return out;
}

/** 末尾不完整的 UTF-8 序列有几个字节 (0 = 完整) */
function utf8IncompleteTail(b: Buffer): number {
  for (let back = 1; back <= Math.min(3, b.length); back++) {
    const c = b[b.length - back]!;
    if ((c & 0xc0) === 0x80) continue;
    const need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
    return need > back ? back : 0;
  }
  return 0;
}

/** 从行首按双字节代码页走一遍, 末尾悬着一个首字节就返回 1 */
function acpIncompleteTail(b: Buffer): number {
  const { isLead } = acpCodec();
  if (!isLead) return 0;
  let i = 0;
  while (i < b.length) i += isLead(b[i]!) ? 2 : 1;
  return i > b.length ? 1 : 0;
}

export interface ShellOutputDecoder {
  write(chunk: Buffer): string;
  /** 流结束时把留着的半个字吐出来 */
  end(): string;
}

/** 每条输出流 (stdout / stderr 各一个) 配一个, 有状态 */
export function createShellOutputDecoder(): ShellOutputDecoder {
  let pending: Buffer = EMPTY;
  return {
    write(chunk: Buffer): string {
      const buf = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      pending = EMPTY;
      const lastNl = buf.lastIndexOf(0x0a);
      const out = lastNl >= 0 ? decodeLines(buf.subarray(0, lastNl + 1)) : '';
      const rest = lastNl >= 0 ? buf.subarray(lastNl + 1) : buf;
      if (rest.length === 0) return out;
      /* 半行 (进度条 / 提示符) 不等换行, 立刻吐; 只把切开的半个字留下 */
      const u8tail = utf8IncompleteTail(rest);
      const head = rest.subarray(0, rest.length - u8tail);
      if (process.platform !== 'win32' || isValidUtf8(head)) {
        pending = Buffer.from(rest.subarray(head.length));
        return out + head.toString('utf8');
      }
      const acpTail = acpIncompleteTail(rest);
      pending = Buffer.from(rest.subarray(rest.length - acpTail));
      return out + decodeAcp(rest.subarray(0, rest.length - acpTail));
    },
    end(): string {
      const b = pending;
      pending = EMPTY;
      return decodeLine(b);
    },
  };
}

/** 把一条 Readable 接成「解好码的文本」回调 (data + end 都接上) */
export function onDecodedData(
  stream: NodeJS.ReadableStream | null | undefined,
  onText: (text: string) => void,
): void {
  if (!stream) return;
  const dec = createShellOutputDecoder();
  stream.on('data', (d: Buffer | string) => {
    const t = dec.write(Buffer.isBuffer(d) ? d : Buffer.from(d));
    if (t) onText(t);
  });
  stream.on('end', () => {
    const t = dec.end();
    if (t) onText(t);
  });
}

/** 无状态一次性解码 (整段输出已收齐时用): 逐行判 UTF-8 / ACP */
export function decodeShellChunk(chunk: Buffer): string {
  return decodeLines(chunk);
}
