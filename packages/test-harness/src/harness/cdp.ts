import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');

export type CdpSession = {
  app: { contexts: () => Array<{ pages: () => Array<CdpPage> }>; close: () => Promise<void> };
  page: CdpPage;
  outDir: string;
};

export type CdpPage = {
  url: () => string;
  evaluate: <T>(fn: (...args: any[]) => T | Promise<T>, arg?: unknown) => Promise<T>;
  waitForFunction: (fn: () => unknown, opts?: { timeout?: number }) => Promise<unknown>;
  screenshot: (opts: { path: string; fullPage?: boolean }) => Promise<Buffer | void>;
};

/**
 * Attach to a running Neox Desktop (NEOX_CDP_PORT=41777).
 * Callers must unset HTTP_PROXY — use `env -u HTTP_PROXY -u HTTPS_PROXY`.
 */
export async function connectDesktopCdp(opts?: {
  cdpUrl?: string;
  outDir?: string;
  timeoutMs?: number;
}): Promise<CdpSession> {
  const cdpUrl = opts?.cdpUrl || process.env.NEOX_CDP || 'http://127.0.0.1:41777';
  const outDir = opts?.outDir || resolve(process.cwd(), '.tmp-test/neox-test-run');
  mkdirSync(outDir, { recursive: true });

  const { chromium } = createRequire(resolve(REPO_ROOT, 'packages/core/package.json'))(
    'playwright-core',
  );

  const app = await chromium.connectOverCDP(cdpUrl);
  const page = await waitRenderer(app, opts?.timeoutMs ?? 180_000);
  return { app, page, outDir };
}

async function waitRenderer(app: CdpSession['app'], timeoutMs: number): Promise<CdpPage> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const ctx of app.contexts()) {
      for (const p of ctx.pages()) {
        const url = p.url();
        if (url.includes(':5180') && !url.includes('pet.html') && !url.startsWith('devtools://')) {
          try {
            await p.waitForFunction(() => !!(window as any).neox?.getAppInfo, { timeout: 4_000 });
            return p as CdpPage;
          } catch {
            /* keep polling */
          }
        }
      }
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error(`renderer not found within ${timeoutMs}ms (is Desktop up with NEOX_CDP_PORT?)`);
}

export async function screenshot(page: CdpPage, outDir: string, name: string): Promise<string> {
  const path = resolve(outDir, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  return path;
}
