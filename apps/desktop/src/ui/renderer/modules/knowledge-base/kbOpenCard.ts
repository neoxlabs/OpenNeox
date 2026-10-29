/* 从别处 (侧栏工具托盘的知识库小面板) 要求知识库页展开某张卡。
 * 页面可能还没开 —— 先把 id 放 localStorage, 页面挂载时读走; 已经开着就靠事件。 */
export const KB_OPEN_CARD_KEY = 'neox.kb.open-card';

export function requestOpenKbCard(id: string): void {
  try { localStorage.setItem(KB_OPEN_CARD_KEY, id); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent('neox:kb-open-card', { detail: { id } }));
}
