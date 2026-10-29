export function pad(text, width, options = {}) {
  const side = options.side === 'left' ? 'left' : 'right';
  const fill = options.fill ?? ' ';
  const value = String(text);
  const missing = Math.max(0, width - value.length);
  return side === 'left' ? fill.repeat(missing) + value : value + fill.repeat(missing);
}

export function truncate(text, max, options = {}) {
  const chars = [...String(text)];
  if (chars.length <= max) return String(text);
  const suffix = options.suffix ?? '…';
  return chars.slice(0, Math.max(0, max - [...suffix].length)).join('') + suffix;
}
