import type { BrowserContext, Page } from 'playwright-core';
import { AGENT_TAKEOVER_BANNER_SCRIPT, bannerSyncExpr } from './agentTakeoverBanner.js';
import { getBrowserSession } from './browserSession.js';

/* Where the agent's cursor last was. A navigation builds a fresh banner, and without this the
 * cursor restarted at the dock on every page instead of staying where the agent left it. */
let lastCursor: { x: number; y: number } | null = null;

/**
 * One controller per owned context, shared by desktop and the CLI launcher.
 * Heartbeats renew live activity only; an orphaned page releases itself.
 */
export async function installBrowserTakeover(context: BrowserContext): Promise<void> {
  const session = getBrowserSession();
  let revision = 0;
  let disposed = false;
  /* Stopped or interrupted: the page is handed back and the pill goes until the agent acts again. */
  let released = false;
  const queues = new WeakMap<Page, Promise<void>>();

  function sync(page: Page): Promise<void> {
    const work = (queues.get(page) ?? Promise.resolve()).then(async () => {
      if (disposed || page.isClosed()) return;
      const current = session.getState();
      const expression = bannerSyncExpr({
        /* The pill stays for the whole turn: it shows "waiting" while the model thinks
         * instead of vanishing after each call and popping back (that read as flicker). */
        active: current.isOpen && !released,
        busy: current.refcount > 0,
        owner: current.owner,
        detail: current.detail,
        revision: ++revision,
        ...(lastCursor ? { cursor: lastCursor } : {}),
      });
      // Injection and state are atomic, so a fresh page gets the right state on first paint.
      await Promise.all(page.frames().map(frame =>
        frame.evaluate(`${AGENT_TAKEOVER_BANNER_SCRIPT}\n${expression}`).catch(() => {}),
      ));
    });
    queues.set(page, work);
    return work;
  }

  async function syncAll(): Promise<void> {
    await Promise.all(context.pages().map(sync));
  }

  await context.exposeBinding('__neoxBrowserControl', async ({ page, frame }, owner: unknown) => {
    if (disposed || frame !== page.mainFrame() || (owner !== 'agent' && owner !== 'user')) return;
    session.setControlOwner(owner);
    await syncAll();
  });
  await context.addInitScript({ content: AGENT_TAKEOVER_BANNER_SCRIPT });

  function attach(page: Page): void {
    page.on('framenavigated', () => { void sync(page); });
    void sync(page);
  }
  context.on('page', attach);
  context.pages().forEach(attach);
  const off = session.on(event => {
    if (event.type === 'control:released') released = true;
    else if (event.type === 'tool:start' || event.type === 'session:open') released = false;
    void syncAll();
  });
  let heartbeatBusy = false;
  const heartbeat = setInterval(() => {
    if (heartbeatBusy || disposed) return;
    heartbeatBusy = true;
    void syncAll().finally(() => { heartbeatBusy = false; });
  }, 2000);
  heartbeat.unref();
  context.once('close', () => {
    disposed = true;
    clearInterval(heartbeat);
    off();
    context.off('page', attach);
    session.reset();
  });
  await syncAll();
}

/** Coordinates come from agent tools, never the user's physical mouse events. */
export async function moveAgentCursor(page: Page, x: number, y: number, pressed = false): Promise<void> {
  getBrowserSession().assertCurrentActivity();
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  lastCursor = { x: Math.round(x), y: Math.round(y) };
  const move = (down: boolean) => page.evaluate(
    `window.__neoxAgentBanner ? window.__neoxAgentBanner.moveCursor(${x},${y},${down}) : 0`,
  ).then((ms) => (typeof ms === 'number' ? ms : 0), () => 0);
  if (!pressed) { await move(false); return; }
  /* A press lands after the glide, otherwise the click fires while the cursor is still far
   * away and the user sees it arrive after the page already changed. Waits only when the
   * cursor visibly traveled (capped at the banner's 280ms). */
  const glide = await move(false);
  if (glide > 0) await new Promise((r) => setTimeout(r, Math.min(glide, 300)));
  await move(true);
}
