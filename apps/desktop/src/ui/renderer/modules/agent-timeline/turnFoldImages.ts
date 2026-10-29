/**
 * 生图结果在「整轮折叠」里的位置。
 *
 * 【为什么单独一条】generate_image / edit_image 的产物是这一轮**真正的答案**, 不是过程。
 * 轮次封口后折叠条只写「做好了 · 26 秒 · 1 步」, 图要是跟着 middle 一起折进去,
 * 用户就得先想到去点开才看得见 —— 生图这件事的价值全在那张图上。
 *
 * 顺序也有讲究: 折叠条 → 回答正文 → 图。图跟在正文后面读起来才是"说完了, 这是图";
 * 摆在正文前面会把那句"画好了"和产物隔开。
 *
 * 纯字符串/结构判断, 不 import timelineRows —— 那边要 import 本文件, 避免循环依赖。
 */
/* 答案型工具卡跟生图同档 (折叠时留在外面) —— 从这里转出去, timelineRows 不用多一行 import */
export { isAnswerToolCard } from './toolCards/toolCardTypes';

type ContentOf = (step: unknown) => { type?: string; card?: { kind?: string }; changes?: Array<{ path?: string }> } | undefined;
const OFFICE_EXT = /\.(pptx?|key|xlsx?|csv|docx?|pdf)$/i;
export function turnMakesFile(rows: ReadonlyArray<{ kind: string }>, contentOf: ContentOf): boolean {
  const isFile = (s: unknown) => {
    const c = contentOf(s);
    return c?.type === 'office' || (c?.type === 'tool_card' && c.card?.kind === 'slides')
      /* 本轮改动汇总 (尾部的成品卡) 里有演示稿 / 表格 / 文档 */
      || (c?.type === 'turn_summary' && !!c.changes?.some((x) => OFFICE_EXT.test(x.path ?? '')));
  };
  const visit = (list: ReadonlyArray<any>): boolean => list.some((r) =>
    r.kind === 'single' ? isFile(r.step)
      : r.kind === 'group' || r.kind === 'cluster' ? (r.items as unknown[]).some(isFile)
        : Array.isArray(r.rows) ? visit(r.rows) : false);
  return visit(rows);
}

/** content kind 提示 (rowStepContentTypeHint 的结果) 是不是生图产物。 */
export function rowStepIsGeneratedImage(hint: string | undefined): boolean {
  return hint === "image";
}

/**
 * 把生图行插到尾部连续 message 之后 (turn_summary 这类卡片之前)。
 * 尾部没有 message 时插在最后 —— 至少别把它丢回折叠组里。
 */
export function spliceImagesAfterAnswer<T extends { kind: string }>(
  tailRows: T[],
  images: T[],
): T[] {
  if (images.length === 0) return tailRows;
  const firstNonMessage = tailRows.findIndex((r) => r.kind !== "message");
  const at = firstNonMessage === -1 ? tailRows.length : firstNonMessage;
  return [...tailRows.slice(0, at), ...images, ...tailRows.slice(at)];
}
