/**
 * Strip ANSI escape sequences from text.
 * 给 bash_output 工具用 — PTY 输出里有颜色/光标控制码,LLM 看了只会浪费 token。
 * UI 层(processManager.outputBuffer)保留原始彩色输出用于渲染。
 *
 * 参考 chalk/ansi-regex 的简化版(不拉 ansi-regex 依赖)。
 */

// 覆盖 CSI(SGR/cursor)+ OSC + 独立 ESC 序列。
// ── CSI: ESC [ <param bytes> <intermediate bytes> <final byte>
//    · params: 0x30-0x3F(数字 + ; < = > ? 等)
//    · intermediate: 0x20-0x2F(空格到 /)
//    · final: 0x40-0x7E(@ 到 ~)
// ── OSC: ESC ] ... (BEL | ST=ESC\)
// ── 独立 ESC + single byte(2 字符序列)
const ANSI_CSI_REGEX = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;
const ANSI_OSC_REGEX = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_ESC_REGEX = /\x1b[@-Z\\-_]/g;

/** 剥掉 ANSI 控制序列,保留纯文本 */
export function stripAnsi(input: string): string {
  if (!input) return input;
  return input
    .replace(ANSI_CSI_REGEX, '')
    .replace(ANSI_OSC_REGEX, '')
    .replace(ANSI_ESC_REGEX, '');
}
