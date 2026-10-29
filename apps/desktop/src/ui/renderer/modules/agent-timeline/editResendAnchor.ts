
/** 只依赖这两个字段, 免得测试要造完整的 TimelineEntry */
export interface AnchorEntry {
  id?: string;
  type?: string;
}

/**
 * @returns k (>= 1); 锚点不在列表里、或它本身不是用户消息时返回 -1 —— 调用方必须中止。
 *
 * 锚点自己必须是 user_message: 这颗按钮只挂在用户气泡上, 传进来别的 type 就是调用方错了,
 * 与其"猜一个最近的用户消息"不如直接拒 —— 猜错就是裁错位置, 而裁错是不可逆的。
 */
export function userMessageIndexFromEnd(entries: readonly AnchorEntry[], anchorId: string): number {
  if (!anchorId) return -1;
  const idx = entries.findIndex((e) => e?.id === anchorId);
  if (idx < 0) return -1;
  if (entries[idx]?.type !== 'user_message') return -1;
  let k = 0;
  for (let i = entries.length - 1; i >= idx; i--) {
    if (entries[i]?.type === 'user_message') k += 1;
  }
  return k;
}
