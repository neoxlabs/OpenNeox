/**
 * 底栏那些压在 feed 上的东西怎么量 (useTimelineScrollController 的 --atl-feed-bottom-safe 用)。
 * 单独成文件是因为那个 hook 在文件体积棘轮上。
 */

export const DOCKED_MASCOT_SELECTOR = ".atl-bottom-float > .neox-mascot[data-docked='yes']:not([data-free='yes'])";

/** 小狗沿输入框走动 / 被拖动都是 translate —— 按布局位置量 (offsetTop 不含 translate),
 *  否则它一走留白就变、内容跟着跳 */
export function bottomChromeRect(node: HTMLElement): { top: number; bottom: number; height: number } {
  if (!node.classList.contains("neox-mascot")) return node.getBoundingClientRect();
  const parent = (node.offsetParent as HTMLElement | null)?.getBoundingClientRect();
  if (!parent) return node.getBoundingClientRect();
  const top = parent.top + node.offsetTop;
  return { top, bottom: top + node.offsetHeight, height: node.offsetHeight };
}

/** composer 是真正的 grid 底栏, 不整块计入 footer spacer; 小狗只按真实压进 feed 的高度算。
 *  服务条 / 子 agent / 审批条是"输入框上方浮层感"的 chrome, 要让最后一条内容能越过它们。 */
export function countsAsFloatingBar(node: HTMLElement): boolean {
  return !node.classList.contains("atl-composer") && !node.classList.contains("neox-mascot");
}
