import { describe, it, expect } from 'vitest';
import {
  findBuiltinPricing,
  getModelPricing,
  calculateRequestCost,
  formatCost,
  DEFAULT_FALLBACK_PRICING,
  BUILTIN_PRICING_TABLE,
} from '@neoxlabs/platform/platform/modelPricingTable.js';

describe('modelPricingTable', () => {
  describe('findBuiltinPricing', () => {
    it('finds Claude 3.5 Sonnet', () => {
      const p = findBuiltinPricing('claude-3-5-sonnet-20241022');
      expect(p).toBeTruthy();
      expect(p!.inputPrice).toBe(3.0);
      expect(p!.outputPrice).toBe(15.0);
    });

    it('finds GPT-4o', () => {
      const p = findBuiltinPricing('gpt-4o-2024-11-20');
      expect(p).toBeTruthy();
      expect(p!.inputPrice).toBe(2.50);
    });

    it('finds GPT-4o-mini', () => {
      const p = findBuiltinPricing('gpt-4o-mini-2024-07-18');
      expect(p).toBeTruthy();
      expect(p!.inputPrice).toBe(0.15);
    });

    it('finds Gemini 2.5 Pro', () => {
      const p = findBuiltinPricing('gemini-2.5-pro-latest');
      expect(p).toBeTruthy();
      expect(p!.inputPrice).toBe(1.25);
    });

    it('finds DeepSeek Chat', () => {
      const p = findBuiltinPricing('deepseek-chat-v3');
      expect(p).toBeTruthy();
      expect(p!.inputPrice).toBe(0.27);
    });

    it('prefers provider-specific match', () => {
      const p = findBuiltinPricing('claude-3-5-sonnet-20241022', 'anthropic');
      expect(p).toBeTruthy();
      expect(p!.provider).toBe('anthropic');
    });

    it('returns null for unknown model', () => {
      expect(findBuiltinPricing('totally-unknown-model-xyz')).toBeNull();
    });

    it('prefers more specific pattern', () => {
      // gpt-4o-mini* should match before gpt-4o*
      const p = findBuiltinPricing('gpt-4o-mini-2025');
      expect(p).toBeTruthy();
      expect(p!.inputPrice).toBe(0.15); // mini price, not gpt-4o price
    });
  });

  describe('getModelPricing', () => {
    it('uses user pricing first', () => {
      const userPricing = [{ pattern: 'my-model*', inputPrice: 99, outputPrice: 99 }];
      const p = getModelPricing('my-model-v1', undefined, userPricing);
      expect(p.inputPrice).toBe(99);
    });

    it('falls back to builtin', () => {
      const p = getModelPricing('claude-3-5-sonnet-20241022');
      expect(p.inputPrice).toBe(3.0);
    });

    it('falls back to default for unknown', () => {
      const p = getModelPricing('completely-unknown-xyz');
      expect(p).toEqual(DEFAULT_FALLBACK_PRICING);
    });
  });

  describe('calculateRequestCost', () => {
    it('calculates basic cost', () => {
      const cost = calculateRequestCost(
        { pattern: '*', inputPrice: 3.0, outputPrice: 15.0 },
        { inputTokens: 1000, outputTokens: 500 },
      );
      // input: 1000/1M * 3.0 = 0.003
      // output: 500/1M * 15.0 = 0.0075
      expect(cost).toBeCloseTo(0.0105, 4);
    });

    it('accounts for cache read savings', () => {
      const cost = calculateRequestCost(
        { pattern: '*', inputPrice: 3.0, outputPrice: 15.0, cachedInputPrice: 0.3 },
        { inputTokens: 10000, outputTokens: 1000, cachedTokens: 8000 },
      );
      // nonCached input: (10000 - 8000) = 2000 → 2000/1M * 3.0 = 0.006
      // output: 1000/1M * 15.0 = 0.015
      // cached read: 8000/1M * 0.3 = 0.0024
      // total ≈ 0.0234
      expect(cost).toBeCloseTo(0.0234, 4);
    });

    it('accounts for cache creation cost', () => {
      const cost = calculateRequestCost(
        { pattern: '*', inputPrice: 3.0, outputPrice: 15.0, cacheCreationPrice: 3.75 },
        { inputTokens: 5000, outputTokens: 100, cacheCreationTokens: 3000 },
      );
      // nonCached: (5000-3000) = 2000 → 0.006
      // output: 0.0015
      // cache create: 3000/1M * 3.75 = 0.01125
      expect(cost).toBeCloseTo(0.01875, 4);
    });
  });

  describe('formatCost', () => {
    it('formats tiny costs', () => {
      expect(formatCost(0.000123)).toBe('$0.000123');
    });
    it('formats small costs', () => {
      expect(formatCost(0.0045)).toBe('$0.0045');
    });
    it('formats medium costs', () => {
      expect(formatCost(0.123)).toBe('$0.123');
    });
    it('formats large costs', () => {
      expect(formatCost(5.67)).toBe('$5.67');
    });
  });

  describe('BUILTIN_PRICING_TABLE', () => {
    it('has entries for major providers', () => {
      const providers = new Set(BUILTIN_PRICING_TABLE.map(e => e.provider).filter(Boolean));
      expect(providers.has('anthropic')).toBe(true);
      expect(providers.has('openai')).toBe(true);
      expect(providers.has('gemini')).toBe(true);
      expect(providers.has('deepseek')).toBe(true);
    });

    it('has reasonable prices', () => {
      for (const entry of BUILTIN_PRICING_TABLE) {
        expect(entry.inputPrice).toBeGreaterThan(0);
        expect(entry.outputPrice).toBeGreaterThan(0);
        expect(entry.outputPrice).toBeGreaterThanOrEqual(entry.inputPrice);
      }
    });
  });
});
