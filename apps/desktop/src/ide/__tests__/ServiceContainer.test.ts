import { describe, it, expect, vi } from 'vitest';
import {
  ServiceContainer,
  createServiceToken,
} from '../container/ServiceContainer.js';

describe('ServiceContainer', () => {
  describe('register / get', () => {
    it('returns the same instance on repeated get (singleton per container)', () => {
      const container = new ServiceContainer();
      const TOKEN = createServiceToken<{ id: number }>('test.svc');
      let counter = 0;
      container.register(TOKEN, () => ({ id: ++counter }));

      const a = container.get(TOKEN);
      const b = container.get(TOKEN);

      expect(a).toBe(b);
      expect(counter).toBe(1);
    });

    it('lazy-instantiates: factory is not called until get', () => {
      const container = new ServiceContainer();
      const TOKEN = createServiceToken<string>('lazy');
      const factory = vi.fn(() => 'hello');
      container.register(TOKEN, factory);

      expect(factory).not.toHaveBeenCalled();
      expect(container.get(TOKEN)).toBe('hello');
      expect(factory).toHaveBeenCalledOnce();
    });

    it('throws on duplicate registration', () => {
      const container = new ServiceContainer();
      const TOKEN = createServiceToken<number>('dup');
      container.register(TOKEN, () => 1);
      expect(() => container.register(TOKEN, () => 2)).toThrowError(
        /already registered/,
      );
    });

    it('throws on get of unregistered token', () => {
      const container = new ServiceContainer();
      const TOKEN = createServiceToken<number>('missing');
      expect(() => container.get(TOKEN)).toThrowError(/not registered/);
    });

    it('factory can resolve other services from the same container', () => {
      const container = new ServiceContainer();
      const LOGGER = createServiceToken<{ log: (m: string) => void }>(
        'logger',
        'app',
      );
      const EDITOR = createServiceToken<{ logger: { log: (m: string) => void } }>(
        'editor',
      );

      container.register(LOGGER, () => ({ log: vi.fn() }));
      container.register(EDITOR, (c) => ({ logger: c.get(LOGGER) }));

      const editor = container.get(EDITOR);
      editor.logger.log('hi');
      expect((editor.logger.log as ReturnType<typeof vi.fn>).mock.calls).toEqual([
        ['hi'],
      ]);
    });
  });

  describe('tryGet / has', () => {
    it('tryGet returns undefined when missing', () => {
      const container = new ServiceContainer();
      const TOKEN = createServiceToken<number>('absent');
      expect(container.tryGet(TOKEN)).toBeUndefined();
    });

    it('has does not trigger instantiation', () => {
      const container = new ServiceContainer();
      const TOKEN = createServiceToken<string>('check');
      const factory = vi.fn(() => 'x');
      container.register(TOKEN, factory);

      expect(container.has(TOKEN)).toBe(true);
      expect(factory).not.toHaveBeenCalled();
    });
  });

  describe('parent / child chain', () => {
    it('child resolves through parent when not registered locally', () => {
      const app = new ServiceContainer();
      const LOGGER = createServiceToken<string>('logger', 'app');
      app.register(LOGGER, () => 'app-logger');

      const workspace = app.createChild();
      expect(workspace.get(LOGGER)).toBe('app-logger');
    });

    it('child can override parent for the same token', () => {
      const app = new ServiceContainer();
      const TOKEN = createServiceToken<string>('overridable');
      app.register(TOKEN, () => 'parent');

      const child = app.createChild();
      child.register(TOKEN, () => 'child');

      expect(child.get(TOKEN)).toBe('child');
      // parent unchanged
      expect(app.get(TOKEN)).toBe('parent');
    });

    it('disposing child does not affect parent', async () => {
      const app = new ServiceContainer();
      const APP_TOKEN = createServiceToken<{ live: boolean }>('app.svc', 'app');
      const appDispose = vi.fn();
      app.register(APP_TOKEN, () => ({ live: true }), appDispose);
      app.get(APP_TOKEN); // instantiate

      const child = app.createChild();
      const CHILD_TOKEN = createServiceToken<{ live: boolean }>('child.svc');
      const childDispose = vi.fn();
      child.register(CHILD_TOKEN, () => ({ live: true }), childDispose);
      child.get(CHILD_TOKEN);

      await child.dispose();

      expect(childDispose).toHaveBeenCalledOnce();
      expect(appDispose).not.toHaveBeenCalled();
      // parent still works
      expect(app.get(APP_TOKEN).live).toBe(true);
    });
  });

  describe('dispose', () => {
    it('only disposes services that were instantiated', async () => {
      const container = new ServiceContainer();
      const A = createServiceToken<string>('a');
      const B = createServiceToken<string>('b');
      const disposeA = vi.fn();
      const disposeB = vi.fn();
      container.register(A, () => 'a', disposeA);
      container.register(B, () => 'b', disposeB);

      container.get(A); // only instantiate A
      await container.dispose();

      expect(disposeA).toHaveBeenCalledOnce();
      expect(disposeB).not.toHaveBeenCalled();
    });

    it('disposes in reverse registration order', async () => {
      const container = new ServiceContainer();
      const order: string[] = [];
      const A = createServiceToken<string>('a');
      const B = createServiceToken<string>('b');
      const C = createServiceToken<string>('c');
      container.register(A, () => 'a', () => void order.push('a'));
      container.register(B, () => 'b', () => void order.push('b'));
      container.register(C, () => 'c', () => void order.push('c'));
      container.get(A);
      container.get(B);
      container.get(C);

      await container.dispose();

      expect(order).toEqual(['c', 'b', 'a']);
    });

    it('continues disposing other services if one disposer throws', async () => {
      const container = new ServiceContainer();
      const A = createServiceToken<string>('a');
      const B = createServiceToken<string>('b');
      const disposeA = vi.fn();
      container.register(A, () => 'a', disposeA);
      container.register(
        B,
        () => 'b',
        () => {
          throw new Error('boom');
        },
      );
      container.get(A);
      container.get(B);

      await expect(container.dispose()).rejects.toThrow(/boom/);
      expect(disposeA).toHaveBeenCalledOnce();
    });

    it('rejects further use after dispose', async () => {
      const container = new ServiceContainer();
      const TOKEN = createServiceToken<string>('t');
      container.register(TOKEN, () => 'x');
      await container.dispose();

      expect(() => container.register(TOKEN, () => 'y')).toThrowError(/disposed/);
      expect(() => container.get(TOKEN)).toThrowError(/disposed/);
    });

    it('is idempotent', async () => {
      const container = new ServiceContainer();
      await container.dispose();
      await expect(container.dispose()).resolves.toBeUndefined();
    });
  });
});
