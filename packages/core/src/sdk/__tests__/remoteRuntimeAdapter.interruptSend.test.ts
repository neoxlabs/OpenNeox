/**
 * "Enter to interrupt and send": the interrupted run's terminal event must not complete the new chat().
 *
 * Found in a CLI trial: the user typed a new requirement while a turn was running. The old run
 * was aborted and emitted its run_result; the new chat() was already listening on the same
 * session and treated that run_result as its own. The CLI printed "Done" and went idle while
 * the new run kept writing files with no spinner and no way to tell it was still working.
 */
import { describe, it, expect } from 'vitest';
import { RemoteRuntimeAdapter } from '../remoteRuntimeAdapter.js';

function makeAdapter() {
  const adapter = new RemoteRuntimeAdapter('http://127.0.0.1:1');
  const a = adapter as any;
  a.client = { chat: async () => {}, abort: async () => {} };
  a.subscription = { close: () => {} };
  a.subscribedSessionId = 's1';
  const push = (type: string, data: Record<string, unknown> = {}) =>
    a.dispatchServerEvent({ sessionId: 's1', type, data: { type, ...data } });
  return { adapter, push };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('RemoteRuntimeAdapter · interrupt and send', () => {
  it('gives each terminal event to the oldest waiting chat only', async () => {
    const { adapter, push } = makeAdapter();
    let oldDone = false; let newDone = false;
    const oldChat = adapter.chat({ sessionId: 's1', prompt: 'build goods module' } as any).then(() => { oldDone = true; });
    await flush();
    const newChat = adapter.chat({ sessionId: 's1', prompt: 'also add categories and barcodes' } as any).then(() => { newDone = true; });
    await flush();

    push('run_result', { interrupted: true, output: '' });
    await flush();
    expect(oldDone).toBe(true);
    expect(newDone).toBe(false);

    push('text_delta', { text: 'writing category.controller.ts' });
    await flush();
    expect(newDone).toBe(false);

    push('run_result', { output: 'done' });
    await Promise.all([oldChat, newChat]);
    expect(newDone).toBe(true);
  });

  it('marks the terminal event of the replaced run as superseded for UI listeners', async () => {
    const { adapter, push } = makeAdapter();
    const seen: Array<{ type: string; superseded?: boolean }> = [];
    adapter.onEvent((e: any) => { if (e.type === 'run_result') seen.push({ type: e.type, superseded: e.superseded }); });
    const a = adapter.chat({ sessionId: 's1', prompt: 'a' } as any);
    await flush();
    const b = adapter.chat({ sessionId: 's1', prompt: 'b' } as any);
    await flush();
    push('run_result', { interrupted: true });
    push('run_result', {});
    await Promise.all([a, b]);
    expect(seen).toEqual([{ type: 'run_result', superseded: true }, { type: 'run_result', superseded: undefined }]);
  });

  it('a single chat still completes on its run_result', async () => {
    const { adapter, push } = makeAdapter();
    const p = adapter.chat({ sessionId: 's1', prompt: 'hi' } as any);
    await flush();
    push('run_result', { output: 'ok' });
    await expect(p).resolves.toBeUndefined();
  });
});
