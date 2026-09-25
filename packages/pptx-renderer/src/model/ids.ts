/**
 * ids — 稳定 anchor id 生成器.
 * 对齐 Codex inspect() 的心智: 每 shape / slide / layout 有可追踪的稳定 id,
 * 未来 validator / QA / undo 都可以按 id 索引.
 *
 * 生成规则: 计数器 + prefix, isomorphic (Node/Browser).
 */

let counter = 0;

export function nextId(prefix: string): string {
  counter++;
  return `${prefix}${counter}`;
}

export function slideId(): string { return nextId('sld'); }
export function shapeId(): string { return nextId('sp'); }
export function imageId(): string { return nextId('pic'); }
export function layoutId(): string { return nextId('lyt'); }
export function masterId(): string { return nextId('mst'); }
export function placeholderId(): string { return nextId('ph'); }

/** OOXML 里 shape 的数字 id (`<p:cNvPr id="N">`). 全 pptx 唯一, 每 slide 内递增. */
let ooxmlNumId = 1;
export function nextOoxmlId(): number {
  ooxmlNumId++;
  return ooxmlNumId;
}
export function resetOoxmlId(): void { ooxmlNumId = 1; }
