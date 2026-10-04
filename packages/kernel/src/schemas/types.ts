/**
 * Provider / Model / Protocol schemas — TS types.
 *
 *   Mirror of the yaml shape in schemas/. zod validation lives in validate.ts.
 *   See docs/PROVIDER_SCHEMA_DESIGN.md for the architecture decision.
 */

export type Availability = 'ga' | 'preview' | 'hidden';
export type EffortLevel = string;

/* ───────────────────────────  Protocols  ─────────────────────────── */

export interface ProtocolSchema {
  id: string;
  display_name: string;
  spec?: string;
  api_path: string;
  auth: {
    scheme: 'bearer' | 'x-api-key';
    header: string;
    prefix?: string;
  };
  request_shape: {
    messages_field: string;
    tools_field: string;
    system_position: 'any' | 'top-of-messages' | 'separate-field';
    tool_use_shape?: 'openai-function' | 'anthropic-blocks' | 'gemini-function';
  };
  streaming: {
    format: 'sse';
    event_field: string;
    end_marker?: string;
  };
  required_headers?: Array<{ name: string; value: string }>;
  output_token_field:
    | string
    | { default: string; reasoning_models?: string };
}

/* ───────────────────────────  Providers  ─────────────────────────── */

export interface ProviderSchema {
  id: string;
  slug: string;
  display_name: string;
  status: 'active' | 'draft' | 'deprecated';
  base_url: string;
  protocol: string;       // FK → ProtocolSchema.id
  auth: {
    env: string;
    format: 'bearer' | 'x-api-key';
  };
  features?: {
    cache_control_passthrough?: boolean;
    cache_control_native?: boolean;
    prompt_cache_max_breakpoints?: number;
    reasoning_effort_passthrough?: boolean;
    verbosity_passthrough?: boolean;
    reasoning_blocks?: boolean;
    thinking_native?: boolean;
    tool_use_native?: boolean;
    prompt_cache_key_supported?: boolean;
    upstream_routing_by_slug_prefix?: Record<string, string>;
  };
  client_obligations?: {
    sanitize_system_order_for_families?: string[];
    inject_cache_control_for_families?: string[];
    inject_prompt_cache_key_for_families?: string[];
  };
}

/* ───────────────────────────  Models  ─────────────────────────── */

export interface ThinkingCapability {
  supported: boolean;
  field?: string;
  budget_unit?: 'tokens';
  min_budget?: number;
  max_budget?: number;
  /** 默认思考档 (effort_map key) — 用户不动 effort 时 adapter 据此默认开思考 */
  default_level?: EffortLevel;
}

export interface ReasoningEffortCapability {
  supported: boolean;
  field?: string;
  values?: string[];
  default?: string;
}

export interface PromptCacheCapability {
  supported: boolean;
  type?: 'ephemeral' | 'openai-prompt-cache' | 'gemini-context-cache';
  max_breakpoints?: number;
  breakpoint_targets?: Array<'tools_last' | 'system_first' | 'last_user_or_tool'>;
  key_field?: string;
}

export interface ModelCapabilities {
  vision?: boolean;
  tool_use?: boolean;
  reasoning_blocks?: boolean;
  thinking?: ThinkingCapability;
  reasoning_effort?: ReasoningEffortCapability;
  verbosity?: ReasoningEffortCapability; // shape happens to match
  prompt_cache?: PromptCacheCapability;
  uses_max_completion_tokens?: boolean;
  search_grounding_supported?: boolean;
}

export interface EffortMapEntry {
  /** 在某些 provider 下整个换 upstream slug (e.g. claude → fast 走 -fast 变种) */
  upstream_slug_override?: Record<string, string>;
  /** 透传到 payload 的字段, 不限制 schema (灵活, 留给后续 family-specific) */
  [field: string]: any;
}

export interface ModelSchema {
  id: string;
  display_name: string;
  family: string;
  vendor?: string;
  released?: string;
  availability: Availability;

  context_window: number;
  max_output_tokens: number;

  /** providerId → upstream model slug */
  upstream_slugs: Record<string, string>;

  capabilities?: ModelCapabilities;

  effort_map?: Partial<Record<EffortLevel, EffortMapEntry>>;

  pricing: {
    input_per_mtok: number;
    cached_input_per_mtok?: number;
    output_per_mtok: number;
    currency?: string;
  };
}

/* ───────────────────────────  Families  ─────────────────────────── */

/**
 * Family = 模型"血统"的能力声明 (claude / openai / gemini / kimi / glm / deepseek / ...).
 *
 * 用于:
 *   - 统一 family 识别 (替代代码侧分散的 if (lp.includes('xxx')) 链)
 *   - prompt supplement 路由 (which supplement_key)
 *   - markdown 约束路由 (which markdown_constraint)
 *   - effort 参数构造逻辑 (builder_hint)
 *   - explore 子 agent fast 变种识别 (fast_patterns)
 *
 * 见 schemas/families/*.yaml 和 docs/PROVIDER_SCHEMA_DESIGN.md.
 */
export interface FamilyCapabilities {
  thinking: {
    native: boolean;
    field?: string;
    /** 历史 assistant 消息里 reasoning_content 的出站回传策略 (chat-completions):
     *   with_tool_calls — 带 tool_calls 的 assistant 消息必须回传, 纯文本消息禁止回传
     *                     (DeepSeek thinking 协议双向 400 规则, 也是未声明时的默认)
     *   never — 一律剥掉
     *   always — 全量保留 CoT (GLM clear_thinking:false / Kimi keep:"all" 型需求) */
    passback?: 'with_tool_calls' | 'never' | 'always';
    /** 决定 effortController 用哪种构造逻辑:
     *   anthropic — { type, budget_tokens }
     *   openai_reasoning_effort — reasoning_effort: 'minimal'|'low'|'medium'|'high'
     *   gemini_thinking_budget — thinking_config: { thinking_budget: N }
     *   toggle — 简单 { type: 'enabled'|'disabled' } (kimi/deepseek)
     *   doubao_mode — thinking_mode: auto/enabled/disabled
     *   none — 不支持 */
    builder_hint?: 'anthropic' | 'openai_reasoning_effort' | 'gemini_thinking_budget' | 'toggle' | 'doubao_mode' | 'none';
  };
  reasoning_effort: {
    supported: boolean;
    field?: string;
    values?: string[];
    /** 同上, 对应 openai 类的 effort 控制 (跟 thinking 的 builder_hint 互斥, 二选一) */
    builder_hint?: 'openai_reasoning_effort';
  };
  parallel_tool_use: boolean;
  prompt_cache: boolean;
  structured_output: boolean;
  /** family 级 vision 默认值 (模型没有 per-model 声明时的兜底):
   *   true — 该 family 当代模型普遍支持图片输入 (claude/openai/gemini/xai)
   *   false — 该 family 默认纯文本, 个别 vision 型号靠 schemas/models/*.yaml per-model 覆盖
   *   缺省 — 未知, 交给名字启发式 (platform/modelCapabilities.ts) */
  vision?: boolean;
  tool_use_shape: 'openai-function' | 'anthropic-blocks' | 'gemini-function';
  fixed_temperature?: {
    enabled: boolean;
    models?: string[];
    value?: number;
  };
  search_grounding_supported?: boolean;
}

export interface FamilySchema {
  id: string;
  display_name: string;
  /** model name / provider id / protocol 字段 includes() 这些子串则归入本 family */
  aliases: string[];
  /** 补充正则识别 (aliases 不够时, e.g. o-series, codex, seed-*) */
  name_regex?: string[];
  capabilities: FamilyCapabilities;
  /** 引用 providerSupplements.ts 的 MD_RULES_* 常量 (kimi / deepseek_example / glm_terse / light) */
  markdown_constraint: 'kimi' | 'deepseek_example' | 'glm_terse' | 'light';
  /** 引用 providerSupplements.ts 的 *_SUPPLEMENT 常量名; null = 无补充 prompt */
  supplement_key: 'anthropic' | 'openai' | 'gemini' | 'deepseek' | 'glm' | 'kimi' | 'generic_parallel' | null;
  /** fast/cheap 变种正则模式 (字符串形式 "/pattern/flags") */
  fast_patterns?: string[];
}

/* ───────────────────────  Registry (in-memory)  ─────────────────────── */

export interface SchemaRegistry {
  protocols: ReadonlyMap<string, ProtocolSchema>;
  providers: ReadonlyMap<string, ProviderSchema>;
  models: ReadonlyMap<string, ModelSchema>;
  families: ReadonlyMap<string, FamilySchema>;

  resolveProtocol(id: string): ProtocolSchema | undefined;
  resolveProvider(id: string): ProviderSchema | undefined;
  resolveModel(id: string): ModelSchema | undefined;
  resolveFamily(id: string): FamilySchema | undefined;

  /** 单一 family 识别器 — 拿 model / provider / protocol 任一字段, 推出 family.
   *  替代原本散落 5 处的 if (lp.includes('anthropic') || lmodel.startsWith('claude')) 链. */
  detectFamily(input: {
    model?: string;
    provider?: string;
    protocol?: string;
  }): FamilySchema | null;

  /** 给定 model + provider, 拿 upstream slug (含 effort override) */
  resolveUpstreamSlug(
    modelId: string,
    providerId: string,
    effort?: EffortLevel,
  ): string | undefined;
}
