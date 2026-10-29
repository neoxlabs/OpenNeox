import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageBus, createTopic } from '../bus/MessageBus.js';

interface FileEvents {
  onCreated(path: string): void;
  onChanged(path: string, content: string): void;
  onDeleted(path: string): void;
}

const FILE_TOPIC = createTopic<FileEvents>('files');

describe('MessageBus', () => {
  let bus: MessageBus;

  beforeEach(() => {
    bus = new MessageBus();
  });

  describe('subscribe / publish', () => {
    it('delivers events to subscribers', () => {
      const onChanged = vi.fn();
      bus.subscribe(FILE_TOPIC, { onChanged });

      bus.publisher(FILE_TOPIC).onChanged('/foo.ts', 'hello');

      expect(onChanged).toHaveBeenCalledExactlyOnceWith('/foo.ts', 'hello');
    });

    it('delivers to multiple subscribers in subscription order', () => {
      const order: number[] = [];
      bus.subscribe(FILE_TOPIC, { onCreated: () => order.push(1) });
      bus.subscribe(FILE_TOPIC, { onCreated: () => order.push(2) });
      bus.subscribe(FILE_TOPIC, { onCreated: () => order.push(3) });

      bus.publisher(FILE_TOPIC).onCreated('/x');

      expect(order).toEqual([1, 2, 3]);
    });

    it('skips subscribers that did not implement the called method', () => {
      const onCreated = vi.fn();
      // 这个订阅者只关心 onChanged，不关心 onCreated — 不应该崩
      bus.subscribe(FILE_TOPIC, { onChanged: vi.fn() });
      bus.subscribe(FILE_TOPIC, { onCreated });

      bus.publisher(FILE_TOPIC).onCreated('/x');

      expect(onCreated).toHaveBeenCalledOnce();
    });

    it('isolates errors: a throwing subscriber does not break others', () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const ok = vi.fn();

      bus.subscribe(FILE_TOPIC, {
        onChanged: () => {
          throw new Error('boom');
        },
      });
      bus.subscribe(FILE_TOPIC, { onChanged: ok });

      bus.publisher(FILE_TOPIC).onChanged('/x', '');

      expect(ok).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });
  });

  describe('unsubscribe', () => {
    it('returned function removes the listener', () => {
      const onCreated = vi.fn();
      const off = bus.subscribe(FILE_TOPIC, { onCreated });

      bus.publisher(FILE_TOPIC).onCreated('/a');
      off();
      bus.publisher(FILE_TOPIC).onCreated('/b');

      expect(onCreated).toHaveBeenCalledExactlyOnceWith('/a');
    });

    it('removing the last subscriber cleans up the topic entry', () => {
      const off = bus.subscribe(FILE_TOPIC, { onCreated: () => {} });
      expect(bus.subscriberCount(FILE_TOPIC)).toBe(1);
      off();
      expect(bus.subscriberCount(FILE_TOPIC)).toBe(0);
    });

    it('a listener that unsubscribes itself during dispatch does not break iteration', () => {
      const calls: string[] = [];
      let off2: (() => void) | undefined;
      bus.subscribe(FILE_TOPIC, {
        onCreated: () => {
          calls.push('first');
          off2?.();
        },
      });
      const second = { onCreated: () => calls.push('second') };
      off2 = bus.subscribe(FILE_TOPIC, second);
      bus.subscribe(FILE_TOPIC, {
        onCreated: () => calls.push('third'),
      });

      bus.publisher(FILE_TOPIC).onCreated('/x');

      // 即使第二个在 first 里被取消订阅，本次广播也应仍然送达（snapshot 已拍）
      expect(calls).toEqual(['first', 'second', 'third']);
      expect(bus.subscriberCount(FILE_TOPIC)).toBe(2);
    });
  });

  describe('publisher', () => {
    it('returns silently when no subscribers exist', () => {
      expect(() => bus.publisher(FILE_TOPIC).onCreated('/x')).not.toThrow();
    });

    it('different topics are isolated', () => {
      interface OtherEvents {
        ping(): void;
      }
      const OTHER = createTopic<OtherEvents>('other');

      const fileListener = vi.fn();
      const otherListener = vi.fn();
      bus.subscribe(FILE_TOPIC, { onCreated: fileListener });
      bus.subscribe(OTHER, { ping: otherListener });

      bus.publisher(FILE_TOPIC).onCreated('/x');

      expect(fileListener).toHaveBeenCalledOnce();
      expect(otherListener).not.toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it('removes all subscribers across all topics', () => {
      const a = vi.fn();
      const b = vi.fn();
      bus.subscribe(FILE_TOPIC, { onCreated: a });
      bus.subscribe(createTopic<{ x(): void }>('other'), { x: b });

      bus.clear();
      bus.publisher(FILE_TOPIC).onCreated('/x');
      bus.publisher(createTopic<{ x(): void }>('other')).x();

      expect(a).not.toHaveBeenCalled();
      expect(b).not.toHaveBeenCalled();
    });
  });

  afterEach(() => {
    bus.clear();
  });
});
