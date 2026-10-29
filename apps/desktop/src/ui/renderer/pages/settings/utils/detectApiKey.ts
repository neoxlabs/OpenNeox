/* 「粘一个 Key 就知道是哪家」—— 添加服务商第一屏的识别逻辑。
 *
 * 用户手里最常见的不是"我要加 DeepSeek", 而是"我有一串 key"。让他先读一墙厂商卡
 * 再回忆这串 key 是谁家的, 是把我们该做的判断推给了他。大多数厂商的 key 前缀是公开的,
 * 认得出就直接跳到填好的表单, 认不准 (sk- 开头的一大家子) 就只亮出候选。
 *
 * 只认前缀/形状, 不发请求 —— 真正是否可用由表单里的自动拉模型去验。 */

export type PastedKind = 'key' | 'url' | 'text';

export interface PasteDetection {
  kind: PastedKind;
  /** 清洗后的值: 去引号 / 去 Bearer / 去 `KEY=` 前缀 / 去空白 */
  value: string;
  /** 可能的 preset id, 按可能性排序。唯一且 confident 时可直接选中。 */
  candidates: string[];
  confident: boolean;
}

/** 用户粘过来的往往不是干净的 key: 整行 env、带引号、带 Bearer、行尾换行。 */
export function cleanPastedSecret(raw: string): string {
  let s = (raw || '').trim();
  // export OPENAI_API_KEY="sk-..." / OPENAI_API_KEY=sk-... / "api_key": "sk-..."
  const assign = s.match(/^(?:export\s+)?["']?[A-Za-z_][A-Za-z0-9_]*["']?\s*[=:]\s*(.+)$/);
  if (assign && !/^https?:\/\//i.test(s)) s = assign[1]!.trim();
  s = s.replace(/[,;]+$/, '').replace(/^["'`]+|["'`]+$/g, '').trim();
  s = s.replace(/^Bearer\s+/i, '').trim();
  return s.replace(/\s+/g, '');
}

const KEY_RULES: Array<{ test: RegExp; ids: string[] }> = [
  { test: /^sk-or-/, ids: ['openrouter'] },
  { test: /^sk-ant-/, ids: ['anthropic'] },
  { test: /^AIza[0-9A-Za-z_-]{20,}$/, ids: ['gemini'] },
  { test: /^xai-/, ids: ['grok'] },
  { test: /^gsk_/, ids: ['groq'] },
  { test: /^sk-(proj|svcacct|admin)-/, ids: ['openai'] },
  /* 智谱: 32 位 hex + . + 16 位 */
  { test: /^[0-9a-f]{32}\.[0-9A-Za-z]{10,}$/, ids: ['glm'] },
  /* 火山方舟: UUID */
  { test: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, ids: ['doubao'] },
  /* MiniMax: JWT */
  { test: /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/, ids: ['minimax'] },
  /* DeepSeek / 百炼: sk- + 32 位 hex —— 两家长得一样, 只能给候选 */
  { test: /^sk-[0-9a-f]{32}$/, ids: ['deepseek', 'dashscope'] },
  /* 其余 sk- : OpenAI 老格式 / Kimi / opencode / 各种中转 */
  { test: /^sk-/, ids: ['openai', 'kimi', 'deepseek', 'dashscope', 'opencode'] },
];

export function detectPasted(raw: string): PasteDetection {
  const trimmed = (raw || '').trim();
  if (/^https?:\/\/\S+$/i.test(trimmed)) {
    return { kind: 'url', value: trimmed, candidates: [], confident: false };
  }
  const value = cleanPastedSecret(trimmed);
  /* 短于 16 的多半是在搜厂商名, 不是 key */
  if (value.length < 16 || /[一-鿿]/.test(value)) {
    return { kind: 'text', value: trimmed, candidates: [], confident: false };
  }
  for (const rule of KEY_RULES) {
    if (rule.test.test(value)) {
      return { kind: 'key', value, candidates: rule.ids, confident: rule.ids.length === 1 };
    }
  }
  /* 长串、无空格、像 token —— 是 key 但认不出是谁家的 (Mistral / Together 这类随机串) */
  if (/^[\w.-]{24,}$/.test(value)) {
    return { kind: 'key', value, candidates: [], confident: false };
  }
  return { kind: 'text', value: trimmed, candidates: [], confident: false };
}

/** preset.authHint 形如 "https://platform.openai.com/api-keys · 格式 sk-..." */
export function parseAuthHint(authHint: string | undefined): { keyUrl?: string; format?: string } {
  if (!authHint) return {};
  const [head, ...rest] = authHint.split(' · ');
  const keyUrl = /^https?:\/\//.test(head || '') ? head!.trim() : undefined;
  const fmt = rest.join(' · ').replace(/^格式\s*/, '').trim();
  return { keyUrl, format: fmt || undefined };
}
