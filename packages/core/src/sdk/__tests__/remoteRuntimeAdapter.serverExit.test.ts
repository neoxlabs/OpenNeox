/**
 * The daemon dies mid-turn: the waiting chat() must end as a connection error within seconds.
 *
 * Found in a CLI trial: the daemon was killed while an LLM request was in flight. The SSE stream
 * kept reconnecting to a dead port, the chat heard nothing for two minutes, and the turn ended
 * with "chat completion idle timeout". The turn is not re-sent: a crashed turn is over.
 */
import { describe, it, expect } from 'vitest';
import { RemoteRuntimeAdapter, SERVER_EXITED } from '../remoteRuntimeAdapter.js';

function makeAdapter(healthy: boolean) {
  const adapter = new RemoteRuntimeAdapter('http://127.0.0.1:1');
  const a = adapter as any;
  a.client = { chat: async () => {}, abort: async () => {}, isHealthy: async () => healthy };
  a.subscription = { close: () => {} };
  a.subscribedSessionId = 's1';
  const dropSse = () => { for (const cb of a.sseDropListeners) cb(); };
  const push = (type: string) => a.dispatchServerEvent({ sessionId: 's1', type, data: { type } });
  return { adapter, dropSse, push };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('RemoteRuntimeAdapter · server exits during a turn', () => {
  it('ends the chat as server-exited when the server is unreachable', async () => {
    const { adapter, dropSse } = makeAdapter(false);
    const chat = adapter.chat({ sessionId: 's1', prompt: 'review the backend' } as any);
    await flush();
    dropSse();
    const err = await chat.catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(SERVER_EXITED);
  });

  it('keeps waiting when the stream drops but the server still answers', async () => {
    const { adapter, dropSse, push } = makeAdapter(true);
    let settled = false;
    const chat = adapter.chat({ sessionId: 's1', prompt: 'hi' } as any).then(() => { settled = true; });
    await flush();
    dropSse();
    await flush(); await flush();
    expect(settled).toBe(false);
    push('run_result');
    await chat;
    expect(settled).toBe(true);
  });

  it('dispose ends a waiting chat instead of leaving it to the idle timer', async () => {
    const { adapter } = makeAdapter(true);
    const chat = adapter.chat({ sessionId: 's1', prompt: 'hi' } as any);
    await flush();
    adapter.dispose();
    const err = await chat.catch((e) => e);
    expect(err.code).toBe(SERVER_EXITED);
  });
});
