/**
 * Neox Agent SDK · tool() helper
 *
 * 把 Zod schema + handler 打包成 core 的 Tool 形态. 核心职责:
 *   - Zod → JSONSchema 转换(Core 系统期望 JSONSchema)
 *   - 自动错误边界
 *   - 类型推导: handler 输入输出自动推导
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export interface ToolContext {
  signal: AbortSignal;
  logger: {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  /** 在工具里向 agent stream 推事件(高级用法) */
  emit?: (event: { type: string; [key: string]: unknown }) => void;
}

/**
 * zod-like schema 的结构约束。
 *
 * 只要求 schema 提供 safeParse，并从 zod v3 的 `_output` 或 v4 的
 * `_zod.output` 推导输入类型，以兼容两个主要版本。
 */
export interface ZodLikeSchema {
  safeParse: (data: unknown) => { success: boolean; data?: any; error?: any };
}

/** 从 zod v3 (`_output`) 或 v4 (`_zod.output`) 的类型标记里取出解析后的类型 */
export type InferSchema<S> = S extends { _zod: { output: infer O } }
  ? O
  : S extends { _output: infer O }
    ? O
    : unknown;

export interface ToolConfig<Input, Output> {
  name: string;
  description: string;
  schema: ZodLikeSchema;
  handler: (input: Input, ctx: ToolContext) => Promise<Output> | Output;
  /** 超时(ms),默认 60s */
  timeout?: number;
  /** 是否可以缓存结果(同输入返回同输出) */
  cacheable?: boolean;
  /** 标记为危险操作(permission:'auto' 下会被拒, 'ask' 下会要求确认) */
  dangerous?: boolean;
  /**
   * 声明这个工具只读, 不产生副作用。permission:'readonly' 下只有它为 true 的工具能跑。
   * 不声明时按 `!dangerous` 推断 —— 但显式声明永远更可靠。
   */
  readOnly?: boolean;
}

/**
 * SDK Tool 内部表示. 使用 any Input/Output 用于异构集合存储,
 * 创建时保留精确类型供类型推导.
 */
export interface NeoxSdkTool<Input = unknown, Output = unknown> {
  __kind: 'neox-sdk-tool';
  name: string;
  description: string;
  /** 是否为危险操作 (来自 config.dangerous) */
  dangerous: boolean;
  /** 是否只读 (来自 config.readOnly, 未声明时按 !dangerous 推断) */
  readOnly: boolean;
  /** Zod schema(运行时用于 validate) */
  schema: ZodLikeSchema;
  /** JSONSchema 形式的输入(LLM 看到的) */
  inputSchema: Record<string, unknown>;
  /** 包装后的 handler(自带错误边界和 timeout) */
  invoke: (input: Input, ctx: ToolContext) => Promise<Output>;
  /** 原始 config(SDK 内部备查) */
  config: ToolConfig<Input, Output>;
}

/**
 * 工具的类型擦除形态 —— 用于异构集合。
 *
 * 【为什么必须有】NeoxSdkTool<Input, Output> 的 invoke 让 Input 处于逆变位,
 * 所以 NeoxSdkTool<{a:string}> **不可赋值**给 NeoxSdkTool<unknown>。此前
 * AgentConfig.tools 写的是 NeoxSdkTool[](= NeoxSdkTool<unknown, unknown>[]),
 * 结果是任何带 Zod schema 的工具传进 new Agent({ tools }) 都报 TS2322 ——
 * README 的 "With Tools" 示例在 strict 下直接编译不过。
 * 集合类型一律用这个别名, 单个工具仍保留精确类型供 handler 推导。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyNeoxSdkTool = NeoxSdkTool<any, any>;

/**
 * 定义一个 SDK tool. 返回的对象可以直接放入 Agent({ tools: [...] }).
 *
 * @example
 *   const weather = tool({
 *     name: 'get_weather',
 *     description: 'Get weather for a city',
 *     schema: z.object({ city: z.string() }),
 *     handler: async ({ city }) => ({ temp: 22 }),
 *   });
 */
export function tool<S extends ZodLikeSchema, Output>(
  config: Omit<ToolConfig<InferSchema<S>, Output>, 'schema' | 'handler'> & {
    schema: S;
    handler: (input: InferSchema<S>, ctx: ToolContext) => Output | Promise<Output>;
  },
): NeoxSdkTool<InferSchema<S>, Output> {
  const inputSchema = zodToJsonSchemaLite(config.schema);
  const timeoutMs = config.timeout ?? 60_000;

  const invoke = async (input: InferSchema<S>, ctx: ToolContext): Promise<Output> => {
    let parsed = config.schema.safeParse(input);
    if (!parsed.success) {
      const normalized = normalizeNullishOptionalFields(input, config.schema);
      if (normalized !== input) parsed = config.schema.safeParse(normalized);
    }
    /* 通用回退: 上面那套读的是 zod v3 内部结构, v4 下不生效。LLM 经常给可选字段
     * 塞 null, zod 两个版本都把 null 当显式值而拒绝。这里不看 schema 内部, 直接
     * 把顶层 null 字段摘掉重试 —— 必填字段缺了照样报错, 语义不放松。 */
    if (!parsed.success && isPlainObject(input)) {
      const stripped: Record<string, unknown> = {};
      let dropped = false;
      for (const [k, v] of Object.entries(input)) {
        if (v === null) dropped = true;
        else stripped[k] = v;
      }
      if (dropped) parsed = config.schema.safeParse(stripped);
    }
    if (!parsed.success) {
      throw new Error(`Tool "${config.name}" input validation failed: ${parsed.error.message}`);
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`tool timeout ${timeoutMs}ms`)), timeoutMs);
    const mergedSignal = ctx.signal.aborted ? ctx.signal : anySignal([ctx.signal, ac.signal]);
    try {
      const result = await config.handler(parsed.data as InferSchema<S>, { ...ctx, signal: mergedSignal });
      return result;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    __kind: 'neox-sdk-tool',
    name: config.name,
    description: config.description,
    dangerous: config.dangerous ?? false,
    readOnly: config.readOnly ?? !config.dangerous,
    schema: config.schema,
    inputSchema,
    invoke,
    config: config as unknown as ToolConfig<InferSchema<S>, Output>,
  };
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Zod → JSONSchema 转换(P12b 接入 zod-to-json-schema).
 * LLM provider 看到的就是这个 JSONSchema,用于 function calling.
 */
function zodToJsonSchemaLite(schema: ZodLikeSchema): Record<string, unknown> {
  /* zod v4 的 schema 不被 zod-to-json-schema(v3 版)认识 —— 它自带 z.toJSONSchema().
   * 先走 v4 原生, 失败再退回 v3 库; 两条都不通就抛出可读的错误。 */
  const v4 = (schema as { toJSONSchema?: () => Record<string, unknown> }).toJSONSchema;
  if (typeof v4 === 'function') {
    try {
      const out = v4.call(schema) as Record<string, unknown>;
      const { $schema: _s, definitions: _d, ...rest } = out;
      return rest;
    } catch { /* 落到下面的 v3 路径 */ }
  }
  const full = zodToJsonSchema(schema as unknown as z.ZodType<unknown>, {
    target: 'openAi',           // 对 OpenAI / Anthropic tool schema 最兼容
    $refStrategy: 'none',        // 内联所有 ref(避免 $defs 跨工具冲突)
  });
  // zodToJsonSchema 默认包一层 $schema,剥掉:
  const { $schema: _, definitions: __, ...rest } = full as Record<string, unknown>;
  return rest;
}

/**
 * LLM tool calls often send `null` for omitted optional/defaulted fields.
 * Zod treats that as an explicit value, so `z.string().optional()` rejects it.
 * Only convert null when the target schema accepts undefined; required nulls
 * still fail validation normally.
 */
function normalizeNullishOptionalFields(input: unknown, schema: ZodLikeSchema): unknown {
  if (input === null && schema.safeParse(undefined).success) return undefined;
  /* 下面这段读的是 zod v3 的内部结构 (_def.typeName)。v4 没有这些字段, 会自然走到
   * default 分支原样返回 —— 只是少了 null→undefined 的兜底, 不影响正确性。 */
  const baseSchema = unwrapSchemaForNullNormalization(schema as unknown as z.ZodType<unknown>);
  const typeName = (baseSchema as z.ZodTypeAny)._def?.typeName;

  if (typeName === z.ZodFirstPartyTypeKind.ZodObject && isPlainObject(input)) {
    const objectSchema = baseSchema as z.AnyZodObject;
    const shape = objectSchema.shape;
    let changed = false;
    const out: Record<string, unknown> = { ...input };
    for (const [key, value] of Object.entries(input)) {
      const fieldSchema = shape[key] as z.ZodType<unknown> | undefined;
      if (!fieldSchema) continue;
      const next = normalizeNullishOptionalFields(value, fieldSchema);
      if (next !== value) {
        out[key] = next;
        changed = true;
      }
    }
    return changed ? out : input;
  }

  if (typeName === z.ZodFirstPartyTypeKind.ZodArray && Array.isArray(input)) {
    const elementSchema = (baseSchema as z.ZodArray<z.ZodTypeAny>).element as z.ZodType<unknown>;
    let changed = false;
    const out = input.map((value) => {
      const next = normalizeNullishOptionalFields(value, elementSchema);
      if (next !== value) changed = true;
      return next;
    });
    return changed ? out : input;
  }

  return input;
}

function unwrapSchemaForNullNormalization(schema: z.ZodType<unknown>): z.ZodType<unknown> {
  let current = schema as z.ZodTypeAny;
  for (;;) {
    const def = current._def;
    switch (def?.typeName) {
      case z.ZodFirstPartyTypeKind.ZodOptional:
      case z.ZodFirstPartyTypeKind.ZodNullable:
      case z.ZodFirstPartyTypeKind.ZodDefault:
      case z.ZodFirstPartyTypeKind.ZodCatch:
        current = def.innerType;
        continue;
      case z.ZodFirstPartyTypeKind.ZodEffects:
        current = def.schema;
        continue;
      default:
        return current as z.ZodType<unknown>;
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 合并多个 AbortSignal,任一触发则 abort. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const sig of signals) {
    if (sig.aborted) {
      controller.abort();
      return controller.signal;
    }
    sig.addEventListener('abort', onAbort, { once: true });
  }
  return controller.signal;
}
