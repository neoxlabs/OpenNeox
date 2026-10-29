import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ComponentType } from 'react';
import { ToolWindowRegistry } from '../toolWindow/ToolWindowRegistry.js';
import { TOOL_WINDOWS_TOPIC } from '../toolWindow/types.js';
import type {
  ToolWindowDescriptor,
  ToolWindowEvents,
} from '../toolWindow/types.js';
import { MessageBus } from '../bus/MessageBus.js';

// 测试用的 stub 组件
const StubComponent: ComponentType<unknown> = () => null;

const makeDescriptor = (
  overrides: Partial<ToolWindowDescriptor> & Pick<ToolWindowDescriptor, 'id' | 'anchor'>,
): ToolWindowDescriptor => ({
  title: overrides.title ?? overrides.id,
  component: overrides.component ?? StubComponent,
  ...overrides,
});

describe('ToolWindowRegistry', () => {
  let bus: MessageBus;
  let registry: ToolWindowRegistry;

  beforeEach(() => {
    bus = new MessageBus();
    registry = new ToolWindowRegistry({ bus });
  });

  describe('register / get / has', () => {
    it('registers and retrieves a descriptor', () => {
      const desc = makeDescriptor({ id: 'project', anchor: 'left', title: 'Project' });
      registry.register(desc);

      expect(registry.has('project')).toBe(true);
      expect(registry.get('project')).toBe(desc);
    });

    it('throws on duplicate id', () => {
      registry.register(makeDescriptor({ id: 'project', anchor: 'left' }));
      expect(() =>
        registry.register(makeDescriptor({ id: 'project', anchor: 'left' })),
      ).toThrowError(/already registered/);
    });

    it('publishes onRegistered on the bus', () => {
      const handler = vi.fn();
      bus.subscribe(TOOL_WINDOWS_TOPIC, { onRegistered: handler });

      const desc = makeDescriptor({ id: 'project', anchor: 'left' });
      registry.register(desc);

      expect(handler).toHaveBeenCalledExactlyOnceWith(desc);
    });
  });

  describe('unregister', () => {
    it('returned function removes the descriptor', () => {
      const off = registry.register(makeDescriptor({ id: 'x', anchor: 'left' }));
      expect(registry.has('x')).toBe(true);
      off();
      expect(registry.has('x')).toBe(false);
    });

    it('publishes onUnregistered on the bus', () => {
      const handler = vi.fn();
      const off = registry.register(makeDescriptor({ id: 'x', anchor: 'left' }));
      bus.subscribe(TOOL_WINDOWS_TOPIC, { onUnregistered: handler });
      off();
      expect(handler).toHaveBeenCalledExactlyOnceWith('x');
    });

    it('only removes the original entry, not a re-registered same id', () => {
      const off = registry.register(makeDescriptor({ id: 'x', anchor: 'left', title: 'first' }));
      off();
      const second = makeDescriptor({ id: 'x', anchor: 'left', title: 'second' });
      registry.register(second);

      // calling old off should be a no-op
      off();

      expect(registry.has('x')).toBe(true);
      expect(registry.get('x')).toBe(second);
    });
  });

  describe('registerAll', () => {
    it('registers everything and returns a single off()', () => {
      const off = registry.registerAll([
        makeDescriptor({ id: 'a', anchor: 'left' }),
        makeDescriptor({ id: 'b', anchor: 'left' }),
        makeDescriptor({ id: 'c', anchor: 'bottom' }),
      ]);
      expect(registry.list()).toHaveLength(3);
      off();
      expect(registry.list()).toHaveLength(0);
    });
  });

  describe('byAnchor', () => {
    it('groups by anchor', () => {
      registry.register(makeDescriptor({ id: 'l1', anchor: 'left' }));
      registry.register(makeDescriptor({ id: 'l2', anchor: 'left' }));
      registry.register(makeDescriptor({ id: 'r1', anchor: 'right' }));
      registry.register(makeDescriptor({ id: 'b1', anchor: 'bottom' }));

      expect(registry.byAnchor('left').map((d) => d.id)).toEqual(['l1', 'l2']);
      expect(registry.byAnchor('right').map((d) => d.id)).toEqual(['r1']);
      expect(registry.byAnchor('bottom').map((d) => d.id)).toEqual(['b1']);
    });

    it('sorts by order ascending; default order is 100', () => {
      registry.register(makeDescriptor({ id: 'a', anchor: 'left', order: 200 }));
      registry.register(makeDescriptor({ id: 'b', anchor: 'left', order: 50 }));
      registry.register(makeDescriptor({ id: 'c', anchor: 'left' })); // default 100
      registry.register(makeDescriptor({ id: 'd', anchor: 'left', order: 10 }));

      expect(registry.byAnchor('left').map((d) => d.id)).toEqual(['d', 'b', 'c', 'a']);
    });

    it('filters out items where isAvailable returns false', () => {
      registry.register(makeDescriptor({ id: 'always', anchor: 'left' }));
      registry.register(makeDescriptor({
        id: 'sometimes',
        anchor: 'left',
        isAvailable: () => false,
      }));
      registry.register(makeDescriptor({
        id: 'truthy',
        anchor: 'left',
        isAvailable: () => true,
      }));

      const ids = registry.byAnchor('left').map((d) => d.id);
      expect(ids).toContain('always');
      expect(ids).toContain('truthy');
      expect(ids).not.toContain('sometimes');
    });

    it('returns empty array for an anchor with no entries', () => {
      registry.register(makeDescriptor({ id: 'a', anchor: 'left' }));
      expect(registry.byAnchor('right')).toEqual([]);
    });

    it('isAvailable is queried fresh on each call', () => {
      let available = false;
      registry.register(makeDescriptor({
        id: 'debug',
        anchor: 'left',
        isAvailable: () => available,
      }));

      expect(registry.byAnchor('left')).toHaveLength(0);
      available = true;
      expect(registry.byAnchor('left')).toHaveLength(1);
    });
  });

  describe('list', () => {
    it('returns all registered descriptors regardless of anchor', () => {
      registry.register(makeDescriptor({ id: 'l', anchor: 'left' }));
      registry.register(makeDescriptor({ id: 'r', anchor: 'right' }));
      registry.register(makeDescriptor({ id: 'b', anchor: 'bottom' }));

      expect(registry.list()).toHaveLength(3);
    });
  });

  describe('topic events', () => {
    it('register + unregister fire correct events in order', () => {
      const events: Array<{ kind: string; id: string }> = [];
      const listener: Partial<ToolWindowEvents> = {
        onRegistered: (d) => events.push({ kind: 'reg', id: d.id }),
        onUnregistered: (id) => events.push({ kind: 'unreg', id }),
      };
      bus.subscribe(TOOL_WINDOWS_TOPIC, listener);

      const off = registry.register(makeDescriptor({ id: 'a', anchor: 'left' }));
      registry.register(makeDescriptor({ id: 'b', anchor: 'right' }));
      off();

      expect(events).toEqual([
        { kind: 'reg', id: 'a' },
        { kind: 'reg', id: 'b' },
        { kind: 'unreg', id: 'a' },
      ]);
    });
  });
});
