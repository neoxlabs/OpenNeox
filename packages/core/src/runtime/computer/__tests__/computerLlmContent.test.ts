import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';

const state: { snap: any } = { snap: null };
vi.mock('../computerRun.js', () => ({
  computerSnapshot: async () => state.snap,
  runComputerScript: async () => ({ ok: true }),
}));
vi.mock('../appIcon.js', () => ({ appIconPath: async () => undefined }));

const { computerSnapshotTool, __resetComputerViewState } = await import('../computerToolDefs.js');
const { IMAGE_RESULT_PREFIX } = await import('../../../tools/image/imageProcessor.js');

/* 跟 kernel extractToolImages / extractToolImageText 同一个协议: 前缀 + {images, text} */
function extractToolImages(content: string): unknown[] | null {
  return content.startsWith(IMAGE_RESULT_PREFIX) ? JSON.parse(content.slice(IMAGE_RESULT_PREFIX.length)).images : null;
}
function extractToolImageText(content: string): string | undefined {
  return JSON.parse(content.slice(IMAGE_RESULT_PREFIX.length)).text;
}

const dir = mkdtempSync(join(tmpdir(), 'cu-llm-'));
async function png(name: string, dark = false): Promise<string> {
  const p = join(dir, name);
  const img = sharp({ create: { width: 400, height: 300, channels: 3, background: dark ? '#202020' : '#f0f0f0' } });
  writeFileSync(p, await img.png().toBuffer());
  return p;
}
const lines = (n: number, extra: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, k) => `${k + 1}. [Button] ${extra[k + 1] ?? `b${k + 1}`}`);

async function call(args: any = { app: 'QQ' }, sessionId = 'sess1') {
  const raw = await computerSnapshotTool.function(args, { sessionId, modelName: 'gpt-5.5' });
  const outer = JSON.parse(raw as string);
  const content: string = outer.content;
  const images = extractToolImages(content);
  const text = images ? extractToolImageText(content) : content;
  return { images, json: JSON.parse(text!) };
}

beforeEach(() => __resetComputerViewState());

describe('computer 回执', () => {
  it('带截图时编号表照样在文本里 (修之前只剩图)', async () => {
    state.snap = { app: 'QQ', windowTitle: 'QQ', actionable: lines(20), digest: 'hello', axBlind: false, screenshot: await png('a.png') };
    const r = await call();
    expect(r.images?.length).toBe(1);
    expect(r.json.actionable).toHaveLength(20);
    expect(r.json.digest).toBe('hello');
  });

  it('同一窗口第二次: 只发差异, 画面没变不再发图', async () => {
    const shot = await png('b.png');
    state.snap = { app: 'QQ', windowTitle: 'QQ', actionable: lines(20), digest: 'd', axBlind: false, screenshot: shot };
    await call();
    state.snap = { ...state.snap, actionable: lines(20, { 3: 'renamed' }) };
    const r = await call();
    expect(r.images).toBeNull();
    expect(r.json.actionable).toBeUndefined();
    expect(r.json.screenDelta.changed).toEqual(['3. [Button] renamed']);
    expect(r.json.screenDelta.digest).toBe('unchanged');
    expect(String(r.json.screenshot)).toMatch(/^unchanged/);
  });

  it('画面变了照样发图', async () => {
    state.snap = { app: 'QQ', windowTitle: 'QQ', actionable: lines(20), axBlind: false, screenshot: await png('c.png') };
    await call();
    state.snap = { ...state.snap, screenshot: await png('d.png', true) };
    const r = await call();
    expect(r.images?.length).toBe(1);
  });

  it('换窗口 / full:true / 别的会话 → 整份', async () => {
    const shot = await png('e.png');
    state.snap = { app: 'QQ', windowTitle: 'QQ', actionable: lines(20), axBlind: false, screenshot: shot };
    await call();
    state.snap = { ...state.snap, windowTitle: '设置' };
    expect((await call()).json.actionable).toHaveLength(20);
    const full = await call({ app: 'QQ', full: true });
    expect(full.json.actionable).toHaveLength(20);
    expect(full.images?.length).toBe(1);
    expect((await call({ app: 'QQ' }, 'agent_x')).json.actionable).toHaveLength(20);
  });
});
