import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FocusService } from '../focus/FocusService.js';
import { FOCUS_TOPIC } from '../focus/types.js';
import type { FocusEvents, FocusScope } from '../focus/types.js';
import { MessageBus } from '../bus/MessageBus.js';

describe('FocusService', () => {
  let bus: MessageBus;
  let focus: FocusService;

  beforeEach(() => {
    bus = new MessageBus();
    focus = new FocusService({ bus });
  });

  describe('initial state', () => {
    it('defaults to "global" scope', () => {
      expect(focus.getScope()).toBe('global');
      expect(focus.isActive('global')).toBe(true);
    });

    it('respects initialScope option', () => {
      const f = new FocusService({ bus, initialScope: 'fileTree' });
      expect(f.getScope()).toBe('fileTree');
      expect(f.isActive('fileTree')).toBe(true);
    });
  });

  describe('isActive', () => {
    it('returns true only for the current scope', () => {
      focus.setScope('fileTree');
      expect(focus.isActive('fileTree')).toBe(true);
      expect(focus.isActive('editor')).toBe(false);
      expect(focus.isActive('global')).toBe(false);
    });
  });

  describe('setScope', () => {
    it('updates the current scope', () => {
      focus.setScope('editor');
      expect(focus.getScope()).toBe('editor');
    });

    it('publishes onScopeChanged on the bus', () => {
      const handler = vi.fn();
      bus.subscribe(FOCUS_TOPIC, { onScopeChanged: handler });

      focus.setScope('fileTree');

      expect(handler).toHaveBeenCalledExactlyOnceWith({
        current: 'fileTree',
        previous: 'global',
      });
    });

    it('passes the previous scope correctly across multiple changes', () => {
      const events: Array<{ current: FocusScope; previous: FocusScope }> = [];
      bus.subscribe(FOCUS_TOPIC, { onScopeChanged: (e) => events.push(e) });

      focus.setScope('fileTree');
      focus.setScope('editor');
      focus.setScope('global');

      expect(events).toEqual([
        { current: 'fileTree', previous: 'global' },
        { current: 'editor', previous: 'fileTree' },
        { current: 'global', previous: 'editor' },
      ]);
    });

    it('is idempotent: setting same scope is a no-op (no event)', () => {
      const handler = vi.fn();
      bus.subscribe(FOCUS_TOPIC, { onScopeChanged: handler });

      focus.setScope('fileTree');
      focus.setScope('fileTree'); // same again
      focus.setScope('fileTree'); // and again

      expect(handler).toHaveBeenCalledOnce();
    });

    it('accepts custom scope strings (plugin scenario)', () => {
      focus.setScope('myPluginPanel');
      expect(focus.isActive('myPluginPanel')).toBe(true);
    });
  });

  describe('clear', () => {
    it('returns scope to "global"', () => {
      focus.setScope('fileTree');
      focus.clear();
      expect(focus.getScope()).toBe('global');
    });

    it('publishes the change event', () => {
      const handler = vi.fn();
      focus.setScope('fileTree');
      bus.subscribe(FOCUS_TOPIC, { onScopeChanged: handler });

      focus.clear();

      expect(handler).toHaveBeenCalledExactlyOnceWith({
        current: 'global',
        previous: 'fileTree',
      });
    });

    it('is a no-op when already global', () => {
      const handler = vi.fn();
      bus.subscribe(FOCUS_TOPIC, { onScopeChanged: handler });
      focus.clear();
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('subscribe (useSyncExternalStore channel)', () => {
    it('listener fires on each scope change', () => {
      const listener = vi.fn();
      focus.subscribe(listener);

      focus.setScope('fileTree');
      focus.setScope('editor');

      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('listener does NOT fire on no-op set', () => {
      const listener = vi.fn();
      focus.setScope('fileTree');
      focus.subscribe(listener);
      focus.setScope('fileTree');
      expect(listener).not.toHaveBeenCalled();
    });

    it('returned function unsubscribes', () => {
      const listener = vi.fn();
      const off = focus.subscribe(listener);
      off();
      focus.setScope('fileTree');
      expect(listener).not.toHaveBeenCalled();
    });

    it('listener errors do not break other listeners', () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const ok = vi.fn();
      focus.subscribe(() => {
        throw new Error('boom');
      });
      focus.subscribe(ok);

      focus.setScope('fileTree');

      expect(ok).toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });

    it('unsubscribing during dispatch does not affect that dispatch', () => {
      const calls: string[] = [];
      let off2: (() => void) | undefined;
      focus.subscribe(() => {
        calls.push('first');
        off2?.();
      });
      off2 = focus.subscribe(() => calls.push('second'));
      focus.subscribe(() => calls.push('third'));

      focus.setScope('fileTree');

      // snapshot 已拍 → 本次还是 3 个都执行
      expect(calls).toEqual(['first', 'second', 'third']);
    });
  });

  describe('topic + listener decoupling', () => {
    it('bus subscribers fire AFTER store listeners', () => {
      const order: string[] = [];
      focus.subscribe(() => order.push('store'));
      bus.subscribe(FOCUS_TOPIC, {
        onScopeChanged: () => order.push('bus'),
      });

      focus.setScope('fileTree');

      expect(order).toEqual(['store', 'bus']);
    });

    it('listener type interface is honored', () => {
      // Just a TS type-level check that FocusEvents is well-formed
      const listener: Partial<FocusEvents> = {
        onScopeChanged: ({ current, previous }) => {
          expect(typeof current).toBe('string');
          expect(typeof previous).toBe('string');
        },
      };
      bus.subscribe(FOCUS_TOPIC, listener);
      focus.setScope('editor');
    });
  });
});
