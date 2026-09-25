
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { readFile, writeFile } from 'node:fs/promises';
import { Presentation, exportPptx } from '@neoxlabs/pptx-renderer';
import { inspectPptxForDelivery, describeVerdict } from '../pptxDeliveryGate.js';
import { inspectPptxFile } from '../pptxInspect.js';

let dir: string;
let goodDeck: string;
let badDeck: string;
let externalDeck: string;
let brokenDeck: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'neox-pptx-gate-'));

  /* 干净 deck: 一块居中、字号正常的文本。 */
  const good = Presentation.create({ slideSize: { width: 1280, height: 720 } });
  good.slides.add().shapes.addText(
    '季度汇报',
    { left: 120, top: 260, width: 800, height: 160 },
    { fontSize: 54, bold: true },
  );
  goodDeck = path.join(dir, 'good.pptx');
  await (await exportPptx(good)).save(goodDeck);

  /* 脏 deck: 越界 + 字号过小 + 两块重叠 —— 正是闸门要挡的那类事故。 */
  const bad = Presentation.create({ slideSize: { width: 1280, height: 720 } });
  const s = bad.slides.add();
  s.shapes.addText('标题', { left: 1100, top: 640, width: 400, height: 200 }, { fontSize: 8 });
  s.shapes.addText('重叠文字', { left: 1150, top: 660, width: 400, height: 200 }, { fontSize: 8 });
  badDeck = path.join(dir, 'bad.pptx');
  await (await exportPptx(bad)).save(badDeck);

  /* 外部 deck: 拿脏 deck 摘掉出处标记, 模拟用户自己拖进来的第三方 pptx。 */
  const zip = await JSZip.loadAsync(await readFile(badDeck));
  zip.remove('docProps/app.xml');
  externalDeck = path.join(dir, 'external.pptx');
  await writeFile(externalDeck, await zip.generateAsync({ type: 'nodebuffer' }));

  /* 结构损坏: 不是 zip */
  brokenDeck = path.join(dir, 'broken.pptx');
  await writeFile(brokenDeck, 'not a zip');
}, 120_000);

describe('出处标记', () => {
  it('引擎导出的 pptx 带 docProps/app.xml 出处标记', async () => {
    const zip = await JSZip.loadAsync(await readFile(goodDeck));
    const app = await zip.file('docProps/app.xml')!.async('string');
    expect(app).toContain('Neox Slides Engine');
  });

  it('标记部件在 [Content_Types].xml 里有 Override (少了 Office 会判包损坏)', async () => {
    const zip = await JSZip.loadAsync(await readFile(goodDeck));
    const ct = await zip.file('[Content_Types].xml')!.async('string');
    expect(ct).toContain('/docProps/app.xml');
  });
});

describe('inspectPptxFile (进程内)', () => {
  it('脏 deck 的报告里点名越界和字号过小', async () => {
    const r = await inspectPptxFile(badDeck);
    const kinds = new Set(r.issues.map((i) => i.kind));
    expect(kinds.has('out-of-bounds')).toBe(true);
    expect(kinds.has('font-too-small')).toBe(true);
    expect(r.ok).toBe(false);
    /* mustFix 必须排在最前面 —— agent 先啃这些 */
    expect(r.issues[0]!.severity === 'error' || r.mustFixCount > 0).toBe(true);
  });

  it('结构损坏直接抛, 不给默认值兜底', async () => {
    await expect(inspectPptxFile(brokenDeck)).rejects.toThrow();
  });
});

describe('inspectPptxForDelivery', () => {
  it('文件不存在 → unavailable, 绝不当作通过', async () => {
    const v = await inspectPptxForDelivery(path.join(dir, 'nope.pptx'));
    expect(v.status).toBe('unavailable');
  });

  it('文件读不开 → unavailable, 绝不当作通过', async () => {
    const v = await inspectPptxForDelivery(brokenDeck);
    expect(v.status).toBe('unavailable');
  });

  it('unavailable 的裁决必须明确禁止声称已验证', () => {
    const desc = describeVerdict({
      status: 'unavailable',
      reason: '自检读不了文件',
      userHint: '文件可能损坏',
    }) as { selfCheck: Record<string, string> };
    expect(desc.selfCheck.available).toBe(false);
    expect(desc.selfCheck.agentInstruction).toContain('禁止声称已验证');
    expect(desc.selfCheck.agentInstruction).toContain('文件可能损坏');
  });

  it('干净 deck → pass', async () => {
    const v = await inspectPptxForDelivery(goodDeck);
    expect(v.status).toBe('pass');
  }, 120_000);

  it('自家脏 deck → blocked, 带 mustFix 清单', async () => {
    const v = await inspectPptxForDelivery(badDeck);
    expect(v.status).toBe('blocked');
    if (v.status === 'blocked') {
      expect(v.report.mustFixCount).toBeGreaterThan(0);
      expect(v.report.issues.length).toBeGreaterThan(0);
    }
  }, 120_000);

  it('外部 pptx 有 mustFix 也不拦 —— 用户的文件不归我们的排版规则管', async () => {
    expect(existsSync(externalDeck)).toBe(true);
    const v = await inspectPptxForDelivery(externalDeck);
    expect(v.status).toBe('external');
    if (v.status === 'external') expect(v.report.neoxGenerated).toBe(false);
  }, 120_000);
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});
