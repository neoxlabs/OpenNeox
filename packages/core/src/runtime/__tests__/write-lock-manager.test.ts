import path from 'path';
import { describe, expect, it } from 'vitest';
import { WriteLockManager } from '../agent/writeLockManager.js';

describe('WriteLockManager', () => {
  it('does not allow same-agent reentrant acquire on active lock', () => {
    const manager = new WriteLockManager({ lockTTL: 5_000, defaultTimeout: 50 });
    try {
      const first = manager.tryAcquire('/tmp/neox-write-lock.txt', 'main');
      const second = manager.tryAcquire('/tmp/neox-write-lock.txt', 'main');

      expect(first.success).toBe(true);
      expect(second.success).toBe(false);
      expect(second.heldBy).toBe('main');
    } finally {
      manager.destroy();
    }
  });

  it('normalizes relative and absolute paths to the same lock key', () => {
    const manager = new WriteLockManager({ lockTTL: 5_000, defaultTimeout: 50 });
    try {
      const rel = 'tmp/neox-lock-path.txt';
      const abs = path.resolve(process.cwd(), rel);

      const first = manager.tryAcquire(rel, 'agent-a');
      const second = manager.tryAcquire(abs, 'agent-b');

      expect(first.success).toBe(true);
      expect(second.success).toBe(false);
      expect(second.heldBy).toBe('agent-a');
    } finally {
      manager.destroy();
    }
  });
});
