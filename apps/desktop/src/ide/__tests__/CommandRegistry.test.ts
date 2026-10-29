import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommandRegistry } from '../commands/CommandRegistry.js';
import {
  ServiceContainer,
  createServiceToken,
} from '../container/ServiceContainer.js';

describe('CommandRegistry', () => {
  let container: ServiceContainer;
  let commands: CommandRegistry;

  beforeEach(() => {
    container = new ServiceContainer();
    commands = new CommandRegistry(container);
  });

  describe('register / execute', () => {
    it('registers and executes a simple command', async () => {
      const handler = vi.fn(() => 'ok');
      commands.register({ id: 'a.do', handler });

      const result = await commands.execute<string>('a.do');

      expect(result).toBe('ok');
      expect(handler).toHaveBeenCalledOnce();
    });

    it('passes args through ctx.args', async () => {
      let received: unknown;
      commands.register({
        id: 'a.echo',
        handler: (ctx) => {
          received = ctx.args;
          return ctx.args;
        },
      });

      const result = await commands.execute('a.echo', { foo: 1 });

      expect(received).toEqual({ foo: 1 });
      expect(result).toEqual({ foo: 1 });
    });

    it('handler can resolve services from container', async () => {
      const LOGGER = createServiceToken<{ msgs: string[] }>('logger', 'app');
      container.register(LOGGER, () => ({ msgs: [] }));

      commands.register({
        id: 'log.write',
        handler: (ctx) => {
          ctx.container.get(LOGGER).msgs.push(String(ctx.args));
        },
      });

      await commands.execute('log.write', 'hello');

      expect(container.get(LOGGER).msgs).toEqual(['hello']);
    });

    it('supports async handlers', async () => {
      commands.register({
        id: 'a.async',
        handler: async () => {
          await new Promise((r) => setTimeout(r, 0));
          return 42;
        },
      });

      await expect(commands.execute<number>('a.async')).resolves.toBe(42);
    });

    it('throws on duplicate id', () => {
      commands.register({ id: 'dup', handler: () => 1 });
      expect(() => commands.register({ id: 'dup', handler: () => 2 })).toThrowError(
        /already registered/,
      );
    });

    it('throws when executing unknown command', async () => {
      await expect(commands.execute('nope')).rejects.toThrow(/not found/);
    });

    it('propagates handler errors', async () => {
      commands.register({
        id: 'a.boom',
        handler: () => {
          throw new Error('explode');
        },
      });

      await expect(commands.execute('a.boom')).rejects.toThrow(/explode/);
    });
  });

  describe('isEnabled', () => {
    it('respects isEnabled in execute (throws when disabled)', async () => {
      commands.register({
        id: 'a.gated',
        isEnabled: () => false,
        handler: () => 'should not run',
      });

      await expect(commands.execute('a.gated')).rejects.toThrow(/disabled/);
    });

    it('isEnabled() reports false for disabled commands', () => {
      commands.register({
        id: 'a.gated',
        isEnabled: () => false,
        handler: () => 'x',
      });
      expect(commands.isEnabled('a.gated')).toBe(false);
    });

    it('isEnabled() returns false for unknown commands', () => {
      expect(commands.isEnabled('does.not.exist')).toBe(false);
    });

    it('isEnabled() defaults to true when no predicate', () => {
      commands.register({ id: 'a.always', handler: () => 1 });
      expect(commands.isEnabled('a.always')).toBe(true);
    });

    it('isEnabled() returns false when predicate throws (does not propagate)', () => {
      commands.register({
        id: 'a.cranky',
        isEnabled: () => {
          throw new Error('predicate boom');
        },
        handler: () => 1,
      });
      expect(commands.isEnabled('a.cranky')).toBe(false);
    });
  });

  describe('unregister', () => {
    it('returned function removes the command', () => {
      const off = commands.register({ id: 'a.x', handler: () => 1 });
      expect(commands.has('a.x')).toBe(true);
      off();
      expect(commands.has('a.x')).toBe(false);
    });

    it('unregister only removes the original entry, not a re-registered same id', () => {
      const off = commands.register({ id: 'a.y', handler: () => 1 });
      off();

      const handler2 = vi.fn(() => 2);
      commands.register({ id: 'a.y', handler: handler2 });

      // calling old off again should be a no-op
      off();

      expect(commands.has('a.y')).toBe(true);
    });
  });

  describe('registerAll / list', () => {
    it('registerAll registers everything and returns a single off()', () => {
      const off = commands.registerAll([
        { id: 'a.1', handler: () => 1 },
        { id: 'a.2', handler: () => 2 },
        { id: 'a.3', handler: () => 3 },
      ]);

      expect(commands.list()).toHaveLength(3);
      off();
      expect(commands.list()).toHaveLength(0);
    });

    it('list returns all registered descriptors', () => {
      commands.register({ id: 'one', title: 'One', handler: () => 1 });
      commands.register({ id: 'two', title: 'Two', handler: () => 2 });

      const ids = commands.list().map((c) => c.id);
      expect(ids.sort()).toEqual(['one', 'two']);
    });
  });
});
