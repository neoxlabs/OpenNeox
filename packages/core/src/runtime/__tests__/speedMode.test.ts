/**
 * Speed Mode Unit Tests
 *
 * Tests:
 * - setSpeedMode / getSpeedMode round-trip
 * - getProfileOverlay correctness per mode
 * - getProviderSpeedParams per provider x mode
 * - detectProviderType identification
 * - getSpeedModeInfo display info
 * - Change callback
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setSpeedMode,
  getSpeedMode,
  setSpeedModeChangeCallback,
  getProfileOverlay,
  getProviderSpeedParams,
  detectProviderType,
  getSpeedModeInfo,
  supportsNativeReasoning,
  type SpeedMode,
} from '../speedMode.js';

describe('speedMode', () => {
  beforeEach(() => {
    setSpeedMode('normal');
    setSpeedModeChangeCallback(null);
  });

  // ========================================================================
  // 1. setSpeedMode / getSpeedMode round-trip
  // ========================================================================
  describe('setSpeedMode / getSpeedMode', () => {
    it('defaults to normal', () => {
      expect(getSpeedMode()).toBe('normal');
    });

    it.each<SpeedMode>(['turbo', 'normal', 'deep'])(
      'round-trips mode: %s',
      (mode) => {
        setSpeedMode(mode);
        expect(getSpeedMode()).toBe(mode);
      },
    );
  });

  // ========================================================================
  // 2. Change callback
  // ========================================================================
  describe('change callback', () => {
    it('fires callback on mode change', () => {
      const cb = vi.fn();
      setSpeedModeChangeCallback(cb);
      setSpeedMode('turbo');
      expect(cb).toHaveBeenCalledOnce();
      expect(cb).toHaveBeenCalledWith('turbo');
    });

    it('does not fire after callback removed', () => {
      const cb = vi.fn();
      setSpeedModeChangeCallback(cb);
      setSpeedModeChangeCallback(null);
      setSpeedMode('deep');
      expect(cb).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // 3. getProfileOverlay
  // ========================================================================
  describe('getProfileOverlay', () => {
    it('returns turbo overlay', () => {
      const overlay = getProfileOverlay('turbo');
      expect(overlay.loop?.strategy).toBe('fast_converge');
      expect(overlay.loop?.disableProgressGate).toBe(true);
      expect(overlay.loop?.disablePostActionReflection).toBe(true);
      expect(overlay.loop?.disablePlannerAutoFollowup).toBe(true);
      expect(overlay.are?.maxLevel).toBe(0);
      expect(overlay.reasoning?.effort).toBe('minimal');
    });

    it('returns normal overlay', () => {
      const overlay = getProfileOverlay('normal');
      expect(overlay.loop?.strategy).toBe('balanced');
      expect(overlay.loop?.disableProgressGate).toBe(false);
      expect(overlay.are?.maxLevel).toBe(1);
      expect(overlay.reasoning?.effort).toBe('medium');
    });

    it('returns deep overlay', () => {
      const overlay = getProfileOverlay('deep');
      expect(overlay.loop?.strategy).toBe('balanced');
      expect(overlay.are?.maxLevel).toBe(2);
      expect(overlay.reasoning?.effort).toBe('high');
    });

    it('uses current mode when no argument', () => {
      setSpeedMode('turbo');
      const overlay = getProfileOverlay();
      expect(overlay.reasoning?.effort).toBe('minimal');
    });
  });

  // ========================================================================
  // 4. getProviderSpeedParams — 6 providers x 3 modes
  // ========================================================================
  describe('getProviderSpeedParams', () => {
    const providers = ['anthropic', 'openai', 'openai-o-series', 'kimi', 'deepseek', 'generic'] as const;
    const modes: SpeedMode[] = ['turbo', 'normal', 'deep'];

    // Anthropic
    it('anthropic turbo disables thinking', () => {
      const params = getProviderSpeedParams('anthropic', 'turbo');
      expect(params.thinking.type).toBe('disabled');
      expect(params.budget_tokens).toBe(0);
    });

    it('anthropic normal enables thinking with budget', () => {
      const params = getProviderSpeedParams('anthropic', 'normal');
      expect(params.thinking.type).toBe('enabled');
      expect(params.budget_tokens).toBe(16384);
    });

    it('anthropic deep enables thinking with max budget', () => {
      const params = getProviderSpeedParams('anthropic', 'deep');
      expect(params.thinking.type).toBe('enabled');
      expect(params.budget_tokens).toBe(-1);
    });

    // OpenAI
    it('openai maps to reasoning_effort low/medium/high', () => {
      expect(getProviderSpeedParams('openai', 'turbo').reasoning_effort).toBe('low');
      expect(getProviderSpeedParams('openai', 'normal').reasoning_effort).toBe('medium');
      expect(getProviderSpeedParams('openai', 'deep').reasoning_effort).toBe('high');
    });

    // OpenAI o-series
    it('openai-o-series maps to minimal/medium/xhigh', () => {
      expect(getProviderSpeedParams('openai-o-series', 'turbo').reasoning_effort).toBe('minimal');
      expect(getProviderSpeedParams('openai-o-series', 'normal').reasoning_effort).toBe('medium');
      expect(getProviderSpeedParams('openai-o-series', 'deep').reasoning_effort).toBe('xhigh');
    });

    // Kimi
    it('kimi turbo disables thinking', () => {
      expect(getProviderSpeedParams('kimi', 'turbo').thinking.type).toBe('disabled');
    });

    it('kimi deep enables thinking with budget', () => {
      const params = getProviderSpeedParams('kimi', 'deep');
      expect(params.thinking.type).toBe('enabled');
      expect(params.thinking.budget_tokens).toBe(65536);
    });

    // DeepSeek
    it('deepseek turbo disables thinking', () => {
      expect(getProviderSpeedParams('deepseek', 'turbo').thinking.type).toBe('disabled');
    });

    it('deepseek deep enables thinking', () => {
      expect(getProviderSpeedParams('deepseek', 'deep').thinking.type).toBe('enabled');
    });

    // Generic
    it('generic returns empty objects for all modes', () => {
      for (const m of modes) {
        expect(getProviderSpeedParams('generic', m)).toEqual({});
      }
    });

    // Fallback to generic for unknown provider
    it('unknown provider falls back to generic', () => {
      expect(getProviderSpeedParams('some-unknown-provider', 'turbo')).toEqual({});
    });

    // Uses current mode when no mode arg
    it('uses current mode when no mode argument', () => {
      setSpeedMode('deep');
      const params = getProviderSpeedParams('openai');
      expect(params.reasoning_effort).toBe('high');
    });
  });

  // ========================================================================
  // 5. detectProviderType
  // ========================================================================
  describe('detectProviderType', () => {
    it('detects anthropic from provider string', () => {
      expect(detectProviderType('anthropic', 'some-model')).toBe('anthropic');
    });

    it('detects anthropic from claude model name', () => {
      expect(detectProviderType('custom', 'claude-3-5-sonnet')).toBe('anthropic');
    });

    it('detects openai-o-series from o1 model', () => {
      expect(detectProviderType('openai', 'o1-preview')).toBe('openai-o-series');
    });

    it('detects openai-o-series from o3 model', () => {
      expect(detectProviderType('custom', 'o3-mini')).toBe('openai-o-series');
    });

    it('detects openai-o-series from o4 model', () => {
      expect(detectProviderType('custom', 'o4-mini')).toBe('openai-o-series');
    });

    it('detects openai from gpt model', () => {
      expect(detectProviderType('custom', 'gpt-4o')).toBe('openai');
    });

    it('detects openai from provider string', () => {
      expect(detectProviderType('openai', 'some-model')).toBe('openai');
    });

    it('detects kimi from provider', () => {
      expect(detectProviderType('kimi', 'some-model')).toBe('kimi');
    });

    it('detects kimi from moonshot model', () => {
      expect(detectProviderType('custom', 'moonshot-v1')).toBe('kimi');
    });

    it('detects deepseek from provider', () => {
      expect(detectProviderType('deepseek', 'some-model')).toBe('deepseek');
    });

    it('detects deepseek from model', () => {
      expect(detectProviderType('custom', 'deepseek-chat')).toBe('deepseek');
    });

    it('returns generic for glm', () => {
      expect(detectProviderType('glm', 'glm-4')).toBe('generic');
    });

    it('returns generic for gemini', () => {
      expect(detectProviderType('gemini', 'gemini-2.5-pro')).toBe('generic');
    });

    it('returns generic for unknown', () => {
      expect(detectProviderType('unknown', 'unknown-model')).toBe('generic');
    });
  });

  // ========================================================================
  // 6. getSpeedModeInfo
  // ========================================================================
  describe('getSpeedModeInfo', () => {
    it('turbo info', () => {
      const info = getSpeedModeInfo('turbo');
      expect(info.label).toBe('Turbo');
      expect(info.color).toBe('yellow');
      expect(info.icon).toBeTruthy();
    });

    it('normal info', () => {
      const info = getSpeedModeInfo('normal');
      expect(info.label).toBe('Normal');
      expect(info.color).toBe('cyan');
    });

    it('deep info', () => {
      const info = getSpeedModeInfo('deep');
      expect(info.label).toBe('Deep');
      expect(info.color).toBe('magenta');
    });

    it('uses current mode when no argument', () => {
      setSpeedMode('deep');
      expect(getSpeedModeInfo().label).toBe('Deep');
    });
  });

  // ========================================================================
  // 7. supportsNativeReasoning
  // ========================================================================
  describe('supportsNativeReasoning', () => {
    it('returns true for anthropic', () => {
      expect(supportsNativeReasoning('anthropic', 'claude-3')).toBe(true);
    });

    it('returns false for generic models', () => {
      expect(supportsNativeReasoning('unknown', 'unknown-model')).toBe(false);
    });
  });
});
