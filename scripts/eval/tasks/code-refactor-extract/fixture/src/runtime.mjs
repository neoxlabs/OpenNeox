const UNIT_MS = { ms: 1, s: 1000, m: 60000, h: 3600000 };

export function parseDuration(input) {
  const match = /^(\d+)(ms|s|m|h)$/.exec(String(input).trim());
  if (!match) throw new Error(`无法解析时长: ${input}`);
  return Number(match[1]) * UNIT_MS[match[2]];
}

export function formatCount(n) {
  return `${n} 项`;
}
