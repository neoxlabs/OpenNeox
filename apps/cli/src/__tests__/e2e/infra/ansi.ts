import stringWidth from 'string-width';

/** 去掉 ANSI 控制序列 (颜色 / 光标移动 / OSC 标题). */
export function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\x1b[=><]/g, '')
    .replace(/\x1b[78]/g, '');
}

/** 每个换行 / 回车分段的可打印显示宽度 (中文按 2 列算). */
export function lineWidths(input: string): number[] {
  const clean = stripAnsi(input);
  const segments: string[] = [];
  for (const line of clean.split('\n')) {
    for (const part of line.split('\r')) segments.push(part);
  }
  return segments.map((s) => stringWidth(s));
}

export function maxLineWidth(input: string): number {
  const widths = lineWidths(input);
  return widths.length > 0 ? Math.max(...widths) : 0;
}

/** 只留可读文本, 给失败信息用. */
export function printable(input: string, limit = 1500): string {
  const clean = stripAnsi(input).replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n');
  return clean.length > limit ? clean.slice(-limit) : clean;
}
