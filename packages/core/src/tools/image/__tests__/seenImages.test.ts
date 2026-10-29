import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'seen-'));
vi.mock('@neoxlabs/kernel/platform/neoxHome.js', () => ({
  neoxHome: (...parts: string[]) => path.join(home, ...parts),
}));

const { externalizeToolImages, SEEN_IMAGES_PREFIX } = await import('../seenImages.js');
const { buildImageToolResult } = await import('../imageProcessor.js');

/* 1×1 PNG, 真的能解码 */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function marker(out: string): { images: Array<{ path: string; label?: string }>; text?: string } {
  const idx = out.indexOf(SEEN_IMAGES_PREFIX);
  expect(idx).toBeGreaterThanOrEqual(0);
  return JSON.parse(out.slice(idx + SEEN_IMAGES_PREFIX.length));
}

describe('externalizeToolImages', () => {
  beforeAll(() => { fs.rmSync(path.join(home, 'run'), { recursive: true, force: true }); });

  it('整条是图片载荷: 落盘, 换成路径标记, 不再带 base64', () => {
    const out = externalizeToolImages(buildImageToolResult([{ base64: PNG, mediaType: 'image/png', label: 'logo.png' }], '附带的文字'));
    expect(out).not.toContain(PNG);
    const m = marker(out);
    expect(m.images).toHaveLength(1);
    expect(m.images[0].label).toBe('logo.png');
    expect(m.text).toBe('附带的文字');
    expect(fs.readFileSync(m.images[0].path).equals(Buffer.from(PNG, 'base64'))).toBe(true);
  });

  it('同一张图只存一份', () => {
    const a = marker(externalizeToolImages(buildImageToolResult([{ base64: PNG, mediaType: 'image/png' }])));
    const b = marker(externalizeToolImages(buildImageToolResult([{ base64: PNG, mediaType: 'image/png' }])));
    expect(a.images[0].path).toBe(b.images[0].path);
  });

  it('contextual 信封 (browser_run 带截图): 信封和 metadata 留着, 只换 content', () => {
    const env = { type: 'contextual', status: 'success', tool: 'browser_run', summary: '浏览器 · 1/1 步', content: buildImageToolResult([{ base64: PNG, mediaType: 'image/jpeg', label: '整页截图' }]), metadata: { steps: 1 } };
    const out = externalizeToolImages(JSON.stringify(env));
    const parsed = JSON.parse(out);
    expect(parsed.tool).toBe('browser_run');
    expect(parsed.metadata).toEqual({ steps: 1 });
    expect(marker(parsed.content).images[0].path).toMatch(/\.jpg$/);
  });

  it('前面挂着提示头: 头留着, 载荷换掉', () => {
    const out = externalizeToolImages(`⏱️ [tool took 8.5s]\n${buildImageToolResult([{ base64: PNG, mediaType: 'image/png' }])}`);
    expect(out.startsWith('⏱️ [tool took 8.5s]\n')).toBe(true);
    expect(marker(out).images).toHaveLength(1);
  });

  it('没有图 / 解不开 / 格式不认: 原样放过', () => {
    expect(externalizeToolImages('普通输出')).toBe('普通输出');
    const broken = '__NEOX_IMAGE_RESULT__{"images":[{"data":"abc';
    expect(externalizeToolImages(broken)).toBe(broken);
    const svg = buildImageToolResult([{ base64: 'PHN2Zz4=', mediaType: 'image/svg+xml' }]);
    expect(externalizeToolImages(svg)).toBe(svg);
  });
});
