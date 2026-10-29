const MIRROR_PROPERTIES = [
  'boxSizing', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
  'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textTransform',
  'textAlign', 'direction', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom',
  'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
] as const;

/** A transient, local-only measurement. Never mutates the editor or retains its draft. */
export function getMascotCaretTarget(input: HTMLTextAreaElement): { x: number; y: number } {
  const rect = input.getBoundingClientRect();
  const end = input.selectionDirection === 'backward' ? input.selectionStart : input.selectionEnd;
  // Bound layout work for very large pasted prompts; exact wrapping is cosmetic here.
  if (end > 4096) return { x: rect.left + rect.width * .65, y: rect.top + Math.min(24, rect.height / 2) };
  const computed = getComputedStyle(input);
  const mirror = document.createElement('div');
  mirror.setAttribute('aria-hidden', 'true');
  Object.assign(mirror.style, {
    position: 'fixed', visibility: 'hidden', pointerEvents: 'none',
    left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`,
    height: 'auto', whiteSpace: input.wrap === 'off' ? 'pre' : 'pre-wrap',
    overflowWrap: 'break-word', wordBreak: 'normal', borderStyle: 'solid',
  });
  for (const property of MIRROR_PROPERTIES) mirror.style[property] = computed[property];
  mirror.textContent = input.value.slice(0, end);
  const marker = document.createElement('span');
  marker.textContent = '\u200b';
  mirror.append(marker);
  document.body.append(mirror);
  try {
    const caret = marker.getBoundingClientRect();
    return {
      x: Math.max(rect.left, Math.min(rect.right, caret.left - input.scrollLeft)),
      y: Math.max(rect.top, Math.min(rect.bottom, caret.top - input.scrollTop + caret.height / 2)),
    };
  } finally {
    mirror.remove();
  }
}
