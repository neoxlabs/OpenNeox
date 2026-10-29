import { describe, it, expect, vi, afterEach } from 'vitest';
import { RemoteRuntimeAdapter } from '../remoteRuntimeAdapter.js';

const IDLE = (RemoteRuntimeAdapter as any).CHAT_IDLE_TIMEOUT_MS as number;

function makeAdapter(status: () => string) {
  const adapter = new RemoteRuntimeAdapter('http://127.0.0.1:1');
  const a = adapter as any;
  const calls = { abort: 0, subscribe: 0 };
  a.client = {
    chat: async () => {},
    abort: async () => { calls.abort++; },
    isHealthy: async () => true,
    getRunState: async (sessionId: string) => ({ sessionId, status: status() }),
    subscribe: async () => { calls.subscribe++; return { close: () => {} }; },
  };
  a.subscription = { close: () => {} };
  a.subscribedSessionId = 's1';
  const push = (type: string) => a.dispatchServerEvent({ sessionId: 's1', type, data: { type } });
  return { adapter, push, calls };
}

afterEach(() => { vi.useRealTimers(); });

describe('RemoteRuntimeAdapter · idle window with a live run', () => {
  it('resubscribes and keeps waiting while the server says the run is alive', async () => {
    vi.useFakeTimers();
    const { adapter, push, calls } = makeAdapter(() => 'running');
    let settled = false;
    const chat = adapter.chat({ sessionId: 's1', prompt: 'long task' } as any).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(IDLE * 3 + 10);
    expect(settled).toBe(false);
    expect(calls.abort).toBe(0);
    expect(calls.subscribe).toBeGreaterThanOrEqual(3);
    push('run_result');
    await chat;
    expect(settled).toBe(true);
  });

  it('waits for a late run_result while the server says idle, without error or abort', async () => {
    vi.useFakeTimers();
    const { adapter, push, calls } = makeAdapter(() => 'idle');
    let settled = false;
    const chat = adapter.chat({ sessionId: 's1', prompt: 'x' } as any).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(IDLE * 2 + 10);
    expect(settled).toBe(false);
    expect(calls.abort).toBe(0);
    push('run_result');
    await chat;
    expect(settled).toBe(true);
  });

  it('ends the turn quietly when the server stays idle and run_result never comes', async () => {
    vi.useFakeTimers();
    const { adapter, calls } = makeAdapter(() => 'idle');
    let result: unknown = 'pending';
    const chat = adapter.chat({ sessionId: 's1', prompt: 'x' } as any).then(() => { result = 'ok'; }, (e) => { result = e; });
    await vi.advanceTimersByTimeAsync(IDLE * 7);
    await chat;
    expect(result).toBe('ok');
    expect(calls.abort).toBe(0);
  });

  it('still errors when the server cannot be reached', async () => {
    vi.useFakeTimers();
    const { adapter } = makeAdapter(() => { throw new Error('ECONNREFUSED'); });
    const chat = adapter.chat({ sessionId: 's1', prompt: 'x' } as any).catch((e) => e);
    await vi.advanceTimersByTimeAsync(IDLE + 10);
    const err = await chat;
    expect(String(err.message)).toMatch(/can't be reached/);
  });
});
