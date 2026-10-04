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

/**
 * 解码一条 shell 输出 chunk。Windows 上 utf8 解码出现 � 时按 ACP 重解; 其余情况原样 utf8。
 */
export function decodeShellChunk(chunk: Buffer): string {
  const utf8 = chunk.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8; // 纯 UTF-8: 零改动 (外部程序路径)
  if (process.platform !== 'win32') return utf8;

  const acp = getWindowsAcp();
  // WHATWG 支持 gbk / windows-1250..1258 / windows-936 等; 非标准代码页回退 gbk
  const labels: string[] = acp === '936' ? ['gbk'] : [`windows-${acp}`, 'gbk'];
  for (const label of labels) {
    try {
      return new TextDecoder(label).decode(chunk);
    } catch { /* 换下一个 */ }
  }
  return utf8;
}
