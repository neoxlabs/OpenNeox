/**
 * modelLookup.ts — 「一个模型名怎么落到 schema 上」.
 *
 * Resolve model ids and provider slugs to schema metadata. Lookup proceeds from exact
 * declared names, through normalized candidates, to version-safe substring matches;
 * family fallback remains the caller's responsibility.

/** Strip a provider prefix (`provider:gpt-5.6-sol` -> `gpt-5.6-sol`). */
export function stripProviderPrefix(name: string): string {
  const colon = name.indexOf(':');
  if (colon <= 0 || colon >= name.length - 1) return name;
  return name.slice(colon + 1);
}

/** 只取路径最后一段 (`openai/gpt-5.6-sol` → `gpt-5.6-sol`). */
export function stripPathSegment(name: string): string {
  const slash = name.lastIndexOf('/');
  if (slash < 0 || slash >= name.length - 1) return name;
  return name.slice(slash + 1);
}

/** Normalize case, provider prefixes, and path segments for candidate generation. */
export function normalizeModelName(raw: string): string {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return '';
  return stripPathSegment(stripProviderPrefix(s)).trim();
}

/** 把 `gpt5.6` / `gpt_5_6` / `gpt-5-6` 这些写法折叠成同一个形状. */
export function canonicalizeSeparators(name: string): string {
  return (
    name
      /* 下划线一律当连字符 */
      .replace(/_/g, '-')
      /* 字母紧跟数字之间补连字符: gpt5.6 → gpt-5.6, o3mini → o3-mini 不动 (o+数字是型号本身) */
      .replace(/^([a-z]+?)(\d)/, (_m, a: string, d: string) => (a === 'o' ? `${a}${d}` : `${a}-${d}`))
      /* 版本号里的 -N- 折成 .N: gpt-5-6-sol → gpt-5.6-sol; 只折**数字之间**那一节 */
      .replace(/(\d)-(\d)/g, '$1.$2')
  );
}

/** 去掉日期 / 构建号 / 常见渠道后缀 —— 它们不改变模型身份. */
export function stripVariantSuffix(name: string): string {
  let s = name;
  /* - / -20260709 / @20260709 */
  s = s.replace(/[-@](\d{4}[-.]?\d{2}[-.]?\d{2}|\d{6,8})$/, '');
  /* Remove a trailing channel or effort tag after provider-prefix normalization. */
  s = s.replace(/:[a-z0-9.]+$/, '');
  /* 渠道 / 通道后缀: -preview -latest -exp -beta -stable -online -thinking, 可叠加 */
  for (let i = 0; i < 3; i++) {
    const next = s.replace(/[-:@](preview|latest|exp|experimental|beta|stable|online|search|thinking|nonthinking|chat)$/, '');
    if (next === s) break;
    s = next;
  }
  return s;
}

/* Only the explicitly listed channel and effort tags are ignorable; other suffixes
 * identify a different model. */

/** 渠道 / 通道标记 —— 同一个模型的不同入口. */
const CHANNEL_TAGS = [
  'preview', 'latest', 'exp', 'experimental', 'beta', 'stable', 'ga',
  'online', 'search', 'chat', 'instruct', 'turbo',
];

/** 推理档位标记 —— 中转常把档位写进模型名 (`gpt-6-high`), 仍是同一个模型. */
const EFFORT_TAGS = [
  'minimal', 'fast', 'low', 'medium', 'standard', 'high', 'xhigh', 'max', 'ultra',
  'thinking', 'nonthinking', 'nothinking', 'reasoning', 'think',
];

const IGNORABLE_TAGS = new Set([...CHANNEL_TAGS, ...EFFORT_TAGS]);

/** 日期 / 构建号: 20260709 ·  · 0709 · v3 */
function isBuildTag(tag: string): boolean {
  return /^\d{4}([-.]?\d{2}){0,2}$/.test(tag) || /^v\d+(\.\d+)*$/.test(tag);
}

/**
 * `query` 是不是 `key` 加上若干可忽略后缀.
 *
 * 允许: `gpt-5.6-sol-` / `gpt-5.6-sol-preview` / `gpt-6-high` / `gpt-6:beta`
 * 拒绝: `claude-opus-4-7` 被 `claude-opus-4` 命中 (版本续写);
 *       `glm-5.2-air` 被 `glm-5.2` 命中 (air 是另一个模型)。
 */
export function isVersionSafeMatch(query: string, key: string): boolean {
  if (query === key) return true;
  if (!query.startsWith(key)) return false;
  const rest = query.slice(key.length);
  /* 紧跟裸数字 = 更具体的型号 (gpt-5 vs gpt-56), 拒 */
  if (/^[0-9]/.test(rest)) return false;
  const sep = rest[0];
  if (sep !== '-' && sep !== '.' && sep !== ':' && sep !== '@' && sep !== '_') return false;
  /* 剩下的部分按分隔符切成若干 tag, 每个都必须是"可忽略"的 */
  const tags = rest.slice(1).split(/[-.:@_]/).filter(Boolean);
  if (tags.length === 0) return false;
  /* 日期被切成 2026 / 07 / 09 三段 —— 整段先试一次 */
  const whole = rest.slice(1);
  if (isBuildTag(whole)) return true;
  return tags.every((t) => IGNORABLE_TAGS.has(t) || isBuildTag(t));
}

/**
 * 一个名字的全部查找形态 —— 调用方按顺序试, 命中即停.
 *
 * 为什么是**交叉展开**而不是一条流水线: 冒号既可能是 provider 前缀
 * (`m5x:gpt-6`) 也可能是尾标 (`gpt-6:beta`), 斜杠也可能两者都有。按单一顺序
 * 处理必然吃掉一种写法 —— 第一版就是这么把 `gpt-5.6-sol:beta` 变成 `beta` 的。
 * 形态数量很小 (≤16), 每个都是 Map 查, 代价可以忽略。
 */
export function lookupCandidates(raw: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const v = (s ?? '').trim();
    if (v && !out.includes(v)) out.push(v);
  };
  const original = (raw ?? '').trim();
  push(original);
  const lower = original.toLowerCase();
  push(lower);

  /* 前缀 / 路径的四种剥法 */
  const bases = [
    lower,
    stripProviderPrefix(lower),
    stripPathSegment(lower),
    stripPathSegment(stripProviderPrefix(lower)),
  ];
  for (const base of bases) {
    for (const form of [base, stripVariantSuffix(base), canonicalizeSeparators(base), stripVariantSuffix(canonicalizeSeparators(base))]) {
      push(form);
    }
  }
  return out;
}

/**
 * 通用解析器 —— 三层依次试.
 *
 * @param raw     用户/上游给的名字 (可能带前缀、路径、日期、乱写的分隔符)
 * @param exact   精确查一个键 (registry 的 Map.get)
 * @param allKeys 全部已知键 (id + upstream_slugs), 用于第三层子串匹配
 */
export function resolveModelName<T>(
  raw: string,
  exact: (key: string) => T | undefined,
  allKeys: () => ReadonlyArray<{ key: string; value: T }>,
): T | undefined {
  if (!raw || !raw.trim()) return undefined;
  for (const candidate of lookupCandidates(raw)) {
    const hit = exact(candidate);
    if (hit) return hit;
  }
  /* 第三层: 已知键是查询名的版本安全子串。长键优先 = 最具体的赢
   * (gpt-5.4-mini 要在 gpt-5.4 之前) */
  const queries = lookupCandidates(raw).map(canonicalizeSeparators).filter(Boolean);
  if (queries.length === 0) return undefined;
  const sorted = [...allKeys()].sort((a, b) => b.key.length - a.key.length);
  for (const { key, value } of sorted) {
    /* 太短的键 (o1/o3) 子串误伤率高 —— 只让它们走前两层的精确匹配 */
    if (key.length < 4) continue;
    if (queries.some((q) => isVersionSafeMatch(q, key))) return value;
  }
  return undefined;
}
