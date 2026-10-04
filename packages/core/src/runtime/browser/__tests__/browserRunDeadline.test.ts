/**
 * browser_run must not hold a turn forever when a single step never returns.
 *
 * Found in a CLI trial: the first step of a script hung (the browser never answered), the
 * script budget was only checked between steps, and the tool call stayed pending for 15
 * minutes until the whole turn was torn down. Each call is now bounded by the remaining
 * budget, and a step that runs out reports failure like any other step.
 */
import { describe, it, expect } from 'vitest';
import type { Tool } from '@neox/kernel';
import { runBrowserScript, callWithDeadline } from '../browserRun.js';

const tool = (name: string, fn: (input: unknown, ctx?: { signal?: AbortSignal }) => unknown): [string, Tool] =>
  [name, { name, function: fn } as unknown as Tool];

describe('browser_run deadline', () => {
  it('fails a step that never returns once the script budget is spent', async () => {
    let sawAbort = false;
    const tools = new Map<string, Tool>([
      tool('browser_navigate', (_i, ctx) => new Promise(() => {
        ctx?.signal?.addEventListener('abort', () => { sawAbort = true; });
      })),
      tool('browser_get_state', () => JSON.stringify({ ok: true, url: 'about:blank', title: '' })),
      tool('browser_screenshot', () => JSON.stringify({ ok: true })),
      tool('browser_eval', () => JSON.stringify({ ok: true, result: {} })),
    ]);
    const started = Date.now();
    const res = await runBrowserScript(
      { steps: [{ action: 'navigate', args: { url: 'http://localhost:5173' } }], timeoutMs: 200, screenshotOnFailure: false },
      tools,
    );
    expect(res.ok).toBe(false);
    expect(res.steps[0].error).toMatch(/没有在时限内返回/);
    expect(sawAbort).toBe(true);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it('passes the caller cancellation through to the call', async () => {
    const parent = new AbortController();
    const p = callWithDeadline(
      (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
      parent.signal, Date.now() + 60_000, 'browser_click',
    );
    parent.abort();
    await expect(p).rejects.toThrow('aborted');
  });

  it('returns normally when the call finishes in time', async () => {
    await expect(callWithDeadline(() => 'done', undefined, Date.now() + 1_000, 'browser_click')).resolves.toBe('done');
  });
});
