/**
 * P-07 回执: 内容超容量时 deck_add_slide 必须明说"缩到 14pt 还溢出多少, 建议拆页",
 * 而不是静默压成 11pt。正常页不多这一个字段 (回执多一个字每轮都烧 token)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runWithWorkspaceRoot } from '@neoxlabs/kernel/tools/workspaceContext.js';
import { deckBeginTool, deckAddSlideTool } from '../deckTools.js';

let ws: string;
const ctx = { sessionId: 'deck-fit-hint' } as any;
const call = (tool: typeof deckBeginTool, args: unknown) =>
  runWithWorkspaceRoot(ws, async () => JSON.parse(await tool.function(args as any, ctx)));

beforeAll(() => { ws = mkdtempSync(path.join(tmpdir(), 'neox-deck-fit-')); });
afterAll(() => { rmSync(ws, { recursive: true, force: true }); });

const LONG_PARA = '这一段正文写得很长, 目的是把版心撑爆 —— 每一段都有四十多个字, 整整十段一起塞进一页, '
  + '排版引擎必须缩字号才有希望装下, 而字号有下限。';

async function beginDeck() {
  const r = await call(deckBeginTool, {
    title: '容量测试',
    styleId: 'minimal-line',
    outline: [
      { title: '封面', template: 'cover-hero' },
      { title: '正文', template: 'bullet-list' },
    ],
  });
  expect(r.error).toBeUndefined();
}

describe('deck_add_slide 的容量回执', () => {
  it('文字堆到装不下 → fit.ok=false, 报溢出像素并建议拆页', async () => {
    await beginDeck();
    const cover = await call(deckAddSlideTool, { index: 0, slots: { title: '容量测试', subtitle: '回执验证' } });
    expect(cover.ok).toBe(true);
    /* 正常装得下的页不该多出 fit 字段 */
    expect(cover.fit).toBeUndefined();

    const r = await call(deckAddSlideTool, {
      index: 1,
      slots: { title: '长文本', items: Array.from({ length: 10 }, () => LONG_PARA) },
    });
    expect(r.ok).toBe(true);
    expect(r.fit).toBeTruthy();
    expect(r.fit.ok).toBe(false);
    expect(r.fit.overflowPx).toBeGreaterThan(0);
    expect(r.fit.suggestion).toMatch(/拆成两页/);
    /* 下限: 最小字号不得低于 14pt */
    expect(r.fit.minFontPt).toBeGreaterThanOrEqual(14);
  });
});
