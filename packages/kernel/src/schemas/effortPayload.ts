/**
 * resolveEffortPayload — schema.effort_map[level] 真生效的单一入口
 *
 *  D13 创建. 目的:
 *   - 在此之前只有 openai.ts 把 yaml effort_map 字段 spread 进 payload, 其他 adapter
 *     (anthropic / gemini / kimi / glm / doubao) 收到 effortLevel 也是无视。yaml 改了
 *     billing_multiplier 但代码端 thinking budget 仍硬编码(effortController.ts EFFORT_MAPPINGS)
 * — 用户看到的 1.5× 跟实际生效完全不一致。
 *   - 本 helper 抽出"读 yaml + 排掉 meta 字段 + spread"的逻辑, 任一 adapter 都能调一行,
 *     yaml 即真相源。
 *
 *   yaml 字段语义:
 *     effort_map[<level>]:
 *       upstream_slug_override: { prov_x: "..." }  ← META, 由 resolveUpstreamSlug 处理
 *       billing_multiplier: <number>                ← META, 服务端计费用
 *       <native_field>: <native_value>              ← 其他都当 native payload 字段 spread
 *
 *   e.g. claude-opus-4-8.yaml:
 *     effort_map:
 *       high: { thinking: { type: adaptive }, output_config: { effort: high } }
 *       max:  { thinking: { type: adaptive }, output_config: { effort: max } }
 *
 *   e.g. gemini-3.1-pro.yaml:
 *     effort_map:
 *       fast:     { thinking_config: { thinking_budget: 0    } }
 *       deep:     { thinking_config: { thinking_budget: 8192 } }
 *
 *   helper 返回 spread 用的 partial payload:
 *     resolveEffortPayload('claude-opus-4-8', 'high') =
 *       { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }
 *     resolveEffortPayload('gemini-3.1-pro', 'deep')  = { thinking_config: { thinking_budget: 8192 } }
 */

import { getSchemaRegistry } from './loader.js';

const META_KEYS = new Set(['upstream_slug_override', 'billing_multiplier']);

export interface ResolveEffortPayloadResult {
  /** spread 进 payload 的字段; 没找到 model / level 时为空对象 */
  payload: Record<string, unknown>;
  /** 该 model 在指定 provider 下的 upstream slug override (e.g. claude-opus-4.8-fast).
   *  null = 没有 override, 调用方继续用 model.upstream_slugs[providerId]. */
  upstreamSlugOverride: string | null;
  /** 计费倍率 — 仅供 UI 显示和 telemetry, payload 不带 (网关侧负责扣点). */
  billingMultiplier: number | null;
}

/**
 * 主入口. effortLevel 为 falsy / model 不在 schema 中 / level 不存在 → 返回空 payload (无副作用).
 * providerId 用来挑 upstream_slug_override 桶, 不传则跳过 override 解析.
 */
export function resolveEffortPayload(
  modelId: string,
  effortLevel: string | undefined,
  providerId?: string,
): ResolveEffortPayloadResult {
  const empty: ResolveEffortPayloadResult = {
    payload: {},
    upstreamSlugOverride: null,
    billingMultiplier: null,
  };
  if (!effortLevel) return empty;
  /* Schema-loading failures propagate; an absent model payload remains an ordinary
   * empty result. */
  const schema = getSchemaRegistry().resolveModel(modelId);
  let resolvedLevel = effortLevel;
  let entry: any = schema?.effort_map?.[effortLevel];

  /* Map an unsupported requested level to the nearest declared level by strength. */
  if (schema?.effort_map && !entry) {
    const ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'max'];
    const want = ORDER.indexOf(effortLevel);
    const available = Object.keys(schema.effort_map)
      .map((k) => ({ key: k, idx: ORDER.indexOf(k) }))
      .filter((x) => x.idx >= 0);

    if (want >= 0 && available.length > 0) {
      const nearest = available.reduce((best, cur) =>
        Math.abs(cur.idx - want) < Math.abs(best.idx - want) ? cur : best);
      resolvedLevel = nearest.key;
      entry = schema.effort_map[nearest.key];
    }

    if (!entry) {
      // eslint-disable-next-line no-console
      console.warn(`[schemas] effortLevel "${effortLevel}" not in effort_map of "${modelId}" (levels: ${Object.keys(schema.effort_map).join('/')}) — ignored`);
    }
  }
  void resolvedLevel;
  /* ── 没有 per-model effort_map 时按 family 声明构造  ────────
   *
   * 需求： 「适配最新模型 gpt6 等 … 不然用户 byok 等订阅都不支持」。
   * 刚出的模型没有 schemas/models/*.yaml, 于是这里返回空 payload ——
   * 而 UI 那边 (family 兜底) 已经把思考开关渲出来了。两边一凑就是**假开关**:
   * 用户关了思考照样在想, 点了档位什么都不发。这个仓库对"假开关"有明确判词
   * (useSchemaModelInfo 的注释), 所以两边必须一起补。
   *
   * 构造依据仍是 yaml —— schemas/families/*.yaml 里声明的 field + builder_hint,
   * 不是按模型名猜。family 都识别不出来的就老实返回空。 */
  /* Use family metadata only when the model has no per-model effort map; a declared
   * model map remains authoritative. */
  if (!entry && !schema?.effort_map) {
    const familyPayload = familyEffortPayload(modelId, effortLevel);
    if (familyPayload) return { payload: familyPayload, upstreamSlugOverride: null, billingMultiplier: null };
  }
  if (!entry || typeof entry !== 'object') return empty;

  const payload: Record<string, unknown> = {};
  let billingMultiplier: number | null = null;
  let upstreamSlugOverride: string | null = null;

  for (const [k, v] of Object.entries(entry)) {
    if (k === 'billing_multiplier') {
      if (typeof v === 'number') billingMultiplier = v;
      continue;
    }
    if (k === 'upstream_slug_override') {
      /* 优先级:
         (a) 传了 providerId → 按 providerId 桶选
         (b) 没传 providerId, 但 override 只有 1 个桶 → 用唯一那个 (跟 openai.ts 旧 inline 行为兼容)
         (c) 没传 providerId 且 multi-bucket → 无法确定, 保留 null (调用方自己 resolveUpstreamSlug) */
      if (v && typeof v === 'object') {
        const overrides = v as Record<string, unknown>;
        if (providerId) {
          const slug = overrides[providerId];
          if (typeof slug === 'string') upstreamSlugOverride = slug;
        } else {
          const values = Object.values(overrides);
          if (values.length === 1 && typeof values[0] === 'string') {
            upstreamSlugOverride = values[0] as string;
          }
        }
      }
      continue;
    }
    if (META_KEYS.has(k)) continue;
    payload[k] = v;
  }

  return { payload, upstreamSlugOverride, billingMultiplier };
}

/**
 * family 级 effort payload —— 只在这个模型自己没有 effort_map 时用.
 *
 * 形态按 family yaml 的声明分两类:
 *   · reasoning_effort.field (OpenAI 系)  → { <field>: <level> }
 *   · thinking.field + builder_hint       → 各家的 thinking 开关形状:
 *       anthropic / toggle → { <field>: { type: 'enabled' | 'disabled' } }
 *       gemini_thinking_budget → { <field>: { thinking_budget: 0 | -1 } }  (-1 = 自动)
 *       裸布尔字段 (qwen 的 enable_thinking) → { <field>: true | false }
 *
 * 只认 off/on 这两种意图 + OpenAI 系的具体档位; 拿不准一律返回 null
 * (返回 null = 不注入任何字段, 交给上游默认 —— 比发一个它不认的字段安全)。
 */
function familyEffortPayload(modelId: string, level: string): Record<string, unknown> | null {
  const registry = getSchemaRegistry();
  const bare = modelId.includes(':') ? modelId.slice(modelId.indexOf(':') + 1) : modelId;
  const family = registry.detectFamily({ model: bare }) ?? registry.detectFamily({ model: modelId });
  if (!family) return null;
  const caps = family.capabilities as
    | {
        reasoning_effort?: { supported?: boolean; field?: string; values?: string[] };
        thinking?: { native?: boolean; field?: string; builder_hint?: string };
      }
    | undefined;
  const off = level === 'off';

  const re = caps?.reasoning_effort;
  if (re?.supported && re.field) {
    /* off 在 OpenAI 系没有对应值 (没有"不思考"的 reasoning_effort) —— 用最低档表达 */
    if (off) {
      const lowest = (re.values ?? []).find((v) => v === 'minimal') ?? (re.values ?? []).find((v) => v === 'low');
      return lowest ? { [re.field]: lowest } : null;
    }
    if ((re.values ?? []).includes(level)) return { [re.field]: level };
    /* 界面给的档位这一家没声明 → 不发, 别让上游 400 */
    return null;
  }

  const th = caps?.thinking;
  if (th?.native && th.field) {
    /* Field names such as enable_thinking use boolean payloads before builder hints
     * select provider-specific object shapes. */
    if (/^(enable|disable|use)_/.test(th.field)) {
      return { [th.field]: /^disable/.test(th.field) ? off : !off };
    }
    switch (th.builder_hint) {
      case 'gemini_thinking_budget':
        /* 0 = 不思考; -1 = 让模型自己定预算 (Gemini 的"自动") */
        return { [th.field]: { thinking_budget: off ? 0 : -1 } };
      case 'anthropic':
      case 'toggle':
      case undefined:
        /* Anthropic 系 / 豆包 / GLM / Kimi 都是 { type: enabled|disabled } 这个形状 */
        return { [th.field]: { type: off ? 'disabled' : 'enabled' } };
      default:
        return null;
    }
  }
  return null;
}

/**
 * 默认思考档 — 用户不动 effort 时, "该模型默认应不应该思考、按哪档思考"。
 *
 * The default level is selected from the model's declared thinking capabilities.
 *
 * Resolution order:
 *   1a. capabilities.thinking.default_level    (anthropic 风格, opus/claude/glm...)
 *   1b. capabilities.reasoning_effort.default  (openai 风格, gpt-5.x/deepseek...)
 *   2.  启发: 'medium' > 'on' > 'standard' > 'high' 中第一个存在且带 payload 字段的
 *   3.  都没有 → null (调用方不注入默认, 交给上游服务器默认)
 *
 * 注意永远不会挑 'off'/'fast' 之类的关思考档做默认。
 *
 * Both thinking and reasoning_effort capability styles are supported.
 */
export function resolveDefaultThinkingLevel(modelId: string): string | null {
  /* A missing capability declaration returns null; schema-loading errors propagate. */
  const schema = getSchemaRegistry().resolveModel(modelId);
  const caps = schema?.capabilities;
  const thinkingCap = caps?.thinking?.supported ? caps.thinking : undefined;
  const reasoningCap = caps?.reasoning_effort?.supported ? caps.reasoning_effort : undefined;
  // thinking(anthropic 风格) 或 reasoning_effort(openai 风格) 任一支持即可
  if (!thinkingCap && !reasoningCap) return null;
  const map = schema?.effort_map ?? {};
  const hasPayload = (lvl: string) => {
    const entry = map[lvl];
    return !!entry && Object.keys(entry).some((k) => !META_KEYS.has(k));
  };
  const declared = thinkingCap?.default_level ?? reasoningCap?.default;
  if (declared && hasPayload(declared)) return declared;
  for (const candidate of ['medium', 'on', 'standard', 'high']) {
    if (hasPayload(candidate)) return candidate;
  }
  return null;
}
