/**
 * Where along the composer's top edge the mascot may stand.
 *
 * The mascot walks with a compositor translate on top of its docked home spot
 * (useMascotAnchor), so every offset here is relative to home: 0 = home, negative
 * = further left. It never stands where its face would cover real UI: the queued
 * prompt / approval strips stacked above the composer, or the empty-state greeting.
 */

export interface RoamRange {
  /** Viewport x of the mascot's left edge at home (layout position, no translate). */
  homeLeft: number;
  top: number;
  width: number;
  height: number;
  /** Allowed offsets, both ≤ 0. */
  min: number;
  max: number;
  obstacles: DOMRect[];
}

/** The part of the art that must not cover anything (head and paws, not the empty corners). */
function faceAt(range: RoamRange, offset: number) {
  const left = range.homeLeft + offset;
  return {
    left: left + range.width * .2,
    right: left + range.width * .8,
    top: range.top + range.height * .1,
    bottom: range.top + range.height * .9,
  };
}

function textRects(container: Element): DOMRect[] {
  const rects: DOMRect[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.textContent?.trim()) continue;
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) if (rect.width && rect.height) rects.push(rect);
  }
  return rects;
}

const TRANSPARENT = /^(transparent|rgba\(0, 0, 0, 0\))$/;

/**
 * What an element actually puts on screen. Docks above the composer are column-wide
 * wrappers with centring padding around a pill or a strip; only the pill / strip
 * (anything with a background, border or shadow, or text) is in the way.
 */
export function paintedRects(element: Element, depth = 0): DOMRect[] {
  const style = getComputedStyle(element);
  if (style.visibility === 'hidden' || style.display === 'none' || style.display === 'contents' && !element.children.length) return [];
  const rect = element.getBoundingClientRect();
  if (style.display !== 'contents' && (!rect.width || !rect.height)) return [];
  const painted = !TRANSPARENT.test(style.backgroundColor) || style.backgroundImage !== 'none'
    || style.boxShadow !== 'none' || parseFloat(style.borderTopWidth) > 0 || parseFloat(style.borderBottomWidth) > 0;
  if (painted || depth > 8) return [rect];
  if (!element.children.length) return textRects(element);
  const out: DOMRect[] = [];
  for (const child of element.children) out.push(...paintedRects(child, depth + 1));
  return out;
}

/** Everything stacked around the composer box (queued prompts, approvals, task pills, menus). */
export function crowdingRects(root: HTMLElement, scope: HTMLElement, box: Element): DOMRect[] {
  const out: DOMRect[] = [];
  for (let branch: Element | null = box; branch && branch !== scope && branch.parentElement; branch = branch.parentElement) {
    for (const sibling of branch.parentElement.children) {
      if (sibling === branch || sibling === root || sibling.contains(root)) continue;
      out.push(...paintedRects(sibling));
    }
  }
  return out;
}

export function measureRoamRange(root: HTMLElement, scope: HTMLElement): RoamRange | null {
  const box = scope.querySelector<HTMLElement>('.atl-composer__box');
  const parent = root.offsetParent as HTMLElement | null;
  if (!box || !parent || root.dataset.docked !== 'yes') return null;
  const origin = parent.getBoundingClientRect();
  const scale = origin.width / (parent.offsetWidth || origin.width || 1);
  const homeLeft = origin.left + root.offsetLeft * scale;
  const top = origin.top + root.offsetTop * scale;
  const width = root.offsetWidth * scale;
  const height = root.offsetHeight * scale;
  const edge = box.getBoundingClientRect();
  // Same things the anchor steps around.
  const obstacles = crowdingRects(root, scope, box);
  // The empty state's greeting: its words, not its (column-wide) box.
  const greeting = scope.closest('.atl-empty-stage')?.querySelector('.atl-empty-stage__top');
  if (greeting) obstacles.push(...textRects(greeting));
  // Paws stay on the box: the art's paws span ~.3–.7 of its width.
  const min = Math.min(0, edge.left - width * .28 - homeLeft);
  return { homeLeft, top, width, height, min, max: 0, obstacles };
}

function isFree(range: RoamRange, offset: number): boolean {
  const face = faceAt(range, offset);
  return !range.obstacles.some(r => r.left < face.right && r.right > face.left && r.top < face.bottom && r.bottom > face.top);
}

/** The allowed offset closest to `wanted` where nothing is covered (home if none). */
export function freeOffset(range: RoamRange, wanted: number): number {
  const target = Math.max(range.min, Math.min(range.max, wanted));
  if (isFree(range, target)) return target;
  for (let d = 8; d <= range.max - range.min; d += 8) {
    for (const candidate of [target + d, target - d]) {
      if (candidate >= range.min && candidate <= range.max && isFree(range, candidate)) return candidate;
    }
  }
  return 0;
}

/** Offset that puts the mascot's face just ahead of a viewport x (the caret). */
export function offsetForCaret(range: RoamRange, caretX: number): number {
  return caretX + range.width * .12 - (range.homeLeft + range.width / 2);
}
