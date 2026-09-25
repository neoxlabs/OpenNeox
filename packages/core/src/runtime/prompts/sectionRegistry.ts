/**
 * Section Registry — 分层 Prompt 拼装 + cache 语义
 *
 * 设计目标 (对应 docs/prompt-harness-upgrade-plan.md §3):
 *
 *   1. **显式三层 cache 语义** — stable / context / volatile
 *      stable    = 会话内不变; 仅当 (workDir, model, language, hostCaps) 变才重建
 *      context   = 项目级变化触发重建 (AGENTS.md / workspace-roots / skills)
 *      volatile  = 每轮重建 (env-info / markdown-format / NEOX_APPEND_SYSTEM / CLI gui-correction)
 *
 *   2. **统一注入框架** — 现有散在 buildInstructions 大 if/else 里的 17 个拼装步骤
 *      用 registerSection 注册成 Section, 拼装走 buildPrompt 一处, cache 行为可观测.
 *
 *   3. **位置稳定 + 内容稳定** = cache 友好.
 *      位置由调用方控制的"注册顺序"决定 (不按 layer 自动重排), 现有
 *      buildInstructions 的 17 step 顺序得以 byte-for-byte 保留.
 *      layer 字段只影响 **cache 策略** (volatile 不缓存), 不影响输出位置.
 *      末尾高 recency 的 section (markdown / model identity / NEOX_APPEND_SYSTEM)
 *      靠在最后注册, 自然落在末尾.
 *
 *   4. **保持现有 buildInstructions 行为 100% 等价** — 注册的 section 输出的字符串
 *      与改造前的 buildInstructions 结果应 byte-for-byte 一致.
 *
 * 不在本模块管的事:
 *   - <system-reminder> 每轮注入 — 走 message stream, 见 runtime/systemReminder.ts
 *   - persistent memory / project memory — 见 runtime/projectMemory.ts
 *   - profile 切换 / promptStyle 选择 — 调用方 (systemPrompt.ts) 决定
 */

// ============================================================================
// 类型
// ============================================================================

export type SectionLayer = 'stable' | 'context' | 'volatile';

/**
 * Section compute 的输入. 与现有 InstructionsOptions 字段对齐, 加几个 derived 字段
 * (hostCapabilities / projectInstructionsHash) 由调用方在 buildPrompt 前预先填好.
 */
export interface SectionInput {
  /** 工作目录 (绝对路径). 一定要传. */
  workDir: string;
  /** 输出语言. 一定要传. */
  language: 'zh' | 'en';
  /** 协议 (anthropic/openai/gemini/deepseek/glm/kimi/...). 用于 provider supplement 命中. */
  protocol?: string;
  /** 具体 model id (用于 model identity / markdown 约束 family 识别). */
  model?: string;
  /** Provider base URL — 个别 family 识别按 baseUrl 子串. */
  baseUrl?: string;
  /** ProfileId — 显式指定 builtin profile. */
  profileId?: string;
  /** Prompt 风格: layered / codex_official / kimi / 其他 profile 自定义. */
  promptStyle?: string;
  /** 用途模式 (work 工作 / code 编码). 缺省按 code — 见 runtime/agentMode.ts. */
  agentMode?: 'work' | 'code';
  /** Host 能力 — gui:true 桌面端 / false CLI. 由调用方查 ToolServices 后传入. */
  hostCapabilities?: { gui?: boolean };
  /** Skip environment info (server 启动期 + agenticRuntime 单独注入 contextInjection 时用). */
  skipEnvironment?: boolean;
  /** 项目级 instructions 内容 hash — 用于 context 层 cache key. 不传则不参与 hash. */
  projectInstructionsHash?: string;
  /** Skills 注册表内容 hash — 同上. */
  skillsHash?: string;
  /** 知识库 L0 索引内容 hash — 同上. 卡片增删改才变. */
  knowledgeIndexHash?: string;
  /** profile.prompt.appendInstructions, 已 trim. 由 profile-append section 直接用. */
  profileAppendInstructions?: string;
  /**
   * 是否由 profile.fullInstructions 提供了完整 base prompt. true 时, layered base 段 (general-assistant
   * / universal-constraints / verification / service / skills / env / start-marker / profile-append)
   * 应该被 skip — 否则会与 fullInstructions 重复.
   *
   * post-processing section (edit-tool / browser / project / supplement / cli / markdown / identity
   * / NEOX_APPEND) 不受影响.
   */
  hasExternalBase?: boolean;
  /**
   * Legacy marker 探测用的"已存在文本". 调用方应在 buildPrompt 前组合 profile-append +
   * project-instructions 等外部来源的文本传入, 让那些自身可能含 'File tools:' / '### Markdown
   * 格式' / '你的底层模型是' 的 section 可以通过 enabledWhen 检测避免重复注入.
   *
   * 这是从 legacy buildInstructions 的 idempotent marker 检查 (`!result.includes(...)`) 平移过来,
   * 不进 cache key (只影响 enabledWhen).
   */
  precedingTextForLegacyCheck?: string;
}

/**
 * 单个 section 的计算函数. 返回 null/空串表示"本次不注入"(被 enabledWhen 跳过等价).
 */
export type SectionCompute = (input: SectionInput) => string | null;

/**
 * Section 定义. 注册顺序即拼装顺序 (同 layer 内).
 */
export interface PromptSection {
  /** 唯一标识. 用于 cache key / 调试 / listSections. 重复注册会覆盖. */
  name: string;
  /** 所属层. 决定拼装顺序和 cache 策略. */
  layer: SectionLayer;
  /** 计算函数. */
  compute: SectionCompute;
  /**
   * 缓存键参数: 哪些 input 字段会影响 compute 结果.
   *   - undefined / [] = 完全静态, 一次计算永不变 (典型: identity / universal-constraints)
   *   - ['workDir', 'language'] = workDir / language 变才重建
   *   - layer='volatile' 时此字段被忽略 (volatile 永不缓存)
   */
  cacheKeyFields?: (keyof SectionInput)[];
  /**
   * 启用条件. 返回 false 跳过 (不调用 compute, 不进结果). 默认 always true.
   */
  enabledWhen?: (input: SectionInput) => boolean;
  /**
   * 限制本 section 仅在哪几种 promptStyle 下注入. undefined = 所有 style 都注入.
   * 典型用法:
   *   - 'layered' 专属 (general-assistant / universal-constraints 等 base 段): ['layered']
   *   - codex_official 不要 (supplement / markdown / model-identity): ['layered', 'kimi']
   *   - 任何 style 都要 (edit-tool-override / project-instructions / cli-no-gui 等): undefined
   */
  injectInPromptStyle?: string[];
}

export interface BuildResult {
  /** 三层独立字符串 — 调用方可单独使用 (如调试 / cache 边界对齐). */
  stable: string;
  context: string;
  volatile: string;
  /** **按注册顺序** 拼接的完整 system prompt — \n\n 间隔. 这是真正喂给 LLM 的字符串. */
  full: string;
  /** 本次实际渲染的 section names (按拼装顺序). 用于调试 / 测试 / 监控. */
  sectionsRendered: string[];
  /** 本次 build 的 cache 命中统计. */
  cacheStats: { hits: number; misses: number };
}

// ============================================================================
// 内部状态
// ============================================================================

/* 注册的 section 列表. 保持注册顺序 — buildPrompt 按此顺序拼装 (同 layer 内).
 *  重复 name 时后注册覆盖前者 (允许调用方 hot-replace 调试)。 */
const SECTIONS: PromptSection[] = [];

/* cache: key = `${sectionName}::${JSON.stringify(cacheKeyValue)}`
 *  存 last compute 结果 (string | null). volatile 层永不入此 cache. */
const SECTION_CACHE = new Map<string, string | null>();

// ============================================================================
// API
// ============================================================================

/**
 * 注册一个 section.
 *
 * 同 name 重复注册会**覆盖**前者 (无 warning) — 这是有意的: 允许测试 / 调试 / hot-replace.
 * 生产代码不应当依赖这个行为, 注册一次即可.
 */
export function registerSection(section: PromptSection): void {
  if (!section.name) throw new Error('Section name required');
  if (!section.layer) throw new Error(`Section ${section.name}: layer required`);
  if (typeof section.compute !== 'function') {
    throw new Error(`Section ${section.name}: compute must be a function`);
  }

  const idx = SECTIONS.findIndex((s) => s.name === section.name);
  if (idx >= 0) {
    SECTIONS[idx] = section;
    /* 替换时清相关 cache, 否则旧值会被新 compute 误命中 */
    for (const k of SECTION_CACHE.keys()) {
      if (k.startsWith(`${section.name}::`)) SECTION_CACHE.delete(k);
    }
  } else {
    SECTIONS.push(section);
  }
}

/**
 * 拼装完整 prompt.
 *
 * 拼装顺序: **按注册顺序遍历**, 不按 layer 自动重排 (保留现有 buildInstructions 17 step 顺序).
 * - \`full\` = 按注册顺序所有非空 section 用 \\n\\n 连接 (实际喂 LLM 的字符串)
 * - \`stable\` / \`context\` / \`volatile\` = 同 layer 的 section 按注册顺序用 \\n\\n 连接
 *   (供调试 / cache 边界观测; 一般不直接用于喂 LLM)
 *
 * cache 策略:
 *   - layer='volatile': 每次都调 compute, 不入 cache
 *   - layer='stable' | 'context': 按 (sectionName, cacheKeyFields-derived hash) 缓存
 *     无 cacheKeyFields → 一次计算永不变
 *     有 cacheKeyFields → 这些字段值 JSON 化做 key, 命中复用
 */
export function buildPrompt(input: SectionInput): BuildResult {
  const orderedParts: string[] = [];   // 按注册顺序的非空文本 — 实际拼 full
  const stable: string[] = [];
  const context: string[] = [];
  const volatile: string[] = [];
  const rendered: string[] = [];
  let hits = 0;
  let misses = 0;

  for (const section of SECTIONS) {
    /* enabledWhen 跳过 */
    if (section.enabledWhen && !section.enabledWhen(input)) continue;

    /* injectInPromptStyle 限制 (undefined = 所有 style 都注入) */
    if (section.injectInPromptStyle && input.promptStyle &&
        !section.injectInPromptStyle.includes(input.promptStyle)) {
      continue;
    }

    let value: string | null;
    if (section.layer === 'volatile') {
      /* volatile: 每次都算 */
      value = section.compute(input);
    } else {
      /* stable / context: 走 cache */
      const cacheKey = makeCacheKey(section, input);
      if (SECTION_CACHE.has(cacheKey)) {
        value = SECTION_CACHE.get(cacheKey) ?? null;
        hits++;
      } else {
        value = section.compute(input);
        SECTION_CACHE.set(cacheKey, value);
        misses++;
      }
    }

    if (value === null || value === undefined) continue;
    const trimmed = value.trim();
    if (!trimmed) continue;

    rendered.push(section.name);
    orderedParts.push(trimmed);
    switch (section.layer) {
      case 'stable': stable.push(trimmed); break;
      case 'context': context.push(trimmed); break;
      case 'volatile': volatile.push(trimmed); break;
    }
  }

  return {
    stable: stable.join('\n\n'),
    context: context.join('\n\n'),
    volatile: volatile.join('\n\n'),
    full: orderedParts.join('\n\n'),
    sectionsRendered: rendered,
    cacheStats: { hits, misses },
  };
}

/**
 * 清除 cache. 不传 layer 清全部.
 *
 * 调用时机:
 *   - 用户 /clear 或 /compact (清全部)
 *   - workspace 切换 (清 context 即可, stable 跟 workDir 绑了 cache key 自己会失效)
 *   - hot-reload 测试 (清全部)
 */
export function clearSectionCache(layer?: SectionLayer): void {
  if (!layer) {
    SECTION_CACHE.clear();
    return;
  }
  /* 按 section 找 layer, 删 cache 项. 比按 key prefix 更安全 — section 改 layer 时 key 不会乱串. */
  const targetSections = new Set(SECTIONS.filter((s) => s.layer === layer).map((s) => s.name));
  for (const k of SECTION_CACHE.keys()) {
    const sectionName = k.split('::', 1)[0];
    if (targetSections.has(sectionName)) SECTION_CACHE.delete(k);
  }
}

/**
 * 列出当前注册的 section. 调试用. 返回快照 (修改不影响内部 state).
 */
export function listSections(): PromptSection[] {
  return SECTIONS.slice();
}

/**
 * 返回内部状态快照 (供 dev mode / 测试观测). 包括每个 section 的 cache 占用条数.
 */
export function getSectionDebugInfo(): Array<{
  name: string;
  layer: SectionLayer;
  cachedEntries: number;
}> {
  const result: Array<{ name: string; layer: SectionLayer; cachedEntries: number }> = [];
  for (const section of SECTIONS) {
    let count = 0;
    for (const k of SECTION_CACHE.keys()) {
      if (k.startsWith(`${section.name}::`)) count++;
    }
    result.push({ name: section.name, layer: section.layer, cachedEntries: count });
  }
  return result;
}

/**
 * 完全重置: 清 cache + 清注册. 仅用于测试 (生产代码不应当调).
 */
export function __resetForTests(): void {
  SECTIONS.length = 0;
  SECTION_CACHE.clear();
}

// ============================================================================
// 内部辅助
// ============================================================================

function makeCacheKey(section: PromptSection, input: SectionInput): string {
  const fields = section.cacheKeyFields ?? [];
  if (fields.length === 0) {
    /* 完全静态 — 全局一个 key */
    return `${section.name}::STATIC`;
  }
  /* 按字段名排序后取值 JSON 化, 保证 key 顺序无关 */
  const sorted = fields.slice().sort();
  const obj: Record<string, unknown> = {};
  for (const f of sorted) obj[f as string] = (input as unknown as Record<string, unknown>)[f as string];
  return `${section.name}::${JSON.stringify(obj)}`;
}
