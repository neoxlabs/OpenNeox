/**
 * Notification Rules Engine Unit Tests
 *
 * Tests:
 * - Default rules exist and are enabled
 * - fire() triggers matching rules
 * - Cooldown prevents duplicate firing
 * - Condition functions are evaluated
 * - addRule / removeRule / setRuleEnabled
 * - Handler is called when registered
 * - setEnabled(false) suppresses all notifications
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  NotificationRulesEngine,
  type NotificationRule,
  type NotificationPayload,
} from '@neoxlabs/platform/platform/notificationRules.js';

describe('NotificationRulesEngine', () => {
  let engine: NotificationRulesEngine;

  beforeEach(() => {
    engine = new NotificationRulesEngine();
  });

  // ========================================================================
  // 1. Default rules
  // ========================================================================
  describe('default rules', () => {
    it('has default rules on construction', () => {
      const rules = engine.getRules();
      expect(rules.length).toBeGreaterThan(0);
    });

    it('default rules are enabled', () => {
      const rules = engine.getRules();
      for (const rule of rules) {
        expect(rule.enabled).toBe(true);
      }
    });

    it('has rules for key events', () => {
      const rules = engine.getRules();
      const events = new Set(rules.map(r => r.event));
      expect(events.has('task_complete')).toBe(true);
      expect(events.has('error')).toBe(true);
      expect(events.has('rate_limit_warning')).toBe(true);
      expect(events.has('budget_exceeded')).toBe(true);
    });
  });

  // ========================================================================
  // 2. fire() triggers matching rules
  // ========================================================================
  describe('fire()', () => {
    it('returns payloads for matching rules', () => {
      // error_bell rule has no condition, always fires on 'error'
      const payloads = engine.fire('error', { errorMessage: 'test error' });
      expect(payloads.length).toBeGreaterThan(0);
      expect(payloads[0].event).toBe('error');
      expect(payloads[0].body).toContain('test error');
    });

    it('returns empty array for events with no matching rules', () => {
      const payloads = engine.fire('idle_timeout');
      // No default rule for idle_timeout
      expect(payloads).toHaveLength(0);
    });

    it('task_complete fires with duration > 30s', () => {
      const payloads = engine.fire('task_complete', { durationSeconds: 60 });
      expect(payloads.length).toBeGreaterThan(0);
      expect(payloads[0].body).toContain('60s');
    });

    it('task_complete does NOT fire with duration < 30s (condition)', () => {
      const payloads = engine.fire('task_complete', { durationSeconds: 10 });
      expect(payloads).toHaveLength(0);
    });

    it('budget_exceeded fires with correct payload', () => {
      const payloads = engine.fire('budget_exceeded', { budgetUsedUsd: 5.50 });
      expect(payloads.length).toBeGreaterThan(0);
      expect(payloads[0].urgency).toBe('high');
      expect(payloads[0].body).toContain('$5.50');
    });

    it('rate_limit_warning only fires when usage >= 0.8', () => {
      const low = engine.fire('rate_limit_warning', { rateLimitUsage: 0.5 });
      expect(low).toHaveLength(0);

      const high = engine.fire('rate_limit_warning', { rateLimitUsage: 0.9 });
      expect(high.length).toBeGreaterThan(0);
    });
  });

  // ========================================================================
  // 3. Cooldown
  // ========================================================================
  describe('cooldown', () => {
    it('prevents duplicate firing within cooldown period', () => {
      // error_bell has cooldownMs: 2000
      const first = engine.fire('error', { errorMessage: 'err1' });
      expect(first.length).toBeGreaterThan(0);

      // Immediate second fire should be suppressed by cooldown
      const second = engine.fire('error', { errorMessage: 'err2' });
      expect(second).toHaveLength(0);
    });

    it('allows firing after cooldown expires', () => {
      // Use a custom rule with 0 cooldown
      engine.addRule({
        id: 'test_no_cooldown',
        event: 'error',
        channel: 'bell',
        cooldownMs: 0,
        enabled: true,
        description: 'test',
      });

      const first = engine.fire('error');
      const hasTestRule = first.some(p => p.channel === 'bell');
      expect(hasTestRule).toBe(true);

      // With cooldownMs: 0, should fire again immediately
      const second = engine.fire('error');
      const hasTestRuleAgain = second.some(p => p.channel === 'bell');
      expect(hasTestRuleAgain).toBe(true);
    });
  });

  // ========================================================================
  // 4. Condition evaluation
  // ========================================================================
  describe('condition evaluation', () => {
    it('fires rule when condition returns true', () => {
      engine.addRule({
        id: 'test_cond_true',
        event: 'model_switch',
        channel: 'toast',
        condition: () => true,
        cooldownMs: 0,
        enabled: true,
        description: 'always fires',
      });

      const payloads = engine.fire('model_switch', { model: 'gpt-4' });
      expect(payloads.length).toBeGreaterThan(0);
    });

    it('does not fire when condition returns false', () => {
      engine.addRule({
        id: 'test_cond_false',
        event: 'model_switch',
        channel: 'toast',
        condition: () => false,
        cooldownMs: 0,
        enabled: true,
        description: 'never fires',
      });

      const payloads = engine.fire('model_switch', { model: 'gpt-4' });
      expect(payloads).toHaveLength(0);
    });

    it('condition receives context', () => {
      const condFn = vi.fn().mockReturnValue(true);
      engine.addRule({
        id: 'test_cond_ctx',
        event: 'model_switch',
        channel: 'toast',
        condition: condFn,
        cooldownMs: 0,
        enabled: true,
        description: 'check ctx',
      });

      const ctx = { model: 'claude-3' };
      engine.fire('model_switch', ctx);
      expect(condFn).toHaveBeenCalledWith(ctx);
    });
  });

  // ========================================================================
  // 5. addRule / removeRule / setRuleEnabled
  // ========================================================================
  describe('rule management', () => {
    it('addRule adds a new rule', () => {
      const before = engine.getRules().length;
      engine.addRule({
        id: 'custom_rule_1',
        event: 'idle_timeout',
        channel: 'desktop',
        cooldownMs: 0,
        enabled: true,
        description: 'custom',
      });
      expect(engine.getRules().length).toBe(before + 1);
    });

    it('addRule replaces existing rule with same id', () => {
      engine.addRule({
        id: 'error_bell',
        event: 'error',
        channel: 'desktop', // changed from bell to desktop
        cooldownMs: 0,
        enabled: true,
        description: 'replaced',
      });

      const rule = engine.getRules().find(r => r.id === 'error_bell');
      expect(rule).toBeTruthy();
      expect(rule!.channel).toBe('desktop');
      expect(rule!.description).toBe('replaced');
    });

    it('removeRule removes a rule and returns true', () => {
      const removed = engine.removeRule('error_bell');
      expect(removed).toBe(true);
      expect(engine.getRules().find(r => r.id === 'error_bell')).toBeUndefined();
    });

    it('removeRule returns false for non-existent rule', () => {
      const removed = engine.removeRule('nonexistent');
      expect(removed).toBe(false);
    });

    it('setRuleEnabled disables a rule', () => {
      engine.setRuleEnabled('error_bell', false);
      const rule = engine.getRules().find(r => r.id === 'error_bell');
      expect(rule!.enabled).toBe(false);

      // Disabled rule should not fire
      const payloads = engine.fire('error', { errorMessage: 'test' });
      const bellPayloads = payloads.filter(p => p.channel === 'bell');
      expect(bellPayloads).toHaveLength(0);
    });

    it('setRuleEnabled re-enables a rule', () => {
      engine.setRuleEnabled('error_bell', false);
      engine.setRuleEnabled('error_bell', true);
      const rule = engine.getRules().find(r => r.id === 'error_bell');
      expect(rule!.enabled).toBe(true);
    });
  });

  // ========================================================================
  // 6. Handler registration
  // ========================================================================
  describe('handler', () => {
    it('calls registered handler when rule fires', () => {
      const handler = vi.fn();
      engine.registerHandler('bell', handler);

      engine.fire('error', { errorMessage: 'boom' });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'error',
          channel: 'bell',
        }),
      );
    });

    it('does not call handler for non-matching channel', () => {
      const desktopHandler = vi.fn();
      engine.registerHandler('desktop', desktopHandler);

      // error_bell uses 'bell' channel, not 'desktop'
      // But we need to prevent cooldown from the default error_bell rule
      const freshEngine = new NotificationRulesEngine([
        {
          id: 'test_bell',
          event: 'error',
          channel: 'bell',
          cooldownMs: 0,
          enabled: true,
          description: 'test',
        },
      ]);
      freshEngine.registerHandler('desktop', desktopHandler);
      freshEngine.fire('error');
      expect(desktopHandler).not.toHaveBeenCalled();
    });

    it('handler exceptions are non-fatal', () => {
      engine.registerHandler('bell', () => {
        throw new Error('handler crash');
      });

      // Should not throw
      expect(() => engine.fire('error')).not.toThrow();
    });
  });

  // ========================================================================
  // 7. setEnabled(false) suppresses all
  // ========================================================================
  describe('global enable/disable', () => {
    it('setEnabled(false) suppresses all notifications', () => {
      engine.setEnabled(false);
      expect(engine.isEnabled()).toBe(false);

      const payloads = engine.fire('error', { errorMessage: 'suppressed' });
      expect(payloads).toHaveLength(0);
    });

    it('setEnabled(true) re-enables notifications', () => {
      engine.setEnabled(false);
      engine.setEnabled(true);
      expect(engine.isEnabled()).toBe(true);

      const payloads = engine.fire('error', { errorMessage: 'active again' });
      expect(payloads.length).toBeGreaterThan(0);
    });
  });

  // ========================================================================
  // 8. resetToDefaults
  // ========================================================================
  describe('resetToDefaults', () => {
    it('restores default rules after modifications', () => {
      engine.removeRule('error_bell');
      engine.addRule({
        id: 'custom',
        event: 'idle_timeout',
        channel: 'none',
        cooldownMs: 0,
        enabled: true,
        description: 'custom',
      });

      engine.resetToDefaults();

      const rules = engine.getRules();
      expect(rules.find(r => r.id === 'error_bell')).toBeTruthy();
      expect(rules.find(r => r.id === 'custom')).toBeUndefined();
    });
  });

  // ========================================================================
  // 9. Custom rules constructor
  // ========================================================================
  describe('custom rules constructor', () => {
    it('accepts custom rules array', () => {
      const customEngine = new NotificationRulesEngine([
        {
          id: 'only_rule',
          event: 'error',
          channel: 'sound',
          cooldownMs: 0,
          enabled: true,
          description: 'only rule',
        },
      ]);

      expect(customEngine.getRules()).toHaveLength(1);
      expect(customEngine.getRules()[0].id).toBe('only_rule');
    });
  });
});
