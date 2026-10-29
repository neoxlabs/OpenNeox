/**
 * deliveryProvenance — 这个文件是**我们自己写的**吗? (work O-22 交付闸门用)
 *
 * 交付闸门不能拦用户自己带进来的文件: 他拿来一份本来就带 #REF! 的表要预览, 拦下来等于
 * “你的文件不让我看”。所以只有本次进程里被 Neox 的写工具写过的文件才进闸门;
 * 其余一律按外部文件处理 (只出报告, 不拦)。
 *
 * 怎么判定: 写盘成功后把当时的 mtime 记下来; 闸门检查时再 stat 一次,
 * 相同才算我们写的 (被 Excel 或用户改过之后 mtime 就变了 → 当作外部文件, 宁可少拦不误拦)。
 *
 * 这是个进程内登记表: 写工具与 open_surface 都跑在同一个 core 运行时里。
 */
import * as fs from 'node:fs';

const touched = new Map<string, number>();

/** 写盘之后调: 记下这个文件当前的 mtime, 声明它是本次进程写出来的。 */
export function markNeoxWritten(absPath: string): void {
  try {
    touched.set(absPath, fs.statSync(absPath).mtimeMs);
  } catch {
    /* 文件已经不在 (写完又删了) —— 当作已登记, 闸门那边自然读不到文件会报 unavailable */
    touched.set(absPath, -1);
  }
}

/** 这个文件是不是我们写的且没被外人改过。 */
export function isNeoxWritten(absPath: string): boolean {
  const at = touched.get(absPath);
  if (at === undefined) return false;
  if (at === -1) return true;
  try {
    return fs.statSync(absPath).mtimeMs === at;
  } catch {
    return false;
  }
}

/** 仅测试用: 清空登记表。 */
export function resetNeoxWrittenRegistry(): void {
  touched.clear();
}
