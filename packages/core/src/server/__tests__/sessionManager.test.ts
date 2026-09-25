import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '../sessionManager.js';

describe('SessionManager', () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager({ maxSessions: 10, sessionTTL: 60_000 });
  });

  describe('create & get', () => {
    it('creates session with correct defaults', () => {
      const session = sm.create({ ownerDeviceId: 'dev-1' });
      expect(session.id).toMatch(/^nxs_/);
      expect(session.status).toBe('active');
      expect(session.epoch).toBe(1);
      expect(session.ownerDeviceId).toBe('dev-1');
      expect(session.subscribers.has('dev-1')).toBe(true);
      expect(session.stats.messageCount).toBe(0);
    });

    it('get returns created session', () => {
      const session = sm.create({ ownerDeviceId: 'dev-1', title: 'Test' });
      const fetched = sm.get(session.id);
      expect(fetched).toBeDefined();
      expect(fetched!.title).toBe('Test');
    });

    it('throws when max sessions reached', () => {
      const tiny = new SessionManager({ maxSessions: 2 });
      tiny.create({ ownerDeviceId: 'd1' });
      tiny.create({ ownerDeviceId: 'd2' });
      expect(() => tiny.create({ ownerDeviceId: 'd3' })).toThrow('Max sessions');
    });
  });

  describe('epoch', () => {
    it('bumps epoch', () => {
      const session = sm.create({ ownerDeviceId: 'dev-1' });
      expect(session.epoch).toBe(1);

      const newEpoch = sm.bumpEpoch(session.id);
      expect(newEpoch).toBe(2);
      expect(sm.get(session.id)!.epoch).toBe(2);
    });

    it('validates epoch correctly', () => {
      const session = sm.create({ ownerDeviceId: 'dev-1' });
      expect(sm.validateEpoch(session.id, 1)).toBe(true);
      expect(sm.validateEpoch(session.id, 2)).toBe(false);

      sm.bumpEpoch(session.id);
      expect(sm.validateEpoch(session.id, 1)).toBe(false);
      expect(sm.validateEpoch(session.id, 2)).toBe(true);
    });

    it('returns false for unknown session', () => {
      expect(sm.validateEpoch('nonexistent', 1)).toBe(false);
    });
  });

  describe('lifecycle', () => {
    it('pause and resume', () => {
      const session = sm.create({ ownerDeviceId: 'dev-1' });
      expect(sm.pause(session.id)).toBe(true);
      expect(sm.get(session.id)!.status).toBe('paused');

      expect(sm.resume(session.id)).toBe(true);
      expect(sm.get(session.id)!.status).toBe('active');
    });

    it('archive', () => {
      const session = sm.create({ ownerDeviceId: 'dev-1' });
      expect(sm.archive(session.id)).toBe(true);
      expect(sm.get(session.id)!.status).toBe('archived');
    });

    it('destroy removes completely', () => {
      const session = sm.create({ ownerDeviceId: 'dev-1' });
      expect(sm.destroy(session.id)).toBe(true);
      expect(sm.get(session.id)).toBeUndefined();
    });
  });

  describe('subscribers', () => {
    it('subscribe adds device', () => {
      const session = sm.create({ ownerDeviceId: 'dev-1' });
      sm.subscribe(session.id, 'dev-2');
      expect(sm.get(session.id)!.subscribers.has('dev-2')).toBe(true);
    });

    it('unsubscribe removes device', () => {
      const session = sm.create({ ownerDeviceId: 'dev-1' });
      sm.subscribe(session.id, 'dev-2');
      sm.unsubscribe(session.id, 'dev-2');
      expect(sm.get(session.id)!.subscribers.has('dev-2')).toBe(false);
    });

    it('removeDevice cleans all subscriptions', () => {
      const s1 = sm.create({ ownerDeviceId: 'dev-1' });
      const s2 = sm.create({ ownerDeviceId: 'dev-1' });
      sm.subscribe(s1.id, 'dev-2');
      sm.subscribe(s2.id, 'dev-2');

      sm.removeDevice('dev-2');
      expect(sm.get(s1.id)!.subscribers.has('dev-2')).toBe(false);
      expect(sm.get(s2.id)!.subscribers.has('dev-2')).toBe(false);
    });
  });

  describe('stats', () => {
    it('records message stats', () => {
      const session = sm.create({ ownerDeviceId: 'dev-1' });
      sm.recordStat(session.id, 'message', 3);
      sm.recordStat(session.id, 'toolCall');
      expect(sm.get(session.id)!.stats.messageCount).toBe(3);
      expect(sm.get(session.id)!.stats.toolCallCount).toBe(1);
    });

    it('updates seq-num high water', () => {
      const session = sm.create({ ownerDeviceId: 'dev-1' });
      sm.updateSeqNum(session.id, 42);
      expect(sm.get(session.id)!.stats.lastSeqNum).toBe(42);
      // 不应降低
      sm.updateSeqNum(session.id, 10);
      expect(sm.get(session.id)!.stats.lastSeqNum).toBe(42);
    });
  });

  describe('list', () => {
    it('lists all sessions sorted by lastActiveAt', () => {
      sm.create({ ownerDeviceId: 'dev-1', title: 'first' });
      sm.create({ ownerDeviceId: 'dev-1', title: 'second' });

      const list = sm.list();
      expect(list.length).toBe(2);
      // Most recent first
      expect(list[0].lastActiveAt).toBeGreaterThanOrEqual(list[1].lastActiveAt);
    });

    it('filters by status', () => {
      const s1 = sm.create({ ownerDeviceId: 'dev-1' });
      sm.create({ ownerDeviceId: 'dev-1' });
      sm.archive(s1.id);

      expect(sm.list({ status: 'active' }).length).toBe(1);
      expect(sm.list({ status: 'archived' }).length).toBe(1);
    });

    it('activeCount returns correct count', () => {
      sm.create({ ownerDeviceId: 'dev-1' });
      const s2 = sm.create({ ownerDeviceId: 'dev-1' });
      sm.pause(s2.id);

      expect(sm.activeCount).toBe(1);
    });
  });

  describe('dispose', () => {
    it('clears all sessions', () => {
      sm.create({ ownerDeviceId: 'dev-1' });
      sm.create({ ownerDeviceId: 'dev-2' });
      sm.dispose();
      expect(sm.list().length).toBe(0);
    });
  });
});
