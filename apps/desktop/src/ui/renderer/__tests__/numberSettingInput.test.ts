import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Browser interaction is required: Escape synchronously blurs before React re-renders.
describe.skipIf(!existsSync(chromium.executablePath()))('NumberSettingInput browser regression', () => {
  let browser: Browser;
  let page: Page;
  let bundle: string;

  beforeAll(async () => {
    const result = await build({
      stdin: {
        contents: `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { NumberSettingInput } from './components/settings-base/NumberSettingInput';
          window.commits = [];
          function App() {
            const [value, setValue] = React.useState(undefined);
            window.resetValue = setValue;
            return <><NumberSettingInput value={value} min={10} max={3600}
              ariaLabel="Timeout" onCommit={next => {
                window.commits.push(next);
                setValue(next);
              }} /><button>Outside</button></>;
          }
          createRoot(document.getElementById('root')).render(<App />);
        `,
        loader: 'tsx',
        resolveDir: fileURLToPath(new URL('../', import.meta.url)),
      },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    bundle = result.outputFiles[0].text;
    browser = await chromium.launch({ headless: true });
  }, 20000);

  beforeEach(async () => {
    page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle });
    await page.getByRole('spinbutton').waitFor();
  });

  afterEach(async () => { await page?.close(); });
  afterAll(async () => { await browser?.close(); });

  const commits = () => page.evaluate(() => (window as any).commits);
  async function setValue(value: number) {
    await page.evaluate(value => (window as any).resetValue(value), value);
    await page.waitForFunction(value => document.querySelector('input')?.value === String(value), value);
  }

  it('keeps an unset value empty and does not persist the minimum on blur', async () => {
    const input = page.getByRole('spinbutton');
    expect(await input.inputValue()).toBe('');
    await input.focus();
    await page.getByRole('button').click();
    expect(await commits()).toEqual([]);
    expect(await input.inputValue()).toBe('');
  });

  it('does not clamp an unchanged value on focus/blur', async () => {
    await setValue(0);
    await page.getByRole('spinbutton').focus();
    await page.getByRole('button').click();
    expect(await commits()).toEqual([]);
  });

  it('clearing restores the current value without committing 10', async () => {
    await setValue(120);
    const input = page.getByRole('spinbutton');
    await input.fill('');
    await input.press('Tab');
    expect(await input.inputValue()).toBe('120');
    expect(await commits()).toEqual([]);
  });

  it('Escape discards edits before the synchronous blur handler runs', async () => {
    await setValue(120);
    const input = page.getByRole('spinbutton');
    await input.fill('10');
    await input.press('Escape');
    expect(await input.inputValue()).toBe('120');
    expect(await commits()).toEqual([]);
  });

  it('accepts multi-digit edits on Enter without clamping while typing', async () => {
    await setValue(120);
    const input = page.getByRole('spinbutton');
    await input.fill('');
    await input.pressSequentially('90');
    expect(await input.inputValue()).toBe('90');
    expect(await commits()).toEqual([]);
    await input.press('Enter');
    expect(await commits()).toEqual([90]);
  });

  it.each([['5', 10], ['4000', 3600]] as const)('clamps an explicit edit of %s to %s', async (text, expected) => {
    const input = page.getByRole('spinbutton');
    await input.fill(text);
    await input.press('Tab');
    expect(await commits()).toEqual([expected]);
  });
});
