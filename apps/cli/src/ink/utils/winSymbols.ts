/**
 * Windows Unicode Symbol Fallback
 *
 * Windows 终端（cmd/PowerShell 默认字体）不支持部分 Unicode 字符，
 * 显示为方块。提供 ASCII 替代方案。
 */

const isWin = process.platform === 'win32';

// Unicode → ASCII fallback 映射
const SYMBOL_MAP: Record<string, string> = {
  '◆': '*',
  '◈': '*',
  '◇': '*',
  '◉': '*',
  '●': '*',
  '○': 'o',
  '■': '#',
  '□': '.',
  '✓': 'v',
  '✗': 'x',
  '⚡': '!',
  '↵': '<-',
  '→': '->',
  '←': '<-',
  '▸': '>',
  '▾': 'v',
  '▴': '^',
  /* 升级版 marker — 跟 cmd.exe / 老 PowerShell 默认字体可能不支持, 留 ASCII 后备 */
  '✦': '*',
  '✧': '*',
  '✻': '*',
  '✺': '*',
  '✸': '*',
  '⬢': '#',
  '⬣': '#',
  '❖': '*',
  '▣': '#',
  '▶': '>',
  '▰': '#',
  '▱': '.',
};

/**
 * 返回平台安全的符号
 * Windows 返回 ASCII fallback，其他平台返回原始 Unicode
 */
export function sym(unicode: string): string {
  if (!isWin) return unicode;
  return SYMBOL_MAP[unicode] ?? unicode;
}
