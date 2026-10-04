/**
 * Phase 5 — schema conformance tests.
 *
 *   Goal: every (provider, model) combination + every effort level + every
 *   capability must follow the contracts in PROVIDER_SCHEMA_DESIGN.md. CI
 *   runs this on every PR. Failure blocks merge.
 *
 *   These tests are PURE — they don't hit any LLM. They check structural
 *   invariants that today's hand-edits keep getting wrong:
 *     - schema yaml well-formed (zod via loader)
 *     - every model has at least one upstream_slug
 *     - reasoning_effort models map every advertised native effort level
 *     - billing_multiplier values are positive numbers
 *     - capabilities.prompt_cache.supported=true models specify
 *       breakpoint_targets
 *     - Anthropic-protocol providers have separate-field system_position
 *     - cache_control_passthrough providers route through client obligations
 *
 *   Real upstream calls go in a SEPARATE manual test harness gated by
 *   NEOX_LIVE_CONFORMANCE=1 — that one costs real money and isn't in CI.
 */

import { describe, expect, test } from 'vitest';
import { loadSchemas } from '../index.js';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SCHEMAS_DIR = path.join(REPO_ROOT, 'schemas');

describe('schema conformance', () => {
  const registry = loadSchemas({ dir: SCHEMAS_DIR });

  describe('protocols', () => {
    test('every protocol has a non-empty api_path', () => {
      for (const proto of registry.protocols.values()) {
        expect(proto.api_path).toMatch(/^\/.+/);
      }
    });

    test('anthropic-messages protocol must use separate-field system_position', () => {
      const proto = registry.resolveProtocol('anthropic-messages');
      expect(proto).toBeDefined();
      expect(proto?.request_shape.system_position).toBe('separate-field');
    });

    test('openai-chat protocol must allow any system_position (downstream sanitize)', () => {
      const proto = registry.resolveProtocol('openai-chat');
      expect(proto).toBeDefined();
      expect(proto?.request_shape.system_position).toBe('any');
    });
  });

  describe('providers', () => {
    test('every provider references an existing protocol', () => {
      for (const provider of registry.providers.values()) {
        expect(registry.protocols.has(provider.protocol)).toBe(true);
      }
    });

    test('every provider has a base_url that looks like a URL', () => {
      for (const provider of registry.providers.values()) {
        expect(provider.base_url).toMatch(/^https?:\/\/[^\/]+/);
      }
    });

    test('openrouter must declare client_obligations for claude family', () => {
      const p = registry.resolveProvider('prov_openrouter');
      expect(p?.client_obligations?.sanitize_system_order_for_families).toContain('claude');
      expect(p?.client_obligations?.inject_cache_control_for_families).toContain('claude');
    });

    test('anthropic-direct must NOT require sanitize (its native protocol lifts system out)', () => {
      const p = registry.resolveProvider('prov_anthropic_direct');
      const sanitize = p?.client_obligations?.sanitize_system_order_for_families ?? [];
      expect(sanitize).toEqual([]);
    });
  });

  describe('models', () => {
    test('every model has at least one upstream_slug', () => {
      for (const model of registry.models.values()) {
        expect(Object.keys(model.upstream_slugs).length).toBeGreaterThan(0);
      }
    });

    test('every upstream_slug references an existing provider', () => {
      for (const model of registry.models.values()) {
        for (const providerId of Object.keys(model.upstream_slugs)) {
          expect(registry.providers.has(providerId)).toBe(true);
        }
      }
    });

    test('2026-06-28 D15: every model.family references an existing schemas/families/*.yaml', () => {
      /* 防 typo: 写错 family 名 (e.g. "gpt" 而非 "openai") 直接 schema-lint 失败,
         不再到运行时 detectFamily 才暴露。 */
      for (const model of registry.models.values()) {
        expect(
          registry.families.has(model.family),
          `${model.id} declares family="${model.family}" but no schemas/families/${model.family}.yaml exists`,
        ).toBe(true);
      }
    });

    test('2026-06-28 audit: family.fast_patterns / name_regex 字符串都能编译成 RegExp', () => {
      /* 防 yaml 误写正则 (漏转义 / 字符类未闭合)。 */
      for (const family of registry.families.values()) {
        for (const pattern of family.fast_patterns ?? []) {
          expect(() => {
            const m = /^\/(.+)\/([a-z]*)$/.exec(pattern);
            if (m) {
              return new RegExp(m[1], m[2]);
            }
            return new RegExp(pattern, 'i');
          }, `${family.id}.fast_patterns[${pattern}] invalid regex`).not.toThrow();
        }
        for (const pattern of family.name_regex ?? []) {
          expect(() => new RegExp(pattern, 'i'),
            `${family.id}.name_regex[${pattern}] invalid regex`,
          ).not.toThrow();
        }
      }
    });

    test('reasoning_effort models map every advertised native effort level', () => {
      for (const model of registry.models.values()) {
        const values = model.capabilities?.reasoning_effort?.values ?? [];
        if (values.length === 0) continue;
        const effortMap = model.effort_map ?? {};
        expect(Object.keys(effortMap).length, `${model.id} advertises reasoning_effort but has no effort_map`).toBeGreaterThan(0);
        const present = Object.keys(effortMap);
        for (const lvl of values) {
          expect(
            present,
            `${model.id} effort_map missing "${lvl}"`,
          ).toContain(lvl);
        }
        const defaultLevel = model.capabilities?.reasoning_effort?.default;
        if (defaultLevel) {
          expect(present, `${model.id} effort_map missing default "${defaultLevel}"`).toContain(defaultLevel);
        }
      }
    });

    test('every effort_map entry has billing_multiplier > 0', () => {
      const entries = [...registry.models.values()]
        .flatMap((model) => Object.entries(model.effort_map ?? {}).map(([level, entry]) => ({ model, level, entry })));
      /* 开源树里计费倍率被整体剥掉 (计费在服务端), 一个都没有时跳过; 只要有一个, 就必须全部都有 */
      if (!entries.some(({ entry }) => entry?.billing_multiplier !== undefined)) return;
      for (const { model, level, entry } of entries) {
        const mult = entry?.billing_multiplier;
        expect(typeof mult, `${model.id}.effort_map.${level}`).toBe('number');
        expect(mult, `${model.id}.effort_map.${level}.billing_multiplier`).toBeGreaterThan(0);
      }
    });

    test('prompt_cache.type=ephemeral models must declare breakpoint_targets', () => {
      /* Anthropic-style ephemeral cache needs explicit breakpoint placements.
       *  OpenAI prompt_cache_key + Gemini context cache are different mechanisms
       *  (key-based / managed) and don't need per-request breakpoints. */
      for (const model of registry.models.values()) {
        const pc = model.capabilities?.prompt_cache;
        if (!pc?.supported) continue;
        if (pc.type !== 'ephemeral') continue;
        expect(
          pc.breakpoint_targets,
          `${model.id} ephemeral prompt_cache supported but no breakpoint_targets`,
        ).toBeDefined();
        expect(pc.breakpoint_targets!.length).toBeGreaterThan(0);
      }
    });

    test('pricing input/output > 0', () => {
      for (const model of registry.models.values()) {
        expect(model.pricing.input_per_mtok).toBeGreaterThan(0);
        expect(model.pricing.output_per_mtok).toBeGreaterThan(0);
        if (typeof model.pricing.cached_input_per_mtok === 'number') {
          expect(model.pricing.cached_input_per_mtok).toBeGreaterThanOrEqual(0);
          expect(model.pricing.cached_input_per_mtok).toBeLessThanOrEqual(model.pricing.input_per_mtok);
        }
      }
    });

    test('context_window >= 8192', () => {
      for (const model of registry.models.values()) {
        expect(model.context_window).toBeGreaterThanOrEqual(8192);
      }
    });

    test('availability is one of ga / preview / hidden', () => {
      const VALID = new Set(['ga', 'preview', 'hidden']);
      for (const model of registry.models.values()) {
        expect(VALID.has(model.availability)).toBe(true);
      }
    });

    test('claude family models all support prompt_cache (regression check)', () => {
      for (const model of registry.models.values()) {
        if (model.family !== 'claude') continue;
        expect(
          model.capabilities?.prompt_cache?.supported,
          `${model.id} family=claude but prompt_cache not enabled`,
        ).toBe(true);
      }
    });
  });

  describe('resolveUpstreamSlug', () => {
    test('claude-opus-4-8 high → standard slug (effort is payload-only)', () => {
      const slug = registry.resolveUpstreamSlug(
        'claude-opus-4-8',
        'prov_openrouter',
        'high',
      );
      expect(slug).toBe('anthropic/claude-opus-4.8');
    });

    test('gpt-5.5 xhigh → standard slug (effort is payload-only)', () => {
      const slug = registry.resolveUpstreamSlug(
        'gpt-5.5',
        'prov_openrouter',
        'xhigh',
      );
      expect(slug).toBe('openai/gpt-5.5');
    });

    test('unknown model returns undefined (caller must guard)', () => {
      const slug = registry.resolveUpstreamSlug(
        'this-model-does-not-exist',
        'prov_openrouter',
        'standard',
      );
      expect(slug).toBeUndefined();
    });
  });
});
