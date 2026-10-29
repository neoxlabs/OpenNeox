
/**
 * 一个 UI model id 对应的 schema 查找候选, 按优先级排列。
 *
 * 先试原样 (yaml 里真有带冒号的 id 时不至于被误剥), 再试剥掉第一段 provider 前缀。
 * 模型名本身含冒号的情况按"只剥第一段"处理 —— 前缀只有一层。
 */
export function schemaLookupCandidates(modelId: string): string[] {
  const id = (modelId ?? '').trim();
  if (!id) return [];
  const out = [id];
  const i = id.indexOf(':');
  /* i > 0: 冒号在开头说明没有 provider 段; i < len-1: 冒号在结尾说明没有模型名 */
  if (i > 0 && i < id.length - 1) {
    const bare = id.slice(i + 1);
    if (bare !== id) out.push(bare);
  }
  for (const name of [...out]) {
    const base = name.replace(/-(promo|eco)$/, '');
    if (base !== name && !out.includes(base)) out.push(base);
  }
  for (const name of [...out]) {
    if (/^mimo-/.test(name) && !out.includes(`xiaomi/${name}`)) out.push(`xiaomi/${name}`);
  }
  return out;
}

/** 按候选顺序解析, 命中即返回。resolve 拿不到就返回 null。 */
export function resolveSchemaModel<T>(
  modelId: string,
  resolve: (id: string) => T | undefined,
): T | null {
  for (const candidate of schemaLookupCandidates(modelId)) {
    const hit = resolve(candidate);
    if (hit) return hit;
  }
  return null;
}

const EFFORT_ORDER = [
  'off', 'fast', 'minimal', 'low',
  'auto', 'on', 'standard', 'medium',
  'deep', 'high', 'xhigh', 'max', 'ultra',
] as const;

export function sortEffortLevels(levels: readonly string[]): string[] {
  const idx = (l: string) => {
    const i = EFFORT_ORDER.indexOf(l as typeof EFFORT_ORDER[number]);
    return i === -1 ? EFFORT_ORDER.length : i;
  };
  return [...levels].sort((a, b) => (idx(a) - idx(b)) || a.localeCompare(b));
}

/** 供测试断言用: yaml 里出现过的键有没有漏进 EFFORT_ORDER */
export const KNOWN_EFFORT_LEVELS: readonly string[] = EFFORT_ORDER;
