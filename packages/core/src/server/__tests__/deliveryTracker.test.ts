import { describe, it, expect, beforeEach } from 'vitest';
import { DeliveryTracker } from '../deliveryTracker.js';

describe('DeliveryTracker', () => {
  let tracker: DeliveryTracker;

  beforeEach(() => {
    tracker = new DeliveryTracker();
  });

  describe('3-level delivery', () => {
    it('tracks received → processing → processed', () => {
      tracker.markReceived('evt-1', 'session-1');
      expect(tracker.getRecord('evt-1')!.status).toBe('received');

      tracker.markProcessing('evt-1');
      expect(tracker.getRecord('evt-1')!.status).toBe('processing');

      tracker.markProcessed('evt-1');
      expect(tracker.getRecord('evt-1')!.status).toBe('processed');
    });

    it('returns false for unknown event', () => {
      expect(tracker.markProcessing('unknown')).toBe(false);
      expect(tracker.markProcessed('unknown')).toBe(false);
    });
  });

  describe('dropped batch counter', () => {
    it('starts at 0', () => {
      expect(tracker.droppedBatchCount).toBe(0);
    });

    it('increments monotonically', () => {
      tracker.recordDroppedBatch();
      expect(tracker.droppedBatchCount).toBe(1);
      tracker.recordDroppedBatch(3);
      expect(tracker.droppedBatchCount).toBe(4);
    });
  });

  describe('stats', () => {
    it('aggregates correctly', () => {
      tracker.markReceived('a', 's1');
      tracker.markReceived('b', 's1');
      tracker.markProcessing('a');
      tracker.markProcessed('a');
      tracker.recordDroppedBatch(2);

      const stats = tracker.getStats();
      expect(stats.totalReceived).toBe(2);
      expect(stats.totalProcessing).toBe(1);
      expect(stats.totalProcessed).toBe(1);
      expect(stats.droppedBatchCount).toBe(2);
    });
  });

  describe('pending', () => {
    it('returns unconfirmed events for session', () => {
      tracker.markReceived('e1', 's1');
      tracker.markReceived('e2', 's1');
      tracker.markReceived('e3', 's2');
      tracker.markProcessed('e1');

      const pending = tracker.getPendingForSession('s1');
      expect(pending).toEqual(['e2']);
    });
  });

  describe('clearSession', () => {
    it('removes all records for session', () => {
      tracker.markReceived('e1', 's1');
      tracker.markReceived('e2', 's2');
      tracker.clearSession('s1');

      expect(tracker.getRecord('e1')).toBeUndefined();
      expect(tracker.getRecord('e2')).toBeDefined();
    });
  });

  describe('clear', () => {
    it('resets everything including dropped count', () => {
      tracker.markReceived('e1', 's1');
      tracker.recordDroppedBatch(5);
      tracker.clear();

      expect(tracker.droppedBatchCount).toBe(0);
      expect(tracker.getRecord('e1')).toBeUndefined();
      expect(tracker.getStats().totalReceived).toBe(0);
    });
  });
});
