/**
 * Stopping a run is not closing the browser.
 *
 * The default launcher closes Chrome on session:close. If stop / abort / a session switch
 * emitted it, a stop mid-turn would take every tab with it and the next browser call in the
 * same turn would fail with "No browser surface is open".
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getBrowserSession, type BrowserSessionEvent } from '../browserSession.js';

const session = getBrowserSession();
let events: string[] = [];
const noop = async () => ({ ok: true });

beforeEach(() => {
  session.reset();
  events = [];
  session.on((e: BrowserSessionEvent) => { events.push(e.type); });
});

describe('BrowserSession lifecycle', () => {
  it('stopping the run releases control but keeps the browser open', async () => {
    await session.withActivity('browser_navigate', undefined, noop, undefined, 's1');
    session.stopForSession('s1');
    expect(events).toContain('control:released');
    expect(events).not.toContain('session:close');
    expect(session.getState().isOpen).toBe(true);
  });

  it('an abort during a tool does not close the browser', async () => {
    const ac = new AbortController();
    await session.withActivity('browser_click', undefined, async () => { ac.abort(); return { ok: true }; }, ac.signal, 's1');
    expect(events).not.toContain('session:close');
    expect(session.getState().isOpen).toBe(true);
  });

  it('another session taking over the idle browser keeps it open', async () => {
    await session.withActivity('browser_navigate', undefined, noop, undefined, 's1');
    await session.withActivity('browser_navigate', undefined, noop, undefined, 's2');
    expect(events).not.toContain('session:close');
    expect(session.getState().agentSessionId).toBe('s2');
  });

  it('the turn end still closes the session', async () => {
    await session.withActivity('browser_navigate', undefined, noop, undefined, 's1');
    session.endTurn('s1');
    expect(events).toContain('session:close');
    expect(session.getState().isOpen).toBe(false);
  });

  it('a late completion after a stop does not touch the new generation', async () => {
    let finish!: () => void;
    const running = session.withActivity('browser_wait_for', undefined, () => new Promise<{ ok: true }>((r) => { finish = () => r({ ok: true }); }), undefined, 's1');
    await Promise.resolve();
    session.stopForSession('s1');
    await session.withActivity('browser_navigate', undefined, noop, undefined, 's1');
    finish();
    await running;
    expect(session.getState().refcount).toBe(0);
  });
});
