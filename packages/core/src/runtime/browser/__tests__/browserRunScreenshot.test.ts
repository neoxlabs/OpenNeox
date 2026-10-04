/**
 * A screenshot step inside browser_run must reach the model as an image.
 *
 * Left as a clipped `__NEOX_IMAGE_RESULT__` payload inside the step JSON, the marker is not at the
 * start of the content, the kernel cannot recognise it, and the model receives a stub of base64
 * text instead of a picture.
 */
import { describe, it, expect } from 'vitest';
import type { Tool } from '@neox/kernel';
import { runBrowserScript, makeBrowserRunTool } from '../browserRun.js';
import { IMAGE_RESULT_PREFIX, buildImageToolResult, parseImageResultImages } from '../../../tools/image/imageProcessor.js';

const BIG = 'A'.repeat(20_000);
const t = (name: string, fn: () => unknown): [string, Tool] =>
  [name, { name, function: async () => { const v = fn(); return typeof v === 'string' ? v : JSON.stringify(v); } } as unknown as Tool];
const tools = new Map<string, Tool>([
  t('browser_screenshot', () => buildImageToolResult([{ base64: BIG, mediaType: 'image/jpeg', label: 'Browser screenshot' }])),
  t('browser_get_state', () => ({ ok: true, url: 'https://example.com/', title: 'x' })),
  t('browser_eval', () => ({ ok: true, result: '' })),
]);

describe('browser_run screenshots', () => {
  it('lifts the picture out of the step output, whole', async () => {
    const r = await runBrowserScript({ steps: [{ action: 'screenshot', label: '看图题' }] }, tools);
    expect(r.ok).toBe(true);
    expect(r.steps[0]!.output).toBe('[截图 → 附图 1]');
    expect(r.steps[0]!.slowHint).toBeUndefined();
    expect(r.images).toHaveLength(1);
    expect(r.images![0]!.base64).toBe(BIG);
    expect(r.images![0]!.label).toContain('看图题');
  });

  it('the tool content is an image result whose text is the step JSON, without base64', async () => {
    const tool = makeBrowserRunTool(() => tools);
    const out = await (tool as any).function({ steps: [{ action: 'screenshot' }] }, {});
    const content = (typeof out === 'string' ? JSON.parse(out) : out).content as string;
    expect(content.startsWith(IMAGE_RESULT_PREFIX)).toBe(true);
    expect(parseImageResultImages(content)![0]!.base64).toBe(BIG);
    const text = JSON.parse(content.slice(IMAGE_RESULT_PREFIX.length)).text as string;
    expect(text).toContain('[截图 → 附图 1]');
    expect(text).not.toContain(BIG.slice(0, 100));
  });

  it('no screenshot, no image wrapper', async () => {
    const tool = makeBrowserRunTool(() => tools);
    const out = await (tool as any).function({ steps: [{ action: 'eval', args: { expression: '1' } }] }, {});
    const content = (typeof out === 'string' ? JSON.parse(out) : out).content as string;
    expect(content.startsWith('{')).toBe(true);
  });
});
