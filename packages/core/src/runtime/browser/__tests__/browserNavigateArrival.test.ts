/**
 * navigate + expectChange:{watch:"url"} to the page it is already on.
 *
 * navigate returns the URL it landed on, which is the proof. Waiting for the URL to change
 * never ends when the target is the current page, so the step would sit out the whole
 * timeout and then fail.
 */
import { describe, it, expect } from 'vitest';
import type { Tool } from '@neox/kernel';
import { runBrowserScript } from '../browserRun.js';

const URL = 'https://www.baidu.com/s?wd=qq';
const t = (name: string, fn: () => unknown): [string, Tool] =>
  [name, { name, function: async () => JSON.stringify(fn()) } as unknown as Tool];
const tools = new Map<string, Tool>([
  t('browser_navigate', () => ({ ok: true, url: URL, title: 'qq_百度搜索' })),
  t('browser_get_state', () => ({ ok: true, url: URL, title: 'qq_百度搜索' })),
  t('browser_eval', () => ({ ok: true, result: '/s?wd=qq' })),
  t('browser_click', () => ({ ok: true })),
]);

describe('navigate arrival', () => {
  it('passes at once when it lands on the page it was already on', async () => {
    const started = Date.now();
    const r = await runBrowserScript({
      steps: [{ action: 'navigate', args: { url: URL }, expectChange: { watch: 'url', timeoutMs: 3000 } }],
    }, tools);
    expect(r.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('a click that does not move the URL still fails its url watch', async () => {
    const r = await runBrowserScript({
      steps: [{ action: 'click', args: { selector: '#page a' }, expectChange: { watch: 'url', timeoutMs: 300 } }],
    }, tools);
    expect(r.ok).toBe(false);
  });
});
