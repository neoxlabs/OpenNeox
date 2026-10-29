/**
 * 非 TTY 下的纯文本输出 (CLI-11)
 *
 * 管道 / 重定向 / CI 里 stdout 不是终端: 这时候任何 ANSI 转义 (颜色、光标移动、清屏)
 * 都会变成乱码, 消费方 (`jq`、日志、diff) 没法用。
 *
 * 口径:
 *   · `--output-format text` → 强制纯文本 (哪怕 stdout 是 TTY);
 *   · `--output-format json` → 等价 `--json` (单个 JSON 对象, 同样不含 ANSI);
 *   · 没给格式时, stdout 不是 TTY 就按纯文本处理 (管道 / 重定向 / CI 默认安全)。
 *
 * 纯文本 = 去掉 ANSI 转义 + 其余 C0/C1 控制字符 (保留换行和制表符)。
 */

import chalk from 'chalk';

export type CliOutputFormat = 'text' | 'json';

/** 把 `--output-format` 的值收敛成已知格式; 不认识返回 undefined (由调用方给提示) */
export function resolveOutputFormat(value: string | undefined): CliOutputFormat | undefined {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'text' || v === 'plain') return 'text';
  if (v === 'json') return 'json';
  return undefined;
}

/**
 * 是否走纯文本输出。
 * 显式 `text` 一律纯文本; 显式 `json` 也纯文本 (JSON 里不该混转义); 没给就只看 stdout 是不是 TTY。
 */
export function isPlainOutput(
  format: CliOutputFormat | undefined,
  stdoutIsTTY: boolean = Boolean(process.stdout.isTTY),
): boolean {
  if (format === 'text' || format === 'json') return true;
  return !stdoutIsTTY;
}

/** CSI / OSC / 单字符 ESC 序列 —— 与 sanitizeOutputLine 同一口径, 但保留换行与制表符 */
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** 去掉 ANSI 转义序列 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * 纯文本化: 去掉 ANSI 与其余控制字符, 保留 `\n` / `\t` / `\r`。
 * (`\r` 留着 —— 进度条那种 `\r` 覆盖在日志里仍然是有效信息, 只是不会画花终端。)
 */
export function toPlainText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return stripAnsi(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
}

/**
 * 把本进程的着色能力关掉。
 *
 * print 模式的输出本来就不该带颜色, 但下游模块 (diff 预览 / 状态文案) 可能用 chalk 拼串;
 * chalk 是按「进程启动时的 stdout」定 level 的, 管道下通常已经是 0 —— 但 `FORCE_COLOR=1`
 * (有些 CI 镜像、以及我们的 e2e 用例) 会把它强行打开。这里显式钉死。
 */
export function forcePlainColors(): void {
  try {
    chalk.level = 0;
  } catch { /* chalk 老版本可能只读, 忽略 */ }
  process.env.FORCE_COLOR = '0';
}
