/**
 * Schema validation — zod runtime checks. Used by loader.ts at startup +
 *   by CI lint script.
 *
 *   Philosophy: be **strict on required fields** so PR review can rely on the
 *   yaml being well-formed. Be **permissive on `effort_map` payload fields**
 *   since they pass through to wildly different upstreams.
 */

import { z } from 'zod';
import type {
  FamilySchema,
  ModelSchema,
  ProtocolSchema,
  ProviderSchema,
} from './types.js';

const idLike = z.string().min(2).max(64);

/* ───────────────────────────  Protocol  ─────────────────────────── */

const protocolZ = z.object({
  id: idLike,
  display_name: z.string().min(1),
  spec: z.string().url().optional(),
  api_path: z.string().startsWith('/'),
  auth: z.object({
    scheme: z.enum(['bearer', 'x-api-key']),
    header: z.string().min(1),
    prefix: z.string().optional(),
  }),
  request_shape: z.object({
    messages_field: z.string().min(1),
    tools_field: z.string().min(1),
    system_position: z.enum(['any', 'top-of-messages', 'separate-field']),
    tool_use_shape: z.enum(['openai-function', 'anthropic-blocks', 'gemini-function']).optional(),
  }),
  streaming: z.object({
    format: z.literal('sse'),
    event_field: z.string().min(1),
    end_marker: z.string().optional(),
  }),
  required_headers: z.array(z.object({
    name: z.string().min(1),
    value: z.string().min(1),
  })).optional(),
  output_token_field: z.union([
    z.string().min(1),
    z.object({
      default: z.string().min(1),
      reasoning_models: z.string().min(1).optional(),
    }),
  ]),
});

export function validateProtocol(raw: unknown): ProtocolSchema {
  return protocolZ.parse(raw) as ProtocolSchema;
}

/* ───────────────────────────  Provider  ─────────────────────────── */

const providerZ = z.object({
  id: idLike,
  slug: idLike,
  display_name: z.string().min(1),
  status: z.enum(['active', 'draft', 'deprecated']),
  base_url: z.string().url(),
  protocol: idLike,
  auth: z.object({
    env: z.string().min(1),
    format: z.enum(['bearer', 'x-api-key']),
  }),
  features: z.object({
    cache_control_passthrough: z.boolean().optional(),
    cache_control_native: z.boolean().optional(),
    prompt_cache_max_breakpoints: z.number().int().positive().optional(),
    reasoning_effort_passthrough: z.boolean().optional(),
    verbosity_passthrough: z.boolean().optional(),
    reasoning_blocks: z.boolean().optional(),
    thinking_native: z.boolean().optional(),
    tool_use_native: z.boolean().optional(),
    prompt_cache_key_supported: z.boolean().optional(),
    upstream_routing_by_slug_prefix: z.record(z.string(), z.string()).optional(),
  }).optional(),
  client_obligations: z.object({
    sanitize_system_order_for_families: z.array(z.string()).optional(),
    inject_cache_control_for_families: z.array(z.string()).optional(),
    inject_prompt_cache_key_for_families: z.array(z.string()).optional(),
  }).optional(),
});

export function validateProvider(raw: unknown): ProviderSchema {
  return providerZ.parse(raw) as ProviderSchema;
}

/* ───────────────────────────  Model  ─────────────────────────── */

const effortMapEntryZ = z.record(z.string(), z.any()).optional();

const modelZ = z.object({
  id: z.string().min(2).max(96),
  display_name: z.string().min(1),
  family: z.string().min(1),
  vendor: z.string().optional(),
  /* yaml `released: ` 被 js-yaml 解析成 Date — 接受两种, 内部转 ISO string. */
  released: z.union([z.string(), z.date()]).transform((v) => v instanceof Date ? v.toISOString().slice(0, 10) : v).optional(),
  availability: z.enum(['ga', 'preview', 'hidden']),

  context_window: z.number().int().min(8192),
  max_output_tokens: z.number().int().min(256),

  upstream_slugs: z.record(z.string(), z.string()).refine(
    (r) => Object.keys(r).length > 0,
    { message: 'upstream_slugs must have at least one entry' },
  ),

  capabilities: z.object({
    vision: z.boolean().optional(),
    tool_use: z.boolean().optional(),
    reasoning_blocks: z.boolean().optional(),
    thinking: z.object({
      supported: z.boolean(),
      field: z.string().optional(),
      budget_unit: z.literal('tokens').optional(),
      min_budget: z.number().int().nonnegative().optional(),
      max_budget: z.number().int().positive().optional(),
      /* 用户不动 effort 档时的默认思考档 (必须是 effort_map 的 key)。
       * 声明它 = "这个模型默认应该思考"; 缺省时由 resolveDefaultThinkingLevel 启发挑选。 */
      default_level: z.string().optional(),
    }).optional(),
    reasoning_effort: z.object({
      supported: z.boolean(),
      field: z.string().optional(),
      values: z.array(z.string()).optional(),
      default: z.string().optional(),
    }).optional(),
    verbosity: z.object({
      supported: z.boolean(),
      field: z.string().optional(),
      values: z.array(z.string()).optional(),
      default: z.string().optional(),
    }).optional(),
    prompt_cache: z.object({
      supported: z.boolean(),
      type: z.enum(['ephemeral', 'openai-prompt-cache', 'gemini-context-cache']).optional(),
      max_breakpoints: z.number().int().positive().optional(),
      breakpoint_targets: z.array(z.enum(['tools_last', 'system_first', 'last_user_or_tool'])).optional(),
      key_field: z.string().optional(),
    }).optional(),
    uses_max_completion_tokens: z.boolean().optional(),
    search_grounding_supported: z.boolean().optional(),
  }).optional(),

  effort_map: z.record(z.string(), effortMapEntryZ).optional(),

  pricing: z.object({
    input_per_mtok: z.number().positive(),
    cached_input_per_mtok: z.number().nonnegative().optional(),
    output_per_mtok: z.number().positive(),
    currency: z.string().optional(),
  }),
});

export function validateModel(raw: unknown): ModelSchema {
  return modelZ.parse(raw) as ModelSchema;
}

/* ───────────────────────────  Family  ─────────────────────────── */

const familyCapabilitiesZ = z.object({
  thinking: z.object({
    native: z.boolean(),
    field: z.string().optional(),
    builder_hint: z.enum(['anthropic', 'openai_reasoning_effort', 'gemini_thinking_budget', 'toggle', 'doubao_mode', 'none']).optional(),
    passback: z.enum(['with_tool_calls', 'never', 'always']).optional(),
  }),
  reasoning_effort: z.object({
    supported: z.boolean(),
    field: z.string().optional(),
    values: z.array(z.string()).optional(),
    builder_hint: z.literal('openai_reasoning_effort').optional(),
  }),
  parallel_tool_use: z.boolean(),
  prompt_cache: z.boolean(),
  structured_output: z.boolean(),
  vision: z.boolean().optional(),
  tool_use_shape: z.enum(['openai-function', 'anthropic-blocks', 'gemini-function']),
  fixed_temperature: z.object({
    enabled: z.boolean(),
    models: z.array(z.string()).optional(),
    value: z.number().optional(),
  }).optional(),
  search_grounding_supported: z.boolean().optional(),
});

const familyZ = z.object({
  id: idLike,
  display_name: z.string().min(1),
  aliases: z.array(z.string().min(1)).min(1),
  name_regex: z.array(z.string().min(1)).optional(),
  capabilities: familyCapabilitiesZ,
  markdown_constraint: z.enum(['kimi', 'deepseek_example', 'glm_terse', 'light']),
  supplement_key: z.enum(['anthropic', 'openai', 'gemini', 'deepseek', 'glm', 'kimi', 'generic_parallel']).nullable(),
  fast_patterns: z.array(z.string().min(1)).optional(),
});

export function validateFamily(raw: unknown): FamilySchema {
  return familyZ.parse(raw) as FamilySchema;
}
