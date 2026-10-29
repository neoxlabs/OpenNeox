import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { ToolCategory } from '@neoxlabs/kernel/types/permissions.js';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';
import { ensureHeadlessBrowser } from '../../runtime/browser/headlessBrowser.js';
import { buildImageToolResult } from '../image/imageProcessor.js';

type Step = { click?: string; type?: string; text?: string; press?: string; wait?: number };

interface CheckPageArgs {
  target: string;
  widths?: number[];
  height?: number;
  full_page?: boolean;
  steps?: Step[];
  /** 旧参数: 等价于 steps 里只有 click */
  click?: string[];
  color_scheme?: 'light' | 'dark' | 'both';
  eval?: string;
  wait_ms?: number;
}

export interface WidthReport {
  width: number;
  overflowPx: number;
  offenders: string[];
  tinyText: number;
}

/** 把一个宽度下量到的数字变成一行人话 (纯函数, 便于单测) */
export function describeWidth(r: WidthReport): string {
  const parts: string[] = [];
  parts.push(r.overflowPx > 0 ? `横向溢出 ${r.overflowPx}px` : '无横向溢出');
  if (r.offenders.length) parts.push(`超出右边界: ${r.offenders.join(', ')}`);
  if (r.tinyText > 0) parts.push(`${r.tinyText} 处文字小于 12px`);
  return `${r.width}px: ${parts.join('; ')}`;
}

export function resolveTarget(target: string, workspace: string): { url: string; label: string } | { error: string } {
  const t = String(target ?? '').trim();
  if (!t) return { error: 'target is required (an .html file or a URL)' };
  if (/^(https?|file):/i.test(t)) return { url: t, label: t };
  const abs = path.isAbsolute(t) ? t : path.join(workspace, t);
  if (!fs.existsSync(abs)) return { error: `file not found: ${abs}` };
  return { url: pathToFileURL(abs).href, label: path.basename(abs) };
}

/** steps + 旧的 click 合成一串 (纯函数) */
export function normalizeSteps(args: Pick<CheckPageArgs, 'steps' | 'click'>): Step[] {
  const steps = Array.isArray(args.steps) ? args.steps.filter((s) => s && typeof s === 'object') : [];
  const clicks = Array.isArray(args.click) ? args.click.map((c) => ({ click: String(c) })) : [];
  return [...clicks, ...steps].slice(0, 20);
}

/* ── 常驻的后台浏览器: 开一次, 2 分钟没人用再关 ──────────────────────────── */
type PwBrowser = import('playwright-core').Browser;
let shared: Promise<PwBrowser> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_MS = 2 * 60_000;

async function getBrowser(): Promise<PwBrowser> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (shared) {
    const b = await shared.catch(() => null);
    if (b?.isConnected()) return b;
    shared = null;
  }
  shared = (async () => {
    const exe = await ensureHeadlessBrowser();
    const { chromium } = await import('playwright-core');
    const b = await chromium.launch({ executablePath: exe, headless: true, args: ['--hide-scrollbars', '--force-color-profile=srgb', '--mute-audio'] });
    b.on('disconnected', () => { shared = null; });
    return b;
  })();
  shared.catch(() => { shared = null; });
  return shared;
}

function releaseLater(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const s = shared; shared = null; idleTimer = null;
    void s?.then((b) => b.close()).catch(() => {});
  }, IDLE_MS);
  idleTimer.unref?.();
}

/* 在页面里跑: 量溢出、找出超出右边界的元素、数小字。只读, 不改页面。 */
const MEASURE = `(() => {
  const vw = window.innerWidth;
  const doc = document.documentElement;
  const overflowPx = Math.max(0, Math.round(doc.scrollWidth - doc.clientWidth));
  const name = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    const txt = (el.innerText || '').trim().slice(0, 12);
    return el.tagName.toLowerCase() + id + cls + (txt ? '「' + txt + '」' : '');
  };
  const offenders = [];
  let tinyText = 0;
  for (const el of document.body ? document.body.querySelectorAll('*') : []) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > vw + 1 && offenders.length < 5) {
      let p = el.parentElement, scroller = false;
      while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') { scroller = true; break; } p = p.parentElement; }
      if (!scroller && !offenders.some((o) => o.el.contains(el))) offenders.push({ el, s: name(el) + ' 右边到 ' + Math.round(r.right) + 'px' });
    }
    if (el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && parseFloat(cs.fontSize) < 12) tinyText++;
  }
  return { overflowPx, offenders: offenders.map((o) => o.s), tinyText, title: document.title };
})()`;

export const checkPageTool: Tool = {
  name: 'check_page',
  description: `Self-check a page you built or changed (HTML file or local dev server URL): renders it in a hidden background browser at several widths in one call and returns a screenshot per width plus measured problems (overflow, elements past the right edge, tiny text, console errors, failed loads). Use \`steps\` to reach a state first, \`color_scheme:"both"\` for dark mode, \`eval\` for a custom check. Prefer this over opening the browser; browser_* is for operating real websites.`,
  group: 'read',
  timeoutMs: 3 * 60_000,
  parameters: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'HTML file (absolute or workspace-relative) or a URL (http://localhost:… / https://…)' },
      widths: { type: 'array', items: { type: 'number' }, description: 'Window widths in px. Default [1440, 768, 390]' },
      height: { type: 'number', description: 'Window height in px. Default 900' },
      full_page: { type: 'boolean', description: 'Screenshot the whole page (capped at 2400px tall) instead of the first screen. Default false' },
      steps: {
        type: 'array',
        description: 'Interactions before the screenshot, in order. Each item is one of {click: selector} | {type: selector, text} | {press: key} | {wait: ms}. Selectors: CSS or text=报名',
        items: {
          type: 'object',
          properties: {
            click: { type: 'string' }, type: { type: 'string' }, text: { type: 'string' },
            press: { type: 'string' }, wait: { type: 'number' },
          },
        },
      },
      color_scheme: { type: 'string', enum: ['light', 'dark', 'both'], description: 'Default light; both = one light + one dark shot per width' },
      eval: { type: 'string', description: 'Optional JS expression evaluated in the page after the steps; its result (JSON, ≤1500 chars) is added to the report' },
      wait_ms: { type: 'number', description: 'Extra wait after load and after each step, for animations. Default 400' },
    },
    required: ['target'],
  },
  permission: { category: ToolCategory.READ, allowInAskMode: true },

  async function(args: CheckPageArgs): Promise<string> {
    const workspace = getWorkspaceRootFromContext() ?? process.cwd();
    const resolved = resolveTarget(args.target, workspace);
    if ('error' in resolved) return JSON.stringify({ status: 'error', error: resolved.error });
    const widths = (Array.isArray(args.widths) && args.widths.length ? args.widths : [1440, 768, 390])
      .map((w) => Math.round(Number(w))).filter((w) => w >= 200 && w <= 3840).slice(0, 5);
    const height = Math.min(2000, Math.max(300, Math.round(Number(args.height) || 900)));
    const waitMs = Math.min(5000, Math.max(0, Number(args.wait_ms ?? 400)));
    const steps = normalizeSteps(args);
    const schemes: Array<'light' | 'dark'> = args.color_scheme === 'both' ? ['light', 'dark'] : [args.color_scheme === 'dark' ? 'dark' : 'light'];

    let browser: PwBrowser;
    try {
      browser = await getBrowser();
    } catch (e: any) {
      return JSON.stringify({ status: 'error', error: `background browser unavailable (first use downloads it once, needs internet): ${e?.message ?? e}` });
    }
    const t0 = Date.now();
    const errors = new Set<string>();
    let title = '';
    let evalOut = '';

    const shoot = async (width: number, scheme: 'light' | 'dark') => {
      const label = schemes.length > 1 ? `${width}px ${scheme === 'dark' ? '深色' : '浅色'}` : `${width}px`;
      const lines: string[] = [];
      const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: scheme });
      try {
        const page = await ctx.newPage();
        page.on('console', (m) => { if (m.type() === 'error') errors.add(`console: ${m.text().slice(0, 200)}`); });
        page.on('pageerror', (e) => errors.add(`script error: ${String(e?.message ?? e).slice(0, 200)}`));
        page.on('requestfailed', (r) => errors.add(`failed to load: ${r.url().slice(0, 160)}`));
        page.on('response', (r) => { if (r.status() >= 400) errors.add(`HTTP ${r.status()}: ${r.url().slice(0, 160)}`); });
        await page.goto(resolved.url, { waitUntil: 'load', timeout: 30_000 });
        await page.evaluate(() => (globalThis as any).document?.fonts?.ready).catch(() => {});
        await page.waitForTimeout(waitMs);
        for (const s of steps) {
          try {
            if (s.click) await page.click(s.click, { timeout: 3000 });
            else if (s.type) await page.fill(s.type, String(s.text ?? ''), { timeout: 3000 });
            else if (s.press) await page.keyboard.press(s.press);
            else if (s.wait) await page.waitForTimeout(Math.min(5000, Number(s.wait)));
            await page.waitForTimeout(waitMs);
          } catch {
            lines.push(`${label}: 步骤没做成 ${JSON.stringify(s)}`);
          }
        }
        const m = await page.evaluate(MEASURE) as WidthReport & { title: string };
        title = title || m.title;
        lines.unshift(describeWidth({ ...m, width }).replace(`${width}px`, label));
        if (args.eval && !evalOut) {
          try {
            const v = await page.evaluate(args.eval);
            evalOut = JSON.stringify(v)?.slice(0, 1500) ?? 'undefined';
          } catch (e: any) {
            evalOut = `eval 出错: ${String(e?.message ?? e).split('\n')[0]}`;
          }
        }
        const fullH = args.full_page ? Math.min(2400, await page.evaluate(() => (globalThis as any).document.documentElement.scrollHeight)) : 0;
        const buf = await page.screenshot({ type: 'jpeg', quality: 70, ...(fullH ? { fullPage: true, clip: { x: 0, y: 0, width, height: fullH } } : {}) });
        return { lines, image: { base64: buf.toString('base64'), mediaType: 'image/jpeg', label } };
      } catch (e: any) {
        return { lines: [...lines, `${label}: 打不开 —— ${String(e?.message ?? e).split('\n')[0]}`], image: null };
      } finally {
        await ctx.close().catch(() => {});
      }
    };

    const jobs = widths.flatMap((w) => schemes.map((s) => shoot(w, s)));
    const results = await Promise.all(jobs);
    releaseLater();

    const images = results.flatMap((r) => (r.image ? [r.image] : []));
    const report = [
      `check_page ${resolved.label}${title ? `「${title}」` : ''} · ${widths.join(' / ')}px · ${Date.now() - t0}ms`,
      ...results.flatMap((r) => r.lines),
      ...(evalOut ? [`eval: ${evalOut}`] : []),
      errors.size ? `报错 / 加载失败 (${errors.size}):\n- ${[...errors].slice(0, 8).join('\n- ')}` : '控制台无报错, 资源全部加载成功',
      '截图按宽度顺序附上。问题合并成一次修改; 改完不必再全量复查。',
    ].join('\n');
    return images.length ? buildImageToolResult(images, report) : report;
  },
};
