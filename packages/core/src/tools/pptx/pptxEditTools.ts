/**
 * pptx_read / pptx_replace_text —— 读、改用户已有的 .pptx (版式、字体、图片、动画一概不动)。
 * 纯文字逻辑在 pptxText.ts (渲染端附件解析也用它); 这一层管路径、写盘原子性和写完回读校验。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import JSZip from 'jszip';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { ToolCategory } from '@neoxlabs/kernel/types/permissions.js';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';
import { readDeck, slidesToMarkdown, replaceTextInSlideXml, extractSlideText } from './pptxText.js';

const MAX_BYTES = 200 * 1024 * 1024;

function resolvePath(p: string): string {
  const workspace = getWorkspaceRootFromContext() ?? process.env.NEOX_WORKDIR ?? process.cwd();
  return path.isAbsolute(p) ? p : path.join(workspace, p);
}

function checkPptx(abs: string): string | null {
  if (!fs.existsSync(abs)) return `文件不存在: ${abs}`;
  if (!/\.pptx$/i.test(abs)) return `只支持 .pptx (${path.extname(abs)} 请先另存为 .pptx)`;
  if (fs.statSync(abs).size > MAX_BYTES) return '文件太大';
  return null;
}

/** "1-3,5" / [1,3] → 1 起的页号集合; 空 = 全部 */
export function parseSlideSelector(sel: unknown): Set<number> | null {
  if (sel === undefined || sel === null || sel === '') return null;
  const out = new Set<number>();
  const parts = Array.isArray(sel) ? sel.map(String) : String(sel).split(',');
  for (const raw of parts) {
    const p = raw.trim();
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(p);
    if (range) { for (let i = Number(range[1]); i <= Number(range[2]); i++) out.add(i); continue; }
    if (/^\d+$/.test(p)) out.add(Number(p));
  }
  return out.size ? out : null;
}

async function openDeck(abs: string): Promise<JSZip> {
  return JSZip.loadAsync(fs.readFileSync(abs));
}

const zipReader = (zip: JSZip) => async (p: string) => (await zip.file(p)?.async('string')) ?? null;

export const pptxReadTool: Tool = {
  name: 'pptx_read',
  description: `Read an existing .pptx the user has: slide-by-slide titles, body text, tables (and optionally speaker notes), in presentation order. Use before pptx_replace_text, or to summarize / check a deck.

- slides: optional "1-3,7" to read part of a big deck
- include_notes: also return speaker notes
Charts, SmartArt and text inside images are not extracted.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: true,
  permission: { category: ToolCategory.READ, allowInAskMode: true },
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '.pptx path (absolute or workspace-relative)' },
      slides: { type: 'string', description: 'Slide selector, 1-based, e.g. "1-3,7". Default: all' },
      include_notes: { type: 'boolean', description: 'Include speaker notes' },
    },
    required: ['file_path'],
  },
  async function(args: { file_path: string; slides?: string; include_notes?: boolean }): Promise<string> {
    try {
      const abs = resolvePath(args.file_path);
      const bad = checkPptx(abs);
      if (bad) return JSON.stringify({ error: bad });
      const zip = await openDeck(abs);
      const all = await readDeck(zipReader(zip), { notes: args.include_notes === true });
      const sel = parseSlideSelector(args.slides);
      const picked = sel ? all.filter((s) => sel.has(s.index)) : all;
      const md = slidesToMarkdown(picked, { notes: args.include_notes === true });
      return `file=${abs} · ${all.length} slides${sel ? ` · showing ${picked.map((s) => s.index).join(',')}` : ''}\n\n${md || '(no text)'}`;
    } catch (e: any) {
      return JSON.stringify({ error: e?.message || String(e) });
    }
  },
};

export const pptxReplaceTextTool: Tool = {
  name: 'pptx_replace_text',
  description: `Replace text **in place** in an existing .pptx — layout, fonts, colors, images, animations untouched. Use this for "把第 3 页的 1,280 改成 1,350 / 把张三换成李四 / 把 Q2 都改成 Q3" instead of regenerating the deck.

- replacements: [{ find, replace }, ...] applied in order
- Works across formatting runs inside a paragraph (e.g. a bold number in the middle of a sentence); the replacement takes the formatting of the run where the match starts.
- slides: optional "2,5-7" to limit scope; default all slides (titles, body, tables; not speaker notes, charts or SmartArt)
- save_as: write to a new path instead of overwriting
Read with pptx_read first so the find text matches exactly (same full-width/half-width punctuation and thousands separators).

Returns JSON: { ok, file_path, results:[{find, replace, count, slides:[...]}], total }.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  permission: { category: ToolCategory.WRITE, allowInAskMode: false },
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '.pptx path' },
      replacements: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            find: { type: 'string', description: 'Exact text to find (may span formatting runs within one paragraph)' },
            replace: { type: 'string', description: 'Replacement text' },
          },
          required: ['find', 'replace'],
        },
      },
      slides: { type: 'string', description: 'Slide selector, 1-based, e.g. "2,5-7". Default: all' },
      save_as: { type: 'string', description: 'Optional output path; default overwrites file_path' },
    },
    required: ['file_path', 'replacements'],
  },
  async function(args: { file_path: string; replacements: Array<{ find: string; replace: string }>; slides?: string; save_as?: string }): Promise<string> {
    try {
      const abs = resolvePath(args.file_path);
      const bad = checkPptx(abs);
      if (bad) return JSON.stringify({ error: bad });
      const reps = (Array.isArray(args.replacements) ? args.replacements : [])
        .filter((r) => r && typeof r.find === 'string' && r.find.length > 0)
        .map((r) => ({ find: r.find, replace: String(r.replace ?? '') }));
      if (reps.length === 0) return JSON.stringify({ error: 'replacements 不能为空' });

      const zip = await openDeck(abs);
      const deck = await readDeck(zipReader(zip));
      const sel = parseSlideSelector(args.slides);
      const targets = sel ? deck.filter((s) => sel.has(s.index)) : deck;

      const results = reps.map((r) => ({ ...r, count: 0, slides: [] as number[] }));
      /* 每页记下是哪几条替换命中了它 —— 回读时只查这几条 (第 1 页只换了人名, 不该去那里找营收数字) */
      const changed = new Map<string, { xml: string; hits: number[] }>();
      for (const s of targets) {
        let xml = (await zip.file(s.path)!.async('string'));
        const hits: number[] = [];
        results.forEach((r, ri) => {
          const out = replaceTextInSlideXml(xml, r.find, r.replace);
          if (out.count > 0) {
            xml = out.xml; r.count += out.count; r.slides.push(s.index); hits.push(ri);
          }
        });
        if (hits.length) changed.set(s.path, { xml, hits });
      }
      const total = results.reduce((n, r) => n + r.count, 0);
      if (total === 0) {
        return JSON.stringify({ ok: false, file_path: abs, results, total, hint: '一处都没找到 —— 用 pptx_read 看原文 (全角/半角标点、千分位、空格要一致)' });
      }

      /* 回读校验: 改过的页重新抽文字, 替换内容必须在、每条 find 的出现次数必须不增 */
      for (const [p, c] of changed) zip.file(p, c.xml);
      const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      const verify = await JSZip.loadAsync(out);
      for (const [p, c] of changed) {
        const x = await verify.file(p)?.async('string');
        if (!x) throw new Error(`写完回读缺 ${p}, 已放弃写盘, 原文件没动`);
        const t = extractSlideText(x);
        const flat = [t.title, ...t.paragraphs, ...t.tables.flat(2)].join('\n');
        for (const ri of c.hits) {
          const r = results[ri];
          if (r.replace && !flat.includes(r.replace.split('\n')[0])) {
            throw new Error(`写完回读 ${p} 里找不到「${r.replace}」, 已放弃写盘, 原文件没动`);
          }
        }
      }

      const target = args.save_as ? resolvePath(args.save_as) : abs;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = path.join(path.dirname(target), `.${path.basename(target)}.neox-tmp-${process.pid}`);
      fs.writeFileSync(tmp, out);
      fs.renameSync(tmp, target);
      return JSON.stringify({ ok: true, file_path: target, results, total, hint: '文件如果正开在 PowerPoint/Keynote 里, 关掉重开才看得到。' });
    } catch (e: any) {
      return JSON.stringify({ error: e?.message || String(e) });
    }
  },
};

export const PPTX_EDIT_TOOLS: Tool[] = [pptxReadTool, pptxReplaceTextTool];
