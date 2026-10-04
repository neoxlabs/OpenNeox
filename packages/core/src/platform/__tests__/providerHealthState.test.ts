import { describe, it, expect } from 'vitest';
import { ProviderHealthTracker } from '@neoxlabs/platform/platform/providerHealthState.js';

describe('ProviderHealthTracker', () => {
  it('starts as healthy', () => {
    const tracker = new ProviderHealthTracker();
    expect(tracker.getHealth('openai')).toBe('healthy');
  });

  it('transitions to degraded after threshold errors', () => {
    const tracker = new ProviderHealthTracker({ degradedThreshold: 3 });

    tracker.recordError('openai', '429 rate limit');
    tracker.recordError('openai', '429 rate limit');
    expect(tracker.getHealth('openai')).toBe('healthy');

    tracker.recordError('openai', '429 rate limit');
    expect(tracker.getHealth('openai')).toBe('degraded');
  });

  it('transitions to down after threshold errors', () => {
    const tracker = new ProviderHealthTracker({
      degradedThreshold: 2,
      downThreshold: 5,
    });

    for (let i = 0; i < 5; i++) {
      tracker.recordError('openai', '500 server error');
    }

    expect(tracker.getHealth('openai')).toBe('down');
  });

  it('recovers after consecutive successes', () => {
    const tracker = new ProviderHealthTracker({
      degradedThreshold: 2,
      recoveryThreshold: 2,
    });

    // Go to degraded
    tracker.recordError('openai', 'err');
    tracker.recordError('openai', 'err');
    expect(tracker.getHealth('openai')).toBe('degraded');

    // Recover
    tracker.recordSuccess('openai');
    expect(tracker.getHealth('openai')).toBe('degraded'); // Not yet

    tracker.recordSuccess('openai');
    expect(tracker.getHealth('openai')).toBe('healthy'); // Recovered
  });

  it('ignores CANCELED errors', () => {
    const tracker = new ProviderHealthTracker({ degradedThreshold: 2 });

    tracker.recordError('openai', 'CANCELED');
    tracker.recordError('openai', 'CANCELED');
    tracker.recordError('openai', 'CANCELED');

    expect(tracker.getHealth('openai')).toBe('healthy');
  });

  it('resets consecutive errors on success', () => {
    const tracker = new ProviderHealthTracker({ degradedThreshold: 3 });

    tracker.recordError('openai', 'err');
    tracker.recordError('openai', 'err');
    tracker.recordSuccess('openai'); // Resets counter
    tracker.recordError('openai', 'err');
    tracker.recordError('openai', 'err');

    expect(tracker.getHealth('openai')).toBe('healthy'); // Not 3 consecutive
  });

  it('shouldAllowRequest for healthy provider', () => {
    const tracker = new ProviderHealthTracker();
    const result = tracker.shouldAllowRequest('openai');
    expect(result.allowed).toBe(true);
    expect(result.isProbe).toBe(false);
    expect(result.delay).toBe(0);
  });

  it('shouldAllowRequest adds delay for degraded provider', () => {
    const tracker = new ProviderHealthTracker({ degradedThreshold: 1 });
    tracker.recordError('openai', 'err');

    const result = tracker.shouldAllowRequest('openai');
    expect(result.allowed).toBe(true);
    expect(result.delay).toBeGreaterThan(0);
  });

  it('shouldAllowRequest blocks down provider except probes', () => {
    const tracker = new ProviderHealthTracker({
      degradedThreshold: 1,
      downThreshold: 2,
      probeIntervalMs: 100,
    });
    tracker.recordError('openai', 'err');
    tracker.recordError('openai', 'err');
    expect(tracker.getHealth('openai')).toBe('down');

    // First check — probe allowed
    const result1 = tracker.shouldAllowRequest('openai');
    expect(result1.allowed).toBe(true);
    expect(result1.isProbe).toBe(true);

    // Immediate second check — blocked
    const result2 = tracker.shouldAllowRequest('openai');
    expect(result2.allowed).toBe(false);
  });

  it('fires transition events', () => {
    const tracker = new ProviderHealthTracker({ degradedThreshold: 1 });
    const events: any[] = [];
    tracker.onTransition(e => events.push(e));

    tracker.recordError('openai', 'err');

    expect(events).toHaveLength(1);
    expect(events[0].from).toBe('healthy');
    expect(events[0].to).toBe('degraded');
    expect(events[0].provider).toBe('openai');
  });

  it('tracks per-provider independently', () => {
    const tracker = new ProviderHealthTracker({ degradedThreshold: 2 });

    tracker.recordError('openai', 'err');
    tracker.recordError('openai', 'err');
    tracker.recordError('anthropic', 'err');

    expect(tracker.getHealth('openai')).toBe('degraded');
    expect(tracker.getHealth('anthropic')).toBe('healthy');
  });
});
