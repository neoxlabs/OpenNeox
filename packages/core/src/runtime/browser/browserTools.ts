/**
 * Browser tools — Playwright Page API 的薄封装.
 *
 *   每个 tool 返回 JSON-safe 数据, 方便后续被 agent tool registry 包一层调. 也直接
 *   暴露给 SDK 让 UI/Electron 端可调用 (调试场景 / 用户主动操作).
 *
 *   覆盖范围 (docs/NEOX_BROWSER_DESIGN.md §4):
 *     · 4.1 导航 — navigate (Day 2)
 *     · 4.2 视觉感知 — screenshot (Day 2) + get_state (Day 2)
 *     · 4.3 DOM 感知 — get_aria_tree / query / get_text (Day 3)
 *     · 4.4 交互 — click / type / press_key / scroll / hover / select_option / fill_form (Day 3)
 *
 *   定位策略 (统一通过 resolveLocator 实现 4.3/4.4 的元素选取):
 *     · selector — CSS / Playwright selector engine (推荐 agent 用)
 *     · role+name — ARIA role + 可见 name, agent 从 get_aria_tree 拿到后直接用
 *     · text — 简短文本匹配, 适合 "点'登录'按钮" 这种自然指令
 *   优先级: selector > role+name > text. 任一命中就用, 都没命中 tool 返 error.
 */

import type { Page, Locator } from 'playwright-core';
import { getBrowserManager } from './browserManager.js';
import { getBrowserHostController } from './browserHostController.js';
import { getCapture, type ConsoleLog, type NetworkLog, type DialogLog, type DialogAnswer } from './browserCapture.js';
import { wrapEvalSource, explainEmptyResult } from './browserEvalWrap.js';
import { registerMock, clearMocks, listMocks, type MockEntry } from './browserMocks.js';
import { checkBrowserUsePolicy } from './browserPolicy.js';
import { moveAgentCursor } from './browserTakeoverController.js';
import { normalizeAriaNode, cdpAxNodeToSimple, humanlikeMoveTo, loadArtifactHelpers, compareScreenshots, PAPER_SIZES, parseInches } from './browserToolsHelpers.js';

/* page.evaluate(() => window.xxx / localStorage.xxx) 的回调被 Playwright 序列化送到浏览器执行,
 * server 端没 DOM lib. ambient declare 让 tsc 不抱怨这些 identifier. */
declare const window: any;
declare const localStorage: any;
declare const document: any;
declare const getComputedStyle: (el: any) => any;
declare const Element: any;
declare const HTMLElement: any;
declare const performance: any;

/** Explain the valid surface id source and the single-surface omission fallback. */
function noSurfaceMsg(surfaceId: unknown): string {
  return `surface "${String(surfaceId)}" 不存在。surfaceId 只认 browser_list_surfaces 结果里 surfaces[].surfaceId `
    + `那个字段 (通常是 "default"); 诊断信息里的 target id 不是 surfaceId。只开着一个浏览器时不传就行。`;
}

function getHostBrowserMethod(name: string): ((args: any) => Promise<any>) | null {
  const host = getBrowserHostController() as any;
  if (!host) return null;
  const fn = host?.[name];
  if (typeof fn === 'function') return fn.bind(host);
  return async () => ({
    ok: false,
    error: `${name} is not implemented by the host BrowserView controller; global Electron CDP fallback is disabled while a host controller is registered.`,
  });
}

/* 活动信号 (banner + 生命周期) 现由 browserToolDefs.ts 里 wrap() 一处走 BrowserSession.withActivity
 * 装饰所有 browser_* tool 完成. 本文件的具体 tool impl 只管 Playwright 调用, 不再关心
 * 状态广播. 三个 globalThis hook (__NEOX_BROWSER_TOOL_ACTIVITY__ 等) 已作废. */

export interface BrowserNavigateArgs {
  surfaceId: string;
  url: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  timeout?: number;
}
export interface BrowserNavigateResult {
  ok: boolean;
  url?: string;
  title?: string;
  error?: string;
  /** 软降级说明 — 超时但页面确实在目标地址上加载中时置此, ok 仍为 true. */
  warning?: string;
}

/** 缺协议补 https —— 策略判定和真正导航必须用**同一个**归一化结果, 否则判的和开的不是一个地址。 */
function normalizeNavUrl(raw: string): string {
  const url = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('about:')) return 'https://' + url;
  return url;
}

export async function browserNavigate(args: BrowserNavigateArgs): Promise<BrowserNavigateResult> {
  /* 站点名单必须判在 **host 分发之前**。桌面端 browserNavigate 整个被宿主接管
   * (getHostBrowserMethod 直接 return), 判在下面的话打包版就等于没这道闸。 */
  const denied = checkBrowserUsePolicy(normalizeNavUrl(args.url ?? ''));
  if (denied) return { ok: false, error: denied.message };

  const host = getHostBrowserMethod('browserNavigate');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const url = normalizeNavUrl(args.url);
    /* 外置 Chrome 场景: 反查不到 window.name 时就地开 tab + 打烙印 + 顺手把 initialUrl goto 掉
     *  (createIfMissing 内部会 goto 一次, 我们不再重复 goto 以免刷两次白屏). */
    const page = await mgr.resolvePage(args.surfaceId, { createIfMissing: true, initialUrl: url });
    if (!page) {
      const detail = (mgr as any).getLastCreateIfMissingError?.() || '未知原因';
      return { ok: false, error: `surface "${args.surfaceId}" 建 tab 失败: ${detail}` };
    }
    /* createIfMissing 已经 goto 过时不重复 (page.url() 已经指到目标); 否则做正常 goto.
     * 默认等 domcontentloaded 而非 load — 慢网络/代理下 load (全部子资源) 动辄 30s+,
     * agent 拿到 DOM 就能干活. 需要全量加载显式传 waitUntil:'load'. */
    if (page.url() !== url) {
      try {
        await page.goto(url, {
          waitUntil: args.waitUntil ?? 'domcontentloaded',
          timeout: args.timeout ?? 30_000,
        });
      } catch (gotoErr: any) {
        /* Treat timeout and ERR_ABORTED as recoverable when the page has reached a usable state;
         * propagate DNS, connection, and browser-disconnect failures. */
        const msg = gotoErr?.message || '';
        const isTimeout = /Timeout .*exceeded/i.test(msg);
        const isAborted = /ERR_ABORTED/.test(msg);
        if (!isTimeout && !isAborted) throw gotoErr;
        if (isAborted) {
          /* 被二次导航打断 → 等最终落点稳定一拍. */
          await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        }
        const finalUrl = page.url();
        if (finalUrl === 'about:blank') throw gotoErr; /* 真没导过去 */
        /* 超时要求确实落在目标 origin (没 commit 的超时 = 还停在旧页, 算失败);
         * ERR_ABORTED 允许任意落点 (重定向合法跨 origin). */
        if (isTimeout && !finalUrl.startsWith(new URL(url).origin)) throw gotoErr;
        return {
          ok: true,
          url: finalUrl,
          title: await page.title().catch(() => ''),
          warning: isTimeout
            ? `导航等待超时但页面仍在加载中 (waitUntil=${args.waitUntil ?? 'domcontentloaded'}). 可直接操作已有 DOM, 或用 browser_wait_for 等目标元素. 当前落点: ${finalUrl}`
            : `本次 goto 被页面自身跳转/另一次导航打断 (ERR_ABORTED), 浏览器已落在 ${finalUrl}. 若这就是目标页可直接继续.`,
        };
      }
    }
    return {
      ok: true,
      url: page.url(),
      title: await page.title().catch(() => ''),
    };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export interface BrowserScreenshotArgs {
  surfaceId: string;
  fullPage?: boolean;
  clip?: { x: number; y: number; width: number; height: number };
  format?: 'png' | 'jpeg';
  quality?: number;
  /** 元素截图: CSS selector, 只截该元素. 优先级高于 clip. 找不到 → 返 error. */
  selector?: string;
  /** 视觉回归 baseline 名 (a-zA-Z0-9_-). 与 mode 配合:
   *   mode='save' → 存到 ~/.neox/browser-artifacts/<surfaceId>/baseline/<name>.png (无 diff)
   *   mode='compare' → 拿当前截图 vs baseline, 生成 diff png 并返 diffRatio 差异比例 */
  baseline?: string;
  /** 'save' 存新 baseline, 'compare' 拿现有 baseline 做视觉回归 diff. 未传则纯截图 */
  baselineMode?: 'save' | 'compare';
  /** compare 模式下容忍度 (像素差异比例, 0-1). 默认 0.02 (2%). 超过 → passed=false */
  diffThreshold?: number;
}
export interface BrowserScreenshotResult {
  ok: boolean;
  base64?: string;
  width?: number;
  height?: number;
  /** baseline='save' 时返 baseline 落盘路径 */
  baselinePath?: string;
  /** baseline='compare' 时返视觉回归结果 */
  diff?: {
    /** 差异像素占总像素比例 0-1 */
    ratio: number;
    /** 是否通过 (ratio <= diffThreshold) */
    passed: boolean;
    /** diff 图 base64 (红色标出差异像素) */
    diffBase64?: string;
    /** 差异总像素数 */
    diffPixels: number;
    /** 图片尺寸不一致时不做 diff, 返 error 提示 baseline 与当前尺寸不匹配 */
    error?: string;
  };
  error?: string;
}

export async function browserScreenshot(args: BrowserScreenshotArgs): Promise<BrowserScreenshotResult> {
  const host = getHostBrowserMethod('browserScreenshot');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };

    let buf: Buffer;
    /* 元素截图: selector 存在优先 — Playwright locator.screenshot 帮我们处理滚动/透明/边界 */
    if (args.selector) {
      const loc = page.locator(args.selector);
      const count = await loc.count();
      if (count === 0) return { ok: false, error: `selector "${args.selector}" 匹配 0 个元素` };
      buf = await loc.first().screenshot({
        type: args.format ?? 'png',
        quality: args.format === 'jpeg' ? args.quality : undefined,
        timeout: 5_000,
      });
    } else {
      buf = await page.screenshot({
        fullPage: args.fullPage ?? false,
        clip: args.clip,
        type: args.format ?? 'png',
        quality: args.format === 'jpeg' ? args.quality : undefined,
      });
    }

    const base64 = Buffer.from(buf).toString('base64');
    const vp = page.viewportSize();
    const result: BrowserScreenshotResult = {
      ok: true,
      base64,
      width: args.clip?.width ?? vp?.width,
      height: args.clip?.height ?? vp?.height,
    };

    /* 视觉回归 baseline 处理 */
    if (args.baseline && args.baselineMode) {
      const name = args.baseline.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 80);
      if (!name) return { ...result, ok: false, error: 'baseline name 需 a-zA-Z0-9_- 字符' };
      const { getArtifactPath, ensureDir, writeFile, readFile } = await loadArtifactHelpers();
      const baselineDir = await getArtifactPath(args.surfaceId, 'baseline');
      await ensureDir(baselineDir);
      const baselinePath = `${baselineDir}/${name}.png`;

      if (args.baselineMode === 'save') {
        await writeFile(baselinePath, buf);
        result.baselinePath = baselinePath;
      } else if (args.baselineMode === 'compare') {
        try {
          const oldBuf = await readFile(baselinePath);
          const diff = await compareScreenshots(oldBuf, buf, args.diffThreshold ?? 0.02);
          result.diff = diff;
        } catch (err: any) {
          result.diff = { ratio: 1, passed: false, diffPixels: -1, error: `baseline "${name}" 未找到 (先跑一次 baselineMode=save): ${err?.message}` };
        }
      }
    }
    return result;
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export interface BrowserGetStateArgs {
  surfaceId: string;
}
export interface BrowserGetStateResult {
  ok: boolean;
  url?: string;
  title?: string;
  error?: string;
}

export async function browserGetState(args: BrowserGetStateArgs): Promise<BrowserGetStateResult> {
  const host = getHostBrowserMethod('browserGetState');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    return {
      ok: true,
      url: page.url(),
      title: await page.title().catch(() => ''),
    };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/* ============================================================
 * 4.3 + 4.4: DOM 感知 + 交互 — 共享 Locator 解析逻辑
 * ============================================================ */

/** 统一定位器解析 — selector > role+name > text 三选一. 返一个 Locator (可能匹配 0/1/N). */
interface LocatorOpts {
  selector?: string;
  role?: string;
  name?: string | RegExp;
  text?: string;
  /** 页面快照给的编号 (见 NEOX_REF_ATTR)。模型看一眼就能直接引用, 不必自己拼选择器。 */
  ref?: number | string;
  /** 这个动作弹出原生对话框 (confirm/prompt) 时怎么答。不给: alert 接受, 其它取消, 但都会记在回执里。 */
  dialog?: DialogAnswer;
}

/** Attach ephemeral ref attributes to actionable elements so later actions can target the latest
 * snapshot directly. Refs live in the DOM only and become invalid when the page changes. */
export const NEOX_REF_ATTR = 'data-neox-ref';

function resolveLocator(page: Page, opts: LocatorOpts): Locator | null {
  /* ref 优先: 它是这一页刚刚看过的东西, 比模型凭印象拼的选择器可靠 */
  if (opts.ref !== undefined && String(opts.ref).trim() !== '') {
    return page.locator(`[${NEOX_REF_ATTR}="${String(opts.ref).replace(/"/g, '')}"]`);
  }
  if (opts.selector) return page.locator(opts.selector);
  if (opts.role) {
    /* Playwright getByRole 接受具体 role string union, 这里做类型放行让 TS 不抱怨 */
    return (page as any).getByRole(opts.role, opts.name !== undefined ? { name: opts.name } : undefined);
  }
  if (opts.text) return page.getByText(opts.text);
  return null;
}

/**
 * ref 还在吗 —— 用了 ref 就先花 30ms 确认一下。
 *
 * ─── 为什么必须有这一步 ────────────────────────────────────────────────────
 * ref 是打在 DOM 上的属性, 而**任何 SPA 重新渲染列表都会把它抹掉** (靶站的
 * `innerHTML = ...` 就是, 真站点更普遍)。失效之后 locator 匹配 0 个,
 * 于是走完整条重试 + expectChange 轮询, **等满 8 秒**才报一句"点了没反应" ——
 * 用户干等 8 秒, 模型还得再花一轮猜为什么。
 *
 * 提前认出来的好处是双份的: 快 (8s → 30ms), 而且**能说清楚下一步干什么** ——
 * "页面重绘过, 编号作废了, 用最新那份回执里的编号"。这比"点了没反应"有用得多。
 */
async function checkRefAlive(loc: Locator | null, opts: LocatorOpts): Promise<string | null> {
  if (opts.ref === undefined || !loc) return null;
  const n = await loc.count().catch(() => -1);
  if (n === 0) {
    return `ref ${opts.ref} 已经不在页面上了 —— 页面重新渲染过, 上一份回执里的编号就作废了 `
      + `(这在列表/表格类页面上很常见: 一次操作之后整块会重画)。`
      + ` 下一步: 用**最新一次**结果里 page.actionable 的编号; 如果手上没有最新的, `
      + `先跑一步只读的动作 (比如 {action:"get_text"}) 拿回一份新的。`
      + ` 也可以改用 selector —— 它不受重绘影响。`;
  }
  return null;
}

/** 工具回包公共字段 */
interface OkResult { ok: boolean; error?: string; }

/** 交互类动作的内联回执 — 省掉模型跟一发 browser_get_state 的整轮往返 (速度/连贯). */
interface ActionReceipt {
  url?: string;
  title?: string;
  navigated?: boolean;
  /** 这个动作弹出来的原生对话框 (见 browserCapture.DialogLog) —— 弹了就**必须**报出去 */
  dialog?: DialogLog;
}

/** 动作前的现场: 起点 url + 时刻, 顺手把这一步要给对话框的答案挂到 capture 上 */
interface ActionStart { url: string; ts: number; surfaceId: string; }
function beforeAction(page: Page, args: { surfaceId: string; dialog?: DialogAnswer }): ActionStart {
  const cap = getCapture(args.surfaceId);
  if (cap) cap.pendingDialogAnswer = args.dialog && typeof args.dialog.accept === 'boolean' ? args.dialog : null;
  return { url: page.url(), ts: Date.now(), surfaceId: args.surfaceId };
}

/**
 * 动作后回执 + 导航一拍确认.
 *
 * 连贯性的经典破绽: 点击触发了导航, 模型下一步立刻读 aria/截图, 拿到的是**旧页面**,
 * 于是多一轮"咦不对→等待→重读"。这里在动作后给 150ms 的导航探测窗:
 *   · 没导航 → 只付 150ms, 返回当前 url/title
 *   · 导航了 → 等 domcontentloaded (上限 3s) 再返回, 带 navigated:true
 * settle=false 的轻动作 (scroll/hover) 零等待, 只报 url/title.
 */
async function actionReceipt(page: Page, before: ActionStart, settle: boolean): Promise<ActionReceipt> {
  try {
    const beforeUrl = before.url;
    if (settle && page.url() === beforeUrl) {
      await page.waitForURL((u: URL) => u.toString() !== beforeUrl, { timeout: 150 }).catch(() => {});
    }
    const navigated = page.url() !== beforeUrl;
    if (navigated) {
      await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
    }
    /* 这个动作期间弹过的对话框。只报最后一个 (同一个动作连弹两个极少见); 没弹就没这个字段。
     * 用完把答案槽清掉 —— 答案只对"这一步"有效, 留着会答到下一个不相干的对话框上。 */
    const cap = getCapture(before.surfaceId);
    const dialogs = cap ? cap.dialogsSince(before.ts) : [];
    if (cap) cap.pendingDialogAnswer = null;
    const dialog = dialogs[dialogs.length - 1];
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      ...(navigated ? { navigated: true } : {}),
      ...(dialog ? { dialog } : {}),
    };
  } catch {
    return {};
  }
}

/* ── 4.3 DOM 感知 ─────────────────────────────────── */

export interface BrowserGetAriaTreeArgs {
  surfaceId: string;
  /** 最大深度, 超过的节点 children 截断成 `…N more`. 默认 12. */
  maxDepth?: number;
  /** 跳过 generic / unknown role 节点 (Playwright 标记的无 ARIA 语义节点). 默认 true. */
  pruneGeneric?: boolean;
}
export interface AriaNodeOut {
  role: string;
  name?: string;
  value?: string;
  level?: number;
  checked?: boolean | 'mixed';
  selected?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  /** 子节点; 超 maxDepth 时为 `[{ role: '…N more', ... }]` 截断标记 */
  children?: AriaNodeOut[];
}
export interface BrowserGetAriaTreeResult extends OkResult {
  tree?: AriaNodeOut;
}

export async function browserGetAriaTree(args: BrowserGetAriaTreeArgs): Promise<BrowserGetAriaTreeResult> {
  const host = getHostBrowserMethod('browserGetAriaTree');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    /* 直接走 CDP Accessibility.getFullAXTree — Playwright 1.50+ 移除了 page.accessibility,
     * 我们用 CDPSession 调命令. 数据同源 (Chrome DevTools Accessibility tab 也走这条). */
    const cdp = await page.context().newCDPSession(page);
    try {
      const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as { nodes: any[] };
      if (!nodes || nodes.length === 0) {
        return { ok: true, tree: { role: 'WebArea' } };
      }
      const nodesById = new Map<string, any>();
      for (const n of nodes) if (n.nodeId) nodesById.set(n.nodeId, n);
      /* 找根: 没有 parentId 的或第一个 RootWebArea/WebArea 类型 */
      const root = nodes.find((n: any) => !n.parentId)
        || nodes.find((n: any) => n.role?.value === 'RootWebArea' || n.role?.value === 'WebArea')
        || nodes[0];
      const simple = cdpAxNodeToSimple(root, nodesById);
      const tree = normalizeAriaNode(simple, 0, args.maxDepth ?? 12, args.pruneGeneric ?? true);
      return { ok: true, tree: tree ?? { role: 'WebArea' } };
    } finally {
      await cdp.detach().catch(() => { /* */ });
    }
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export interface BrowserQueryArgs {
  surfaceId: string;
  selector: string;
  /** 最多返回多少个匹配的 text. 默认 10. */
  limit?: number;
}
export interface BrowserQueryResult extends OkResult {
  count?: number;
  /** 每个匹配元素的 textContent 截断 */
  texts?: string[];
}

export async function browserQuery(args: BrowserQueryArgs): Promise<BrowserQueryResult> {
  const host = getHostBrowserMethod('browserQuery');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    const locator = page.locator(args.selector);
    const count = await locator.count();
    const limit = Math.min(args.limit ?? 10, count);
    const texts: string[] = [];
    for (let i = 0; i < limit; i++) {
      try {
        const t = await locator.nth(i).innerText({ timeout: 1000 });
        texts.push(t.length > 200 ? t.slice(0, 197) + '…' : t);
      } catch { texts.push(''); }
    }
    return { ok: true, count, texts };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export interface BrowserGetTextArgs {
  surfaceId: string;
  selector?: string;
  role?: string;
  name?: string;
  text?: string;
}
export interface BrowserGetTextResult extends OkResult {
  text?: string;
}

export async function browserGetText(args: BrowserGetTextArgs): Promise<BrowserGetTextResult> {
  const host = getHostBrowserMethod('browserGetText');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    const loc = resolveLocator(page, args);
    if (!loc) {
      /* 没传任何 locator 字段 → 返整页 body 的可见文本 */
      const txt = await page.locator('body').innerText({ timeout: 3000 });
      return { ok: true, text: txt };
    }
    const txt = await loc.first().innerText({ timeout: 3000 });
    return { ok: true, text: txt };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/* ── 4.4 交互 ─────────────────────────────────── */

export interface BrowserClickArgs extends LocatorOpts {
  surfaceId: string;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  modifiers?: ('Shift' | 'Control' | 'Meta' | 'Alt')[];
  timeout?: number;
}
export async function browserClick(args: BrowserClickArgs): Promise<OkResult & ActionReceipt> {
  const host = getHostBrowserMethod('browserClick');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    const loc = resolveLocator(page, args);
    if (!loc) return { ok: false, error: '必须提供 selector / role / text 之一' };
    const refGone = await checkRefAlive(loc, args);
    if (refGone) return { ok: false, error: refGone } as never;
    const before = beforeAction(page, args);

    /* Use a visible bounding-box mouse click first; fall back to Playwright when the element is
     * missing, zero-sized, or cannot be confirmed visible. */
    const box = await loc.first().boundingBox({ timeout: 1500 }).catch(() => null);
    if (box && box.width > 0 && box.height > 0) {
      await loc.first().scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
      /* Bound the post-scroll lookup so a remounted element cannot consume Playwright's long default. */
      const fresh = await loc.first().boundingBox({ timeout: 800 }).catch(() => null);
      /* Never reuse stale coordinates after scrolling; delegate to Playwright when the fresh box
       * is unavailable or outside the viewport. */
      const vp = page.viewportSize();
      const visible = !!fresh && fresh.width > 0 && fresh.height > 0
        && (!vp || (fresh.x >= 0 && fresh.y >= 0
          && fresh.x + fresh.width <= vp.width + 1 && fresh.y + fresh.height <= vp.height + 1));
      if (visible && fresh) {
        const x = Math.round(fresh.x + fresh.width / 2);
        const y = Math.round(fresh.y + fresh.height / 2);
        await moveAgentCursor(page, x, y, true);
        await page.mouse.click(x, y, {
          button: args.button ?? 'left',
          clickCount: args.clickCount ?? 1,
        });
        await moveAgentCursor(page, x, y);
        return { ok: true, ...(await actionReceipt(page, before, true)) };
      }
    }

    await loc.first().scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
    const cursorBox = await loc.first().boundingBox({ timeout: 800 }).catch(() => null);
    if (cursorBox) await moveAgentCursor(page, cursorBox.x + cursorBox.width / 2, cursorBox.y + cursorBox.height / 2, true);
    await loc.first().click({
      button: args.button ?? 'left',
      clickCount: args.clickCount ?? 1,
      modifiers: args.modifiers,
      /* 回落路径也不该磨很久 —— 5 秒够判断"这元素点不了"了 */
      timeout: args.timeout ?? 5000,
    });
    if (cursorBox) await moveAgentCursor(page, cursorBox.x + cursorBox.width / 2, cursorBox.y + cursorBox.height / 2);
    return { ok: true, ...(await actionReceipt(page, before, true)) };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export interface BrowserTypeArgs extends LocatorOpts {
  surfaceId: string;
  text: string;
  delay?: number;
  /** 输入前是否清空原内容. 默认 true. */
  clear?: boolean;
  /** 完后是否按 Enter (常用于搜索框 / form submit). 默认 false. */
  submit?: boolean;
  timeout?: number;
}
export async function browserType(args: BrowserTypeArgs): Promise<OkResult & ActionReceipt> {
  const host = getHostBrowserMethod('browserType');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    const loc = resolveLocator(page, args);
    if (!loc) return { ok: false, error: '必须提供 selector / role / text 之一' };
    const refGone = await checkRefAlive(loc, args);
    if (refGone) return { ok: false, error: refGone } as never;
    const target = loc.first();
    const before = beforeAction(page, args);
    await target.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
    const cursorBox = await target.boundingBox({ timeout: 800 }).catch(() => null);
    if (cursorBox) await moveAgentCursor(page, cursorBox.x + cursorBox.width / 2, cursorBox.y + cursorBox.height / 2);
    /* Playwright fill 会先 clear 再 type. type API 不 clear, 适合追加. */
    if (args.clear !== false) {
      await target.fill(args.text, { timeout: args.timeout ?? 5000 });
    } else {
      await target.type(args.text, { delay: args.delay, timeout: args.timeout ?? 5000 });
    }
    if (args.submit) await target.press('Enter', { timeout: args.timeout ?? 5000 });
    /* submit 大概率触发导航 → 探测窗; 纯输入零等待 */
    return { ok: true, ...(await actionReceipt(page, before, !!args.submit)) };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export interface BrowserPressKeyArgs {
  surfaceId: string;
  key: string;  /* e.g. 'Enter' / 'Escape' / 'ArrowDown' / 'Control+A' */
  /** 不传则 page.keyboard.press 全局; 传了在该元素上 press (会先 focus). */
  selector?: string;
  role?: string;
  name?: string;
  timeout?: number;
}
export async function browserPressKey(args: BrowserPressKeyArgs): Promise<OkResult & ActionReceipt> {
  const host = getHostBrowserMethod('browserPressKey');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    const loc = resolveLocator(page, args);
    const refGone = await checkRefAlive(loc, args);
    if (refGone) return { ok: false, error: refGone } as never;
    const before = beforeAction(page, args);
    if (loc) {
      await loc.first().press(args.key, { timeout: args.timeout ?? 5000 });
    } else {
      await page.keyboard.press(args.key);
    }
    /* Enter 常触发提交/导航 → 探测窗; 其它键零等待 */
    return { ok: true, ...(await actionReceipt(page, before, /enter/i.test(args.key))) };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export interface BrowserScrollArgs {
  surfaceId: string;
  /** 滚到该元素可见. 优先级最高. */
  selector?: string;
  role?: string;
  name?: string;
  /** 绝对坐标 — 跟 selector 二选一. */
  x?: number;
  y?: number;
  /** 方向 + amount — 都不传时默认 down 400px. */
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  timeout?: number;
}
export async function browserScroll(args: BrowserScrollArgs): Promise<OkResult> {
  const host = getHostBrowserMethod('browserScroll');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    const loc = resolveLocator(page, args);
    const refGone = await checkRefAlive(loc, args);
    if (refGone) return { ok: false, error: refGone } as never;
    if (loc) {
      await loc.first().scrollIntoViewIfNeeded({ timeout: args.timeout ?? 5000 });
      return { ok: true };
    }
    if (typeof args.x === 'number' && typeof args.y === 'number') {
      await page.evaluate(({ x, y }) => window.scrollTo(x, y), { x: args.x, y: args.y });
      return { ok: true };
    }
    /* 方向 + amount 模式 */
    const dir = args.direction ?? 'down';
    const amt = args.amount ?? 400;
    const [dx, dy] =
        dir === 'up'    ? [0, -amt]
      : dir === 'down'  ? [0, amt]
      : dir === 'left'  ? [-amt, 0]
      :                    [amt, 0];
    await page.evaluate(([dx, dy]) => window.scrollBy(dx, dy), [dx, dy]);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export interface BrowserHoverArgs extends LocatorOpts {
  surfaceId: string;
  timeout?: number;
}
export async function browserHover(args: BrowserHoverArgs): Promise<OkResult> {
  const host = getHostBrowserMethod('browserHover');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    const loc = resolveLocator(page, args);
    if (!loc) return { ok: false, error: '必须提供 selector / role / text 之一' };
    const refGone = await checkRefAlive(loc, args);
    if (refGone) return { ok: false, error: refGone } as never;
    await loc.first().hover({ timeout: args.timeout ?? 5000 });
    const cursorBox = await loc.first().boundingBox({ timeout: 800 }).catch(() => null);
    if (cursorBox) await moveAgentCursor(page, cursorBox.x + cursorBox.width / 2, cursorBox.y + cursorBox.height / 2);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export interface BrowserSelectOptionArgs {
  surfaceId: string;
  selector: string;
  value: string | string[];
  timeout?: number;
}
export async function browserSelectOption(args: BrowserSelectOptionArgs): Promise<OkResult & { selected?: string[] }> {
  const host = getHostBrowserMethod('browserSelectOption');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    /* Accept value for option identity and label/text/option as visible-label aliases. */
    const a = args as unknown as { value?: unknown; label?: unknown; text?: unknown; option?: unknown };
    const byLabel = [a.label, a.text, a.option].find((x) => typeof x === 'string' && x) as string | undefined;
    const choice = a.value !== undefined && a.value !== null
      ? (a.value as string | string[])
      : byLabel ? { label: byLabel }
      : undefined;
    if (choice === undefined) return { ok: false, error: 'select_option 需要 value (option 的 value) 或 label (显示文字)' };
    const selected = await page.locator(args.selector).first().selectOption(choice, { timeout: args.timeout ?? 5000 });
    return { ok: true, selected };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Accept array and selector-map forms; array entries may also use ref, name, or id to derive a
 * selector.
 */
export function normalizeFormFields(raw: unknown): Array<{ selector: string; value: string }> {
  const out: Array<{ selector: string; value: string }> = [];
  if (Array.isArray(raw)) {
    for (const f of raw as Array<Record<string, unknown>>) {
      if (!f || typeof f !== 'object') continue;
      const selector = typeof f.selector === 'string' ? f.selector
        : (typeof f.ref === 'number' || (typeof f.ref === 'string' && f.ref)) ? `[${NEOX_REF_ATTR}="${f.ref}"]`
        : typeof f.name === 'string' ? `[name=${JSON.stringify(f.name)}]`
        : typeof f.id === 'string' ? `#${f.id}` : '';
      if (selector && f.value !== undefined) out.push({ selector, value: String(f.value) });
    }
  } else if (raw && typeof raw === 'object') {
    for (const [selector, value] of Object.entries(raw as Record<string, unknown>)) {
      if (selector && value !== undefined && value !== null) out.push({ selector, value: String(value) });
    }
  }
  return out;
}

export interface BrowserFillFormArgs {
  surfaceId: string;
  fields: Array<{ selector: string; value: string }> | Record<string, string>;
  submit?: boolean;
  timeout?: number;
  dialog?: DialogAnswer;
}
export async function browserFillForm(args: BrowserFillFormArgs): Promise<OkResult & ActionReceipt & { filled?: number }> {
  const host = getHostBrowserMethod('browserFillForm');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    let filled = 0;
    const before = beforeAction(page, args);
    /* Also accept a single top-level selector/value pair for convenience. */
    const single = args as unknown as { selector?: unknown; value?: unknown };
    const fields = normalizeFormFields(
      args.fields ?? (typeof single.selector === 'string' && single.value !== undefined
        ? [{ selector: single.selector, value: String(single.value) }] : undefined));
    if (!fields.length) return { ok: false, error: 'fill_form 需要 fields: {"#user":"admin", …} 或 [{selector, value}, …]' };
    for (const f of fields) {
      await page.locator(f.selector).first().fill(f.value, { timeout: args.timeout ?? 5000 });
      filled++;
    }
    if (args.submit) {
      /* 找最后一个填的 field, 在那里按 Enter — 多数 form 这样能提交 */
      const last = fields[fields.length - 1];
      if (last) await page.locator(last.selector).first().press('Enter', { timeout: args.timeout ?? 5000 });
    }
    return { ok: true, filled, ...(await actionReceipt(page, before, !!args.submit)) };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/* ============================================================
 * 4.5 等待 — selector / url / network_idle / response / function / navigation
 * ============================================================ */

export interface BrowserWaitForArgs {
  surfaceId: string;
  /** 不给就从其它字段推 (见实现里的说明) —— 模型不该被要求猜我们的内部约定 */
  kind?: 'selector' | 'url' | 'network_idle' | 'response' | 'function';
  /** 等这段文字出现 —— 会被转成 selector: `text=…` */
  text?: string;
  /* selector mode */
  selector?: string;
  state?: 'attached' | 'detached' | 'visible' | 'hidden';
  /* url mode */
  urlPattern?: string;          /* glob, 同 Playwright waitForURL 接受的格式 */
  /* response mode */
  responseUrlPattern?: string;
  /* function mode */
  predicate?: string;           /* JS 字符串, 必须 evaluate true 才返 */
  /* 通用 */
  timeout?: number;             /* 默认 30s */
}
export interface BrowserWaitForResult extends OkResult {
  elapsed?: number;
  /** response mode 时返回命中 URL */
  responseUrl?: string;
  responseStatus?: number;
}

export async function browserWaitFor(args: BrowserWaitForArgs): Promise<BrowserWaitForResult> {
  const host = getHostBrowserMethod('browserWaitFor');
  if (host) return host(args);
  const mgr = getBrowserManager();
  const started = Date.now();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    const timeout = args.timeout ?? 30_000;

    /* kind 能从**给了什么**推出来就别要求它写 (基准)。
     *
     * 模型按常识写的是 {text:"工单"} / {selector:"text=7"} / {state:"hidden"},
     * 而这里原来硬要一个 kind 字段, 于是整段脚本挂掉 —— 跟 browser_eval 的参数名
     * 是同一类问题: 让模型猜中我们的内部约定, 猜不中就是一次往返。
     * 显式给了 kind 仍然优先, 这里只补缺省的那种情况。 */
    const a = args as unknown as Record<string, unknown>;
    let kind = args.kind;
    if (!kind) {
      if (typeof a.text === 'string' && a.text) {
        /* Playwright 的 text= 引擎: {text:"工单"} 就是"等到出现这段文字" */
        (args as { selector?: string }).selector = `text=${a.text}`;
        kind = 'selector';
      } else if (a.selector) kind = 'selector';
      else if (a.urlPattern || a.url) {
        (args as { urlPattern?: string }).urlPattern = String(a.urlPattern ?? a.url);
        kind = 'url';
      } else if (a.predicate || a.js || a.expression) {
        (args as { predicate?: string }).predicate = String(a.predicate ?? a.js ?? a.expression);
        kind = 'function';
      } else if (a.responseUrlPattern) kind = 'response';
      else kind = 'network_idle';   /* 什么都没给 = 等页面静下来, 这是最合理的默认 */
    }

    switch (kind) {
      case 'selector': {
        if (!args.selector) return { ok: false, error: 'selector required' };
        await page.waitForSelector(args.selector, {
          state: args.state ?? 'visible',
          timeout,
        });
        break;
      }
      case 'url': {
        if (!args.urlPattern) return { ok: false, error: 'urlPattern required' };
        await page.waitForURL(args.urlPattern, { timeout });
        break;
      }
      case 'network_idle': {
        await page.waitForLoadState('networkidle', { timeout });
        break;
      }
      case 'response': {
        if (!args.responseUrlPattern) return { ok: false, error: 'responseUrlPattern required' };
        const res = await page.waitForResponse(args.responseUrlPattern, { timeout });
        return { ok: true, elapsed: Date.now() - started, responseUrl: res.url(), responseStatus: res.status() };
      }
      case 'function': {
        if (!args.predicate) return { ok: false, error: 'predicate required' };
        /* 预防: predicate 是 JS 字符串, 不该有 fn 包装符 — Playwright waitForFunction 接受
         * '() => boolean' 字符串. 我们容忍裸表达式也接受 (用 new Function 自动包) */
        const pred = args.predicate.includes('=>') || args.predicate.startsWith('function')
          ? args.predicate
          : `() => Boolean(${args.predicate})`;
        await page.waitForFunction(pred, undefined, { timeout });
        break;
      }
      default:
        return { ok: false, error: `unknown kind: ${String(kind)} (可用: selector / url / network_idle / response / function; 也可以只给 selector / text / urlPattern / predicate, kind 会自动推断)` };
    }
    return { ok: true, elapsed: Date.now() - started };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err), elapsed: Date.now() - started };
  }
}

export interface BrowserWaitForNavigationArgs {
  surfaceId: string;
  timeout?: number;
  /** 只等到这个事件就返 (跟 navigate 的 waitUntil 同语义). 默认 'load'. */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
}
export async function browserWaitForNavigation(args: BrowserWaitForNavigationArgs): Promise<BrowserWaitForResult> {
  const host = getHostBrowserMethod('browserWaitForNavigation');
  if (host) return host(args);
  const mgr = getBrowserManager();
  const started = Date.now();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    /* Playwright 推荐用 waitForLoadState — waitForNavigation 已废弃但还能用.
     * 这里用 loadState: 等当前 page 进入指定 state. 跟"等下次导航"语义略有不同 (它等的是
     * 当前 page 的最终状态), 但对 agent 调用场景 (我点了链接, 等加载完) 行为一致. */
    await page.waitForLoadState(args.waitUntil ?? 'load', { timeout: args.timeout ?? 30_000 });
    return { ok: true, elapsed: Date.now() - started };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err), elapsed: Date.now() - started };
  }
}

/* ============================================================
 * 4.6 网络 / console — 从 ring buffer 读
 * ============================================================ */

export interface BrowserGetConsoleLogsArgs {
  surfaceId: string;
  level?: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace';
  since?: number;        /* ms timestamp; 只返 >= since 的 */
  limit?: number;        /* 默认 100 */
}
export interface BrowserGetConsoleLogsResult extends OkResult {
  logs?: ConsoleLog[];
  /** ring buffer 总条数 (没截断的). UI 据此显示 "100/200 条" */
  total?: number;
}

export async function browserGetConsoleLogs(args: BrowserGetConsoleLogsArgs): Promise<BrowserGetConsoleLogsResult> {
  const host = getHostBrowserMethod('browserGetConsoleLogs');
  if (host) return host(args);
  const mgr = getBrowserManager();
  /* 先 resolvePage 一次保证 capture 已挂载 (如果是 page 还没被 agent 操作过) */
  await mgr.resolvePage(args.surfaceId);
  const cap = getCapture(args.surfaceId);
  if (!cap) return { ok: true, logs: [], total: 0 };
  let arr = cap.console;
  if (args.level) arr = arr.filter(l => l.level === args.level);
  if (typeof args.since === 'number') arr = arr.filter(l => l.timestamp >= args.since!);
  const total = arr.length;
  const limit = args.limit ?? 100;
  /* 取最新 limit 条 (倒序 then 截断 then 复原顺序) */
  if (arr.length > limit) arr = arr.slice(-limit);
  return { ok: true, logs: arr, total };
}

export interface BrowserGetNetworkArgs {
  surfaceId: string;
  /** url 含子串过滤 */
  urlContains?: string;
  /** method 精确过滤 */
  method?: string;
  /** status 区间过滤 */
  statusGte?: number;
  statusLte?: number;
  /** resourceType 精确过滤 (document / xhr / fetch / ...) */
  resourceType?: string;
  /** 是否只看失败的 (failed 或 status >= 400) */
  failedOnly?: boolean;
  since?: number;
  limit?: number;
}
export interface BrowserGetNetworkResult extends OkResult {
  requests?: Omit<NetworkLog, '_response'>[];
  total?: number;
}

export async function browserGetNetwork(args: BrowserGetNetworkArgs): Promise<BrowserGetNetworkResult> {
  const host = getHostBrowserMethod('browserGetNetwork');
  if (host) return host(args);
  const mgr = getBrowserManager();
  await mgr.resolvePage(args.surfaceId);
  const cap = getCapture(args.surfaceId);
  if (!cap) return { ok: true, requests: [], total: 0 };
  let arr = cap.network;
  if (args.urlContains) arr = arr.filter(n => n.url.includes(args.urlContains!));
  if (args.method) arr = arr.filter(n => n.method.toUpperCase() === args.method!.toUpperCase());
  if (args.resourceType) arr = arr.filter(n => n.resourceType === args.resourceType);
  if (typeof args.statusGte === 'number') arr = arr.filter(n => typeof n.status === 'number' && n.status >= args.statusGte!);
  if (typeof args.statusLte === 'number') arr = arr.filter(n => typeof n.status === 'number' && n.status <= args.statusLte!);
  if (args.failedOnly) arr = arr.filter(n => n.failedReason || (typeof n.status === 'number' && n.status >= 400));
  if (typeof args.since === 'number') arr = arr.filter(n => n.timestamp >= args.since!);
  const total = arr.length;
  const limit = args.limit ?? 50;
  if (arr.length > limit) arr = arr.slice(-limit);
  /* 剔除 _response (Playwright Response 引用, 不 JSON-safe; agent 不需要) */
  const requests = arr.map(({ _response, ...rest }) => rest);
  return { ok: true, requests, total };
}

export interface BrowserGetResponseBodyArgs {
  surfaceId: string;
  requestId: string;
  /** 内容超 N 字节截断, 默认 64KB. */
  maxBytes?: number;
}
export interface BrowserGetResponseBodyResult extends OkResult {
  body?: string;         /* utf-8 解码后的 string; 二进制返 base64 + isBase64=true */
  isBase64?: boolean;
  mime?: string;
  truncated?: boolean;
  size?: number;
}

/* ============================================================
 * 4.1 补齐 — back / forward / reload
 *   (close / list_open 涉及 surface 生命周期, B 不做, C 阶段加).
 * ============================================================ */

export async function browserBack(args: { surfaceId: string; timeout?: number }): Promise<{ ok: boolean; url?: string; error?: string }> {
  const host = getHostBrowserMethod('browserBack');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    const res = await page.goBack({ timeout: args.timeout ?? 10_000 });
    return { ok: true, url: res ? res.url() : page.url() };
  } catch (err: any) { return { ok: false, error: err?.message || String(err) }; }
}

export async function browserForward(args: { surfaceId: string; timeout?: number }): Promise<{ ok: boolean; url?: string; error?: string }> {
  const host = getHostBrowserMethod('browserForward');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    const res = await page.goForward({ timeout: args.timeout ?? 10_000 });
    return { ok: true, url: res ? res.url() : page.url() };
  } catch (err: any) { return { ok: false, error: err?.message || String(err) }; }
}

export async function browserReload(args: { surfaceId: string; timeout?: number }): Promise<{ ok: boolean; url?: string; error?: string }> {
  const host = getHostBrowserMethod('browserReload');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    await page.reload({ timeout: args.timeout ?? 30_000 });
    return { ok: true, url: page.url() };
  } catch (err: any) { return { ok: false, error: err?.message || String(err) }; }
}

/* ============================================================
 * 4.7 断言 — visible / text / url / count / value
 *   不抛异常: ok=false 时给 actual + message 让 agent 自己决定怎么处理. 配合 timeout
 *   做 polling, "等到条件成立或超时" 语义.
 * ============================================================ */

export interface BrowserExpectArgs {
  surfaceId: string;
  kind: 'visible' | 'text' | 'url' | 'count' | 'value';
  /** visible / text / count / value 模式: 元素定位 */
  selector?: string;
  role?: string;
  name?: string;
  /** text 模式: 期望的 text (substring 匹配) 或 RegExp 源串 (以 / 开头 / 结尾算 regex) */
  text?: string;
  /** count 模式: 期望的元素数量 */
  count?: number;
  /** url 模式: URL pattern (glob, 同 waitForURL) */
  pattern?: string;
  /** value 模式: 期望的 input value (substring 匹配) */
  value?: string;
  timeout?: number;
}
export interface BrowserExpectResult {
  ok: boolean;
  /** 实际值 — visible=bool, text=string, url=string, count=number, value=string */
  actual?: any;
  message?: string;
  error?: string;
}

export async function browserExpect(args: BrowserExpectArgs): Promise<BrowserExpectResult> {
  const host = getHostBrowserMethod('browserExpect');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    /* Infer kind from the supplied assertion field when callers omit the explicit discriminator. */
    if (!args.kind) {
      const a = args as unknown as Record<string, unknown>;
      args.kind = typeof a.text === 'string' ? 'text'
        : typeof a.count === 'number' ? 'count'
        : typeof a.value === 'string' ? 'value'
        : typeof a.pattern === 'string' || typeof a.url === 'string' ? 'url'
        : 'visible';
      if (args.kind === 'url' && typeof a.url === 'string' && !args.pattern) args.pattern = a.url as string;
    }
    const timeout = args.timeout ?? 5000;
    const started = Date.now();
    const checkInterval = 200;

    /* 通用 polling 循环 — 每 200ms 求值一次, 命中或超时返. */
    while (true) {
      const elapsed = Date.now() - started;
      const isLast = elapsed >= timeout;
      const remaining = Math.max(0, timeout - elapsed);

      let actual: any;
      let matched = false;
      let errMsg: string | undefined;

      try {
        switch (args.kind) {
          case 'visible': {
            const loc = resolveLocator(page, args);
            if (!loc) { errMsg = 'expect visible 需要 selector / role / text 之一'; break; }
            actual = await loc.first().isVisible({ timeout: 100 }).catch(() => false);
            matched = actual === true;
            break;
          }
          case 'text': {
            const loc = resolveLocator(page, args);
            if (!loc) { errMsg = 'expect text 需要 selector / role 之一'; break; }
            if (typeof args.text !== 'string') { errMsg = 'expect text 需要 text 字段'; break; }
            actual = await loc.first().innerText({ timeout: 100 }).catch(() => '');
            /* /xxx/ 形式当 regex; 否则 substring */
            const exp = args.text;
            if (exp.length >= 2 && exp.startsWith('/') && exp.endsWith('/')) {
              const re = new RegExp(exp.slice(1, -1));
              matched = re.test(actual);
            } else {
              matched = String(actual).includes(exp);
            }
            break;
          }
          case 'url': {
            if (typeof args.pattern !== 'string') { errMsg = 'expect url 需要 pattern 字段'; break; }
            actual = page.url();
            /* glob 转 regex 简单版: * → .*, ? → . */
            const pat = args.pattern;
            const isRegex = pat.length >= 2 && pat.startsWith('/') && pat.endsWith('/');
            const re = isRegex
              ? new RegExp(pat.slice(1, -1))
              : new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
            matched = re.test(actual);
            break;
          }
          case 'count': {
            if (!args.selector) { errMsg = 'expect count 需要 selector 字段'; break; }
            if (typeof args.count !== 'number') { errMsg = 'expect count 需要 count 字段'; break; }
            actual = await page.locator(args.selector).count();
            matched = actual === args.count;
            break;
          }
          case 'value': {
            if (!args.selector) { errMsg = 'expect value 需要 selector 字段'; break; }
            if (typeof args.value !== 'string') { errMsg = 'expect value 需要 value 字段'; break; }
            actual = await page.locator(args.selector).first().inputValue({ timeout: 100 }).catch(() => '');
            matched = String(actual).includes(args.value);
            break;
          }
          default:
            return { ok: false, error: `unknown kind: ${(args as any).kind}` };
        }
      } catch (err: any) {
        errMsg = err?.message || String(err);
      }

      if (errMsg && !isLast) {
        await new Promise(r => setTimeout(r, Math.min(checkInterval, remaining)));
        continue;
      }
      if (matched) return { ok: true, actual };
      if (isLast || errMsg) {
        return {
          ok: false,
          actual,
          message: errMsg
            ? `expect 失败: ${errMsg}`
            : `expect 不满足: kind=${args.kind} 期望 vs 实际 actual=${JSON.stringify(actual)}`,
        };
      }
      await new Promise(r => setTimeout(r, Math.min(checkInterval, remaining)));
    }
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/* ============================================================
 * 4.8 eval — escape hatch, 任意 JS 在页面 context 跑
 *    安全: agent 用 eval 能跑任意页面脚本, 跟 fetch / cookies 接触.
 *   sandbox 跟普通 webContents 一样, 不能访问 Node. 后续 (C 阶段) 加用户授权.
 * ============================================================ */

export interface BrowserEvalArgs {
  surfaceId: string;
  js?: string;       /* JS 表达式 / 函数字面量 / 语句块 */
  /* 别名 —— 模型自然会写这几个名字, 只认 js 一个的代价见实现里的说明 (63% 失败率) */
  expression?: string;
  script?: string;
  code?: string;
  args?: any[];      /* 传给 function 的参数 (必须 JSON-safe). 表达式形式时忽略. */
  timeout?: number;
}
export interface BrowserEvalResult {
  ok: boolean;
  result?: any;
  error?: string;
  /** 结果为空时的解释 —— 空结果不解释, 模型只会再猜一轮 */
  note?: string;
}

/* ============================================================
 * 4.9 Cookies / Storage (C Day 1)
 *   Playwright BrowserContext.cookies() 拿 / 设 cookies. localStorage 走 page.evaluate.
 *   持久化跨重启靠 BrowserView 的 partition (C Day 1), 这里不管.
 * ============================================================ */

export interface BrowserGetCookiesArgs {
  surfaceId: string;
  /** 只返这些 URL 域名下的 cookie. 不传 = 所有. */
  urls?: string[];
}
export interface BrowserCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'None' | 'Strict';
}
export interface BrowserGetCookiesResult extends OkResult {
  cookies?: BrowserCookie[];
}

export async function browserGetCookies(args: BrowserGetCookiesArgs): Promise<BrowserGetCookiesResult> {
  const host = getHostBrowserMethod('browserGetCookies');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    const ctx = page.context();
    const cookies = await ctx.cookies(args.urls);
    return {
      ok: true,
      cookies: cookies.map(c => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path,
        expires: c.expires, httpOnly: c.httpOnly, secure: c.secure,
        sameSite: c.sameSite as any,
      })),
    };
  } catch (err: any) { return { ok: false, error: err?.message || String(err) }; }
}

export interface BrowserSetCookiesArgs {
  surfaceId: string;
  cookies: Array<BrowserCookie & { url?: string }>;  /* 至少一个有 url 或 domain */
}
export async function browserSetCookies(args: BrowserSetCookiesArgs): Promise<OkResult> {
  const host = getHostBrowserMethod('browserSetCookies');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    /* Playwright addCookies 要求每个 cookie 有 url 或 (domain + path). 这里宽松一点,
     * 如果都没 url 但有 domain 就用 domain, 否则报错让 caller 修. */
    const safe = args.cookies.map(c => ({ ...c })) as any[];
    for (const c of safe) {
      if (!c.url && !c.domain) {
        return { ok: false, error: `cookie "${c.name}" 缺 url 或 domain 字段` };
      }
    }
    await page.context().addCookies(safe);
    return { ok: true };
  } catch (err: any) { return { ok: false, error: err?.message || String(err) }; }
}

export interface BrowserClearCookiesArgs {
  surfaceId: string;
  /** 只清这些 URL 域下的 cookie; 不传 = 清全部 (相当于"退出登录所有站点") */
  urls?: string[];
}
export async function browserClearCookies(args: BrowserClearCookiesArgs): Promise<OkResult> {
  const host = getHostBrowserMethod('browserClearCookies');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    /* Playwright clearCookies 接 { name, domain, path } 过滤. 先列再删, 因为没有 url 过滤. */
    const ctx = page.context();
    if (!args.urls || args.urls.length === 0) {
      await ctx.clearCookies();
    } else {
      /* 拉指定 URL 域下的 cookie 列表 → 一个一个 clear (Playwright 1.40+ 支持 filter) */
      const filtered = await ctx.cookies(args.urls);
      for (const c of filtered) {
        await ctx.clearCookies({ name: c.name, domain: c.domain, path: c.path });
      }
    }
    return { ok: true };
  } catch (err: any) { return { ok: false, error: err?.message || String(err) }; }
}

export interface BrowserGetLocalStorageArgs {
  surfaceId: string;
  key?: string;       /* 不传 = 返全部 (origin 的所有 keys) */
}
export interface BrowserGetLocalStorageResult extends OkResult {
  value?: string | null;
  all?: Record<string, string>;
}
export async function browserGetLocalStorage(args: BrowserGetLocalStorageArgs): Promise<BrowserGetLocalStorageResult> {
  const host = getHostBrowserMethod('browserGetLocalStorage');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    if (args.key) {
      const value = await page.evaluate((k) => localStorage.getItem(k), args.key);
      return { ok: true, value };
    }
    const all = await page.evaluate(() => {
      const out: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) out[k] = localStorage.getItem(k) ?? '';
      }
      return out;
    });
    return { ok: true, all };
  } catch (err: any) { return { ok: false, error: err?.message || String(err) }; }
}

export interface BrowserSetLocalStorageArgs {
  surfaceId: string;
  key: string;
  /** null = 删除 */
  value: string | null;
}
/* ============================================================
 * C Day 2: 网络 mock — Playwright page.route() 截后端响应
 *   场景: agent 改完前端代码想验证错误兜底; 不必真起后端报 500.
 *    mock 是 per-page 状态, 切到不同 page (URL 同 surface 但页面跳转) 会保留 (Page 不变).
 *      Page close (e.g. surface 销毁) 时自动清空.
 * ============================================================ */

export interface BrowserMockResponseArgs {
  surfaceId: string;
  /** URL pattern — Playwright glob (* / ** / ?) 或 RegExp 序列化字符串. e.g. '**\/api/login' */
  urlPattern: string;
  status?: number;                              /* 默认 200 */
  body?: string;
  contentType?: string;                          /* 默认 application/json (if body parses JSON) 否则 text/plain */
  headers?: Record<string, string>;
  method?: string;                               /* 限定 method, 默认 '*' 匹配任意 */
}
export interface BrowserMockResponseResult extends OkResult {
  pattern?: string;
  method?: string;
}

export async function browserMockResponse(args: BrowserMockResponseArgs): Promise<BrowserMockResponseResult> {
  const host = getHostBrowserMethod('browserMockResponse');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    /* contentType 默认推断 — 用户传了 body 但没 contentType 时 */
    let contentType = args.contentType;
    if (!contentType && typeof args.body === 'string') {
      const trimmed = args.body.trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        contentType = 'application/json';
      } else {
        contentType = 'text/plain';
      }
    }
    const entry = await registerMock(args.surfaceId, page, {
      pattern: args.urlPattern,
      method: args.method,
      status: args.status,
      body: args.body,
      contentType,
      headers: args.headers,
    });
    return { ok: true, pattern: entry.pattern, method: entry.method };
  } catch (err: any) { return { ok: false, error: err?.message || String(err) }; }
}

export interface BrowserClearMocksArgs {
  surfaceId: string;
  /** 不传 = 清该 surface 全部 mock */
  urlPattern?: string;
  /** 指定 urlPattern 时可加 method 进一步缩小; 不传则同 pattern 所有 method 全清 */
  method?: string;
}
export interface BrowserClearMocksResult extends OkResult {
  cleared?: number;
}

export async function browserClearMocks(args: BrowserClearMocksArgs): Promise<BrowserClearMocksResult> {
  const host = getHostBrowserMethod('browserClearMocks');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    const cleared = await clearMocks(args.surfaceId, page, {
      pattern: args.urlPattern,
      method: args.method,
    });
    return { ok: true, cleared };
  } catch (err: any) { return { ok: false, error: err?.message || String(err) }; }
}

export interface BrowserListMocksArgs {
  surfaceId: string;
}
export interface BrowserListMocksResult extends OkResult {
  mocks?: Array<Omit<MockEntry, 'handler'>>;
}

export async function browserListMocks(args: BrowserListMocksArgs): Promise<BrowserListMocksResult> {
  const host = getHostBrowserMethod('browserListMocks');
  if (host) return host(args);
  try {
    /* 这里不强制 resolvePage — 列表只读, 没 page 也返空 */
    return { ok: true, mocks: listMocks(args.surfaceId) };
  } catch (err: any) { return { ok: false, error: err?.message || String(err) }; }
}

/* ============================================================
 * C Day 2: 文件上传 — Playwright locator.setInputFiles
 *   场景: agent 测试 form 含 <input type="file"> 的页面 (头像 / 附件 / 上传 PDF).
 *    paths 是 server 进程可见的本地路径; agent 该把要传的文件先写到 workspace 里再上传.
 * ============================================================ */

export interface BrowserSetInputFilesArgs {
  surfaceId: string;
  /** <input type="file"> 的 CSS selector */
  selector: string;
  /** 一个或多个本地绝对路径; multiple input 才允许多个 */
  paths: string[];
  timeout?: number;
}

export async function browserSetInputFiles(args: BrowserSetInputFilesArgs): Promise<OkResult & { uploaded?: number }> {
  const host = getHostBrowserMethod('browserSetInputFiles');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    if (!args.paths || args.paths.length === 0) {
      return { ok: false, error: 'paths 不能为空' };
    }
    await page.locator(args.selector).first().setInputFiles(args.paths, {
      timeout: args.timeout ?? 10_000,
    });
    return { ok: true, uploaded: args.paths.length };
  } catch (err: any) { return { ok: false, error: err?.message || String(err) }; }
}

export async function browserSetLocalStorage(args: BrowserSetLocalStorageArgs): Promise<OkResult> {
  const host = getHostBrowserMethod('browserSetLocalStorage');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    await page.evaluate(({ key, value }: { key: string; value: string | null }) => {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }, { key: args.key, value: args.value });
    return { ok: true };
  } catch (err: any) { return { ok: false, error: err?.message || String(err) }; }
}

export async function browserEval(args: BrowserEvalArgs): Promise<BrowserEvalResult> {
  const host = getHostBrowserMethod('browserEval');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    /* Accept common aliases for the page-evaluation source while preserving js as the canonical name. */
    const a = args as unknown as Record<string, unknown>;
    const source = [a.js, a.expression, a.script, a.code]
      .find((x): x is string => typeof x === 'string' && !!x.trim());
    if (!source) {
      return { ok: false, error: 'missing required arg "js" — 传一段 JS 表达式或函数字符串, 例如 js: "document.title" (也认 expression / script / code)' };
    }
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };

    /* Normalize expressions, function literals, IIFEs, and statement blocks into an IIFE string
     * evaluated by the page, never by the Node process. */
    const argLit = args.args && args.args.length > 0 ? JSON.stringify(args.args[0]) : '';
    /* Distinguish expressions and statements by compilation rather than text-pattern heuristics. */
    const { code, form } = wrapEvalSource(source, argLit);

    const result = await Promise.race([
      page.evaluate(code as never),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('browser_eval timeout')), args.timeout ?? 10_000),
      ),
    ]);
    /* undefined 在 JSON 里会整个字段消失, 模型看到 {"ok":true} 只会再猜一轮 —— 明说 */
    if (result === undefined) return { ok: true, result: null, note: explainEmptyResult(form) };
    return { ok: true, result };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export async function browserGetResponseBody(args: BrowserGetResponseBodyArgs): Promise<BrowserGetResponseBodyResult> {
  const host = getHostBrowserMethod('browserGetResponseBody');
  if (host) return host(args);
  const mgr = getBrowserManager();
  await mgr.resolvePage(args.surfaceId);
  const cap = getCapture(args.surfaceId);
  if (!cap) return { ok: false, error: 'no capture for this surface' };
  const entry = cap.findById(args.requestId);
  if (!entry) return { ok: false, error: `request id "${args.requestId}" 未在 ring buffer 中找到 (可能已被挤出)` };
  if (!entry._response) return { ok: false, error: 'request 未完成或失败, 无 response body' };
  try {
    const buf = await entry._response.body();
    const mime = entry._response.headers()['content-type'] || 'application/octet-stream';
    const maxBytes = args.maxBytes ?? 64 * 1024;
    const truncated = buf.length > maxBytes;
    const sliced = truncated ? buf.subarray(0, maxBytes) : buf;
    /* 文本 mime 直接 utf-8; 非文本走 base64 */
    const isText = /^(text\/|application\/(json|javascript|xml|.*\+xml|.*\+json|x-www-form-urlencoded))/.test(mime);
    return {
      ok: true,
      body: isText ? sliced.toString('utf-8') : sliced.toString('base64'),
      isBase64: !isText,
      mime,
      truncated,
      size: buf.length,
    };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/* ============================================================
 * 4.10 Computer-Use — 像素坐标级操作 (绕过 DOM)
 *   场景: canvas 应用, 复杂 SVG (Figma), 反爬保护强的页面, 截图后定位.
 *   agent 流程: screenshot 看图 → 推断坐标 (x,y) → 这里直接点 / 移动 / 打字.
 *    这些工具不走 selector, agent 必须看截图自己算坐标.
 *
 *   Humanlike 鼠标轨迹: 自研贝塞尔曲线 + 微抖 (humanlikeMoveTo). ghost-cursor 跟 Playwright
 *   API 不直接兼容 (针对 puppeteer 设计), 自研 30 行等效实现, 完全控制.
 * ============================================================ */

export interface BrowserClickAtArgs {
  surfaceId: string;
  x: number;
  y: number;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  /** 是否走 humanlike 贝塞尔轨迹 (ghost-cursor). 默认 true — 反爬场景务必开. */
  humanize?: boolean;
}

export async function browserClickAt(args: BrowserClickAtArgs): Promise<{ ok: boolean; error?: string }> {
  const host = getHostBrowserMethod('browserClickAt');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    if (args.humanize !== false) {
      /* Playwright Page 没暴露当前 cursor position, 从视口中心起步是合理的近似 (用户感知不到起点). */
      const vp = page.viewportSize();
      const startX = vp?.width ? vp.width / 2 : args.x;
      const startY = vp?.height ? vp.height / 2 : args.y;
      await humanlikeMoveTo(page, startX, startY, args.x, args.y);
    } else {
      await moveAgentCursor(page, args.x, args.y);
      await page.mouse.move(args.x, args.y);
    }
    await moveAgentCursor(page, args.x, args.y, true);
    await page.mouse.click(args.x, args.y, {
      button: args.button ?? 'left',
      clickCount: args.clickCount ?? 1,
    });
    await moveAgentCursor(page, args.x, args.y);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export interface BrowserMouseMoveArgs {
  surfaceId: string;
  x: number;
  y: number;
  /** 移动步数, 默认 8 (humanlike); 1 = 瞬移 (机器人感) */
  steps?: number;
}

export async function browserMouseMove(args: BrowserMouseMoveArgs): Promise<{ ok: boolean; error?: string }> {
  const host = getHostBrowserMethod('browserMouseMove');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    await moveAgentCursor(page, args.x, args.y);
    await page.mouse.move(args.x, args.y, { steps: args.steps ?? 8 });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export interface BrowserDragArgs {
  surfaceId: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** 拖拽过程总时长, 默认 500ms. */
  duration?: number;
}

export async function browserDrag(args: BrowserDragArgs): Promise<{ ok: boolean; error?: string }> {
  const host = getHostBrowserMethod('browserDrag');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    await moveAgentCursor(page, args.fromX, args.fromY);
    await page.mouse.move(args.fromX, args.fromY);
    await page.mouse.down();
    /* 拖拽过程多步移动, humanlike */
    const steps = Math.max(8, Math.round((args.duration ?? 500) / 50));
    try {
      for (let step = 1; step <= steps; step += 1) {
        const x = args.fromX + (args.toX - args.fromX) * step / steps;
        const y = args.fromY + (args.toY - args.fromY) * step / steps;
        await moveAgentCursor(page, x, y, true);
        await page.mouse.move(x, y);
      }
    } finally {
      await page.mouse.up();
    }
    await moveAgentCursor(page, args.toX, args.toY);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export interface BrowserKeyboardTypeArgs {
  surfaceId: string;
  text: string;
  /** 每个字符间延迟 (ms), 默认 50-120 区间随机. 0 = 瞬时. */
  delay?: number;
}

export async function browserKeyboardType(args: BrowserKeyboardTypeArgs): Promise<{ ok: boolean; error?: string }> {
  const host = getHostBrowserMethod('browserKeyboardType');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    /* 没传 delay → humanlike: 每个字符 50-120ms 随机 */
    if (args.delay === undefined) {
      for (const ch of args.text) {
        const d = 50 + Math.random() * 70;
        await page.keyboard.type(ch);
        await new Promise(r => setTimeout(r, d));
      }
    } else {
      await page.keyboard.type(args.text, { delay: args.delay });
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export interface BrowserKeyboardPressArgs {
  surfaceId: string;
  key: string;     /* 'Enter' / 'Escape' / 'Control+A' / 'ArrowDown' / ... */
}

export async function browserKeyboardPress(args: BrowserKeyboardPressArgs): Promise<{ ok: boolean; error?: string }> {
  const host = getHostBrowserMethod('browserKeyboardPress');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: noSurfaceMsg(args.surfaceId) };
    await page.keyboard.press(args.key);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/* 4.11 多 tab — 实现在 browserToolDefs.ts 里直接走 SURFACE_MARKER 协议 (跟 open_surface 同
 *   通道), 不在这里做 Playwright newPage. Playwright 直接 newPage 会创建独立 Chromium 窗口
 *   飘在 Neox 外面, 不是我们想要的内嵌效果. SURFACE_MARKER 让 renderer 通过 surfaceStore
 *   创建 web surface, WebSurfaceViewer 自动 mount BrowserView, 自然嵌入. */

/* ============================================================
 * 4.12 UI 测试强化 — P0/P1/P2 一体化补齐
 *   agent 需要真做 UI 测试时用这些工具. 大部分是 Playwright/CDP 现成能力薄封装.
 *   文件 artifacts 落 ~/.neox/browser-artifacts/<surfaceId>/<category>/<name>.<ext>
 * ============================================================ */

// ============================================================
// P0-2. browser_set_viewport — 响应式测试
// ============================================================

export interface BrowserSetViewportArgs {
  surfaceId: string;
  width: number;
  height: number;
  /** device pixel ratio, 默认 1. Retina 屏测试用 2. */
  deviceScaleFactor?: number;
  /** 移动端模拟. 传 true 页面收到 touch 事件而非 mouse. 默认 false. */
  isMobile?: boolean;
}

export async function browserSetViewport(args: BrowserSetViewportArgs): Promise<{ ok: boolean; width?: number; height?: number; error?: string }> {
  const host = getHostBrowserMethod('browserSetViewport');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: `surface "${args.surfaceId}" 未找到` };
    await page.setViewportSize({ width: args.width, height: args.height });
    /* dpr / isMobile 走 CDP Emulation.setDeviceMetricsOverride */
    if (args.deviceScaleFactor != null || args.isMobile != null) {
      const client = await page.context().newCDPSession(page);
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: args.width,
        height: args.height,
        deviceScaleFactor: args.deviceScaleFactor ?? 1,
        mobile: !!args.isMobile,
      });
      await client.detach().catch(() => {});
    }
    return { ok: true, width: args.width, height: args.height };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ============================================================
// P0-3. browser_wait_for_network_idle — 单独 tool (browser_wait_for kind 也支持, 但 dedicated 更清晰)
// ============================================================

export interface BrowserWaitForNetworkIdleArgs {
  surfaceId: string;
  /** 网络空闲判定: 500ms 内无 in-flight 请求. 可覆盖. 默认 500. */
  idleMs?: number;
  /** 总超时, 默认 30_000. */
  timeout?: number;
}

export async function browserWaitForNetworkIdle(args: BrowserWaitForNetworkIdleArgs): Promise<{ ok: boolean; error?: string }> {
  const host = getHostBrowserMethod('browserWaitForNetworkIdle');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: `surface "${args.surfaceId}" 未找到` };
    /* Playwright 内建 networkidle: 500ms 无请求算 idle. idleMs 参数目前无法覆盖 (Playwright 硬编码 500),
     *  自定义 idleMs 时走 poll network log 的方式兜底. */
    if (!args.idleMs || args.idleMs === 500) {
      await page.waitForLoadState('networkidle', { timeout: args.timeout ?? 30_000 });
      return { ok: true };
    }
    /* 自定义 idleMs: 走 capture 的 network log 数据, 轮询 in-flight 状态 */
    const cap = getCapture(args.surfaceId);
    if (!cap) return { ok: false, error: 'no network capture; 请等 default idleMs=500 走 Playwright networkidle' };
    const start = Date.now();
    const timeoutMs = args.timeout ?? 30_000;
    const idleMs = args.idleMs;
    while (Date.now() - start < timeoutMs) {
      const now = Date.now();
      const requests = cap.network.slice(-200);
      const active = requests.filter((r: any) => r._pending || (r.startedAt && now - r.startedAt < idleMs));
      if (active.length === 0) return { ok: true };
      await new Promise(r => setTimeout(r, 100));
    }
    return { ok: false, error: `network idle 超时 ${timeoutMs}ms` };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ============================================================
// P0-4. browser_highlight — 元素高亮预览 (agent 点前先给用户看点哪儿)
// ============================================================

export interface BrowserHighlightArgs {
  surfaceId: string;
  /** CSS selector, 或 role+name (跟其它交互工具同 locator 语义) */
  selector?: string;
  role?: string;
  name?: string;
  text?: string;
  /** 持续时长 ms, 默认 1500 */
  durationMs?: number;
  /** 高亮边框颜色, 默认红色 */
  color?: string;
}

export async function browserHighlight(args: BrowserHighlightArgs): Promise<{ ok: boolean; error?: string }> {
  const host = getHostBrowserMethod('browserHighlight');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: `surface "${args.surfaceId}" 未找到` };
    const loc = await resolveLocator(page, args);
    if (!loc) return { ok: false, error: 'locator 解析失败' };
    /* 用 JS 直接给目标元素叠一个 outline + 短暂 pulse 动画, 比 CDP Overlay.highlightNode 更简单
     *  且用户直接在页面上看得到 (Overlay 需要 DevTools window). */
    const dur = args.durationMs ?? 1500;
    const color = (args.color || '#ef4444').replace(/[^#a-zA-Z0-9]/g, '');
    await loc.first().evaluate((el: any, params: any) => {
      const orig = el.style.outline;
      const origShadow = el.style.boxShadow;
      const origZ = el.style.zIndex;
      el.style.outline = '3px solid ' + params.color;
      el.style.outlineOffset = '2px';
      el.style.boxShadow = '0 0 0 6px ' + params.color + '33, 0 0 24px ' + params.color + '99';
      el.style.zIndex = '2147483646';
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => {
        el.style.outline = orig;
        el.style.boxShadow = origShadow;
        el.style.zIndex = origZ;
      }, params.dur);
    }, { color, dur });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ============================================================
// P1-6. browser_a11y_scan — 注入 axe-core 做可访问性扫描
// ============================================================

export interface BrowserA11yScanArgs {
  surfaceId: string;
  /** 限定扫描范围 (CSS selector). 未传扫全页 */
  selector?: string;
  /** 违规严重度过滤, 默认全部 */
  minSeverity?: 'minor' | 'moderate' | 'serious' | 'critical';
}

export interface A11yViolation {
  id: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical';
  description: string;
  helpUrl: string;
  nodes: Array<{ target: string[]; html: string; failureSummary: string }>;
}

const AXE_CDN = 'https://cdn.jsdelivr.net/npm/axe-core@4.10.0/axe.min.js';

export async function browserA11yScan(args: BrowserA11yScanArgs): Promise<{ ok: boolean; violations?: A11yViolation[]; error?: string }> {
  const host = getHostBrowserMethod('browserA11yScan');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: `surface "${args.surfaceId}" 未找到` };
    /* 检查 window.axe 是否已注入, 未注入用 addScriptTag 从 CDN 拉. offline 场景失败 → 返 hint. */
    const hasAxe = await page.evaluate(() => typeof (window as any).axe !== 'undefined').catch(() => false);
    if (!hasAxe) {
      try {
        await page.addScriptTag({ url: AXE_CDN });
      } catch (err: any) {
        return { ok: false, error: `axe-core 注入失败 (可能离线): ${err?.message}. 提示: agent 可自己 eval axe 源码` };
      }
    }
    const result: any = await page.evaluate(async ({ selector }: any) => {
      const axe = (window as any).axe;
      const context = selector ? { include: [selector] } : undefined;
      return await axe.run(context || undefined);
    }, { selector: args.selector });
    let violations = (result?.violations || []) as A11yViolation[];
    if (args.minSeverity) {
      const rank = { minor: 1, moderate: 2, serious: 3, critical: 4 };
      const min = rank[args.minSeverity];
      violations = violations.filter(v => (rank[v.impact] ?? 0) >= min);
    }
    /* 精简 nodes 避免过大 tool_result */
    const compact = violations.map(v => ({
      ...v,
      nodes: v.nodes.slice(0, 3).map(n => ({
        target: n.target,
        html: (n.html || '').slice(0, 200),
        failureSummary: (n.failureSummary || '').slice(0, 400),
      })),
    }));
    return { ok: true, violations: compact };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ============================================================
// P1-7. browser_get_perf_metrics — 拿性能指标
// ============================================================

export interface BrowserPerfMetrics {
  /** Largest Contentful Paint, ms */
  lcp?: number;
  /** First Contentful Paint, ms */
  fcp?: number;
  /** Cumulative Layout Shift, unitless (低于 0.1 良好) */
  cls?: number;
  /** Time to First Byte, ms */
  ttfb?: number;
  /** DOM Content Loaded, ms */
  dcl?: number;
  /** load 事件, ms */
  load?: number;
  /** 主 frame js heap used bytes */
  jsHeapUsed?: number;
  /** 主 frame js heap total bytes */
  jsHeapTotal?: number;
}

export async function browserGetPerfMetrics(args: { surfaceId: string }): Promise<{ ok: boolean; metrics?: BrowserPerfMetrics; error?: string }> {
  const host = getHostBrowserMethod('browserGetPerfMetrics');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: `surface "${args.surfaceId}" 未找到` };
    const metrics: BrowserPerfMetrics = await page.evaluate(() => {
      const perf: any = performance;
      const nav = perf.getEntriesByType('navigation')[0];
      const paint = perf.getEntriesByType('paint');
      const fcp = paint.find((p: any) => p.name === 'first-contentful-paint');
      /* LCP: 拿到 PerformanceObserver 的最新 entry */
      const lcpEntries = perf.getEntriesByType('largest-contentful-paint') as any[];
      const lcp = lcpEntries.length ? lcpEntries[lcpEntries.length - 1].startTime : undefined;
      /* CLS: layout-shift entries 累加 */
      const clsEntries = perf.getEntriesByType('layout-shift') as any[];
      const cls = clsEntries.reduce((sum, e) => sum + (e.hadRecentInput ? 0 : (e.value || 0)), 0);
      const mem = (perf as any).memory;
      return {
        lcp: lcp !== undefined ? Math.round(lcp) : undefined,
        fcp: fcp ? Math.round(fcp.startTime) : undefined,
        cls: Math.round(cls * 10000) / 10000,
        ttfb: nav ? Math.round(nav.responseStart - nav.requestStart) : undefined,
        dcl: nav ? Math.round(nav.domContentLoadedEventEnd - nav.startTime) : undefined,
        load: nav ? Math.round(nav.loadEventEnd - nav.startTime) : undefined,
        jsHeapUsed: mem?.usedJSHeapSize,
        jsHeapTotal: mem?.totalJSHeapSize,
      };
    });
    return { ok: true, metrics };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ============================================================
// P1-8. browser_pdf — 页面 PDF 导出
// ============================================================

export interface BrowserPdfArgs {
  surfaceId: string;
  format?: 'A4' | 'A3' | 'Letter' | 'Legal' | 'Tabloid';
  landscape?: boolean;
  printBackground?: boolean;
  scale?: number;
  margin?: { top?: string; right?: string; bottom?: string; left?: string };
}

export async function browserPdf(args: BrowserPdfArgs): Promise<{ ok: boolean; base64?: string; path?: string; error?: string }> {
  const host = getHostBrowserMethod('browserPdf');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: `surface "${args.surfaceId}" 未找到` };
    /* Playwright pdf 只在 Chromium headless 支持. 我们外置 Chrome 是 headful, page.pdf 会抛
     *  "PDF generation is only supported in Chromium headless mode".
     *  兜底走 CDP Page.printToPDF 直接调, 不受 headless 限制. */
    const client = await page.context().newCDPSession(page);
    try {
      const result: any = await client.send('Page.printToPDF', {
        landscape: args.landscape ?? false,
        printBackground: args.printBackground ?? true,
        paperWidth: PAPER_SIZES[args.format ?? 'A4'].width,
        paperHeight: PAPER_SIZES[args.format ?? 'A4'].height,
        marginTop: parseInches(args.margin?.top) ?? 0.4,
        marginBottom: parseInches(args.margin?.bottom) ?? 0.4,
        marginLeft: parseInches(args.margin?.left) ?? 0.4,
        marginRight: parseInches(args.margin?.right) ?? 0.4,
        scale: args.scale ?? 1,
      });
      const buf = Buffer.from(result.data, 'base64');
      const { getArtifactPath, ensureDir, writeFile, pathJoin } = await loadArtifactHelpers();
      const dir = await getArtifactPath(args.surfaceId, 'pdf');
      await ensureDir(dir);
      const filename = `page-${Date.now()}.pdf`;
      const filepath = pathJoin(dir, filename);
      await writeFile(filepath, buf);
      return { ok: true, base64: result.data, path: filepath };
    } finally {
      await client.detach().catch(() => {});
    }
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ============================================================
// P1-9. browser_export_storage_state / import — 登录态复用
// ============================================================

export async function browserExportStorageState(args: { surfaceId: string; name?: string }): Promise<{ ok: boolean; path?: string; error?: string }> {
  const host = getHostBrowserMethod('browserExportStorageState');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: `surface "${args.surfaceId}" 未找到` };
    const state = await page.context().storageState();
    const { getArtifactPath, ensureDir, writeFile, pathJoin } = await loadArtifactHelpers();
    const dir = await getArtifactPath(args.surfaceId, 'storage-state');
    await ensureDir(dir);
    const name = (args.name || 'default').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 60) || 'default';
    const filepath = pathJoin(dir, `${name}.json`);
    await writeFile(filepath, JSON.stringify(state, null, 2));
    return { ok: true, path: filepath };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/** Copy daily Chrome login state only when explicitly enabled or forced by the caller.
 * The manager reserves a profile it can own exclusively, syncs into it, then restarts. */
export async function browserSyncDailyLogins(args: { force?: boolean }): Promise<{ ok: boolean; copied?: boolean; bytes?: number; source?: string; error?: string; note?: string }> {
  const { syncDailyLogins, readDailyLoginsConfig } = await import('./dailyLogins.js');
  const { findChromeExecutable, resolveAgentProfileDir, resolveProxyFromEnv, DEFAULT_CHROME_ARGS } = await import('./chromeLauncher.js');
  const cfg = readDailyLoginsConfig();
  if (!cfg.reuseDailyLogins && !args?.force) {
    return { ok: false, error: '没开: ~/.neox/config.json 的 browserUse.reuseDailyLogins 不是 true。这是用户的决定 —— 告诉用户打开它, 或者用户明确让你带时传 force:true。' };
  }
  const executable = findChromeExecutable();
  if (!executable) return { ok: false, error: '找不到 Chrome 可执行文件' };
  const mgr = getBrowserManager();
  const profileDir = mgr.getOwnedProfileDir() ?? mgr.getPreferredProfileDir(resolveAgentProfileDir());
  let result: import('./dailyLogins.js').SyncResult | undefined;
  try {
    await mgr.disconnect();
    await mgr.launchOwned({
      executablePath: executable,
      profileDir,
      args: DEFAULT_CHROME_ARGS,
      proxy: resolveProxyFromEnv() ?? undefined,
      realKeychain: true,
      prepareProfile: (reservedDir) => {
        result = syncDailyLogins({
          executablePath: executable,
          agentProfileDir: reservedDir,
          config: { ...cfg, reuseDailyLogins: true },
        });
      },
    });
    if (!result?.ok) return { ok: false, error: result?.reason ?? '登录态同步未执行', source: result?.source };
    return { ok: true, copied: result.copied, bytes: result.bytes, source: result.source,
      note: result.copied ? '已带上日常登录态并重启浏览器。' : '源没变, 沿用上次同步的登录态。' };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}

export async function browserImportStorageState(args: { surfaceId: string; name?: string }): Promise<{ ok: boolean; cookiesLoaded?: number; originsLoaded?: number; error?: string }> {
  const host = getHostBrowserMethod('browserImportStorageState');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: `surface "${args.surfaceId}" 未找到` };
    const { getArtifactPath, readFileText, pathJoin } = await loadArtifactHelpers();
    const dir = await getArtifactPath(args.surfaceId, 'storage-state');
    const name = (args.name || 'default').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 60) || 'default';
    const filepath = pathJoin(dir, `${name}.json`);
    const raw = await readFileText(filepath);
    const state = JSON.parse(raw);
    /* Playwright import storage state 只在 newContext 时生效. 已存在 context 只能手动 replay: */
    let cookiesLoaded = 0;
    let originsLoaded = 0;
    if (state.cookies?.length) {
      await page.context().addCookies(state.cookies);
      cookiesLoaded = state.cookies.length;
    }
    if (state.origins?.length) {
      for (const origin of state.origins) {
        try {
          await page.goto(origin.origin, { waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {});
          await page.evaluate((items: any) => {
            for (const item of items) {
              localStorage.setItem(item.name, item.value);
            }
          }, origin.localStorage || []);
          originsLoaded++;
        } catch { /* 跳过失败 origin */ }
      }
    }
    return { ok: true, cookiesLoaded, originsLoaded };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ============================================================
// P1-10. browser_wait_for_download — 等待下载事件
// ============================================================

export async function browserWaitForDownload(args: { surfaceId: string; timeout?: number }): Promise<{ ok: boolean; path?: string; suggestedFilename?: string; error?: string }> {
  const host = getHostBrowserMethod('browserWaitForDownload');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: `surface "${args.surfaceId}" 未找到` };
    const download = await page.waitForEvent('download', { timeout: args.timeout ?? 30_000 });
    const { getArtifactPath, ensureDir, pathJoin } = await loadArtifactHelpers();
    const dir = await getArtifactPath(args.surfaceId, 'downloads');
    await ensureDir(dir);
    const suggested = download.suggestedFilename() || `download-${Date.now()}`;
    const targetPath = pathJoin(dir, suggested);
    await download.saveAs(targetPath);
    return { ok: true, path: targetPath, suggestedFilename: suggested };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ============================================================
// P1-11. browser_throttle — 网络限速 / 离线模拟
// ============================================================

export interface BrowserThrottleArgs {
  surfaceId: string;
  /** 预设: 'offline' | 'slow-3g' | 'fast-3g' | '4g' | 'wifi' | 'no-throttle' */
  preset?: 'offline' | 'slow-3g' | 'fast-3g' | '4g' | 'wifi' | 'no-throttle';
  /** 自定义: 下载 kbps */
  downloadKbps?: number;
  /** 自定义: 上传 kbps */
  uploadKbps?: number;
  /** 自定义: 延迟 ms */
  latencyMs?: number;
  /** 自定义: 强制 offline */
  offline?: boolean;
}

const NETWORK_PRESETS: Record<string, { down: number; up: number; latency: number; offline: boolean }> = {
  offline: { down: 0, up: 0, latency: 0, offline: true },
  'slow-3g': { down: 500, up: 500, latency: 400, offline: false },
  'fast-3g': { down: 1500, up: 750, latency: 150, offline: false },
  '4g': { down: 12000, up: 3000, latency: 50, offline: false },
  wifi: { down: 30000, up: 15000, latency: 2, offline: false },
  'no-throttle': { down: 0, up: 0, latency: 0, offline: false }, /* 0 表示不限速 */
};

export async function browserThrottle(args: BrowserThrottleArgs): Promise<{ ok: boolean; applied?: any; error?: string }> {
  const host = getHostBrowserMethod('browserThrottle');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: `surface "${args.surfaceId}" 未找到` };
    let params: { down: number; up: number; latency: number; offline: boolean };
    if (args.preset) {
      const p = NETWORK_PRESETS[args.preset];
      if (!p) return { ok: false, error: `unknown preset "${args.preset}"` };
      params = { ...p };
    } else {
      params = {
        down: args.downloadKbps ?? 0,
        up: args.uploadKbps ?? 0,
        latency: args.latencyMs ?? 0,
        offline: !!args.offline,
      };
    }
    const client = await page.context().newCDPSession(page);
    try {
      await client.send('Network.enable');
      await client.send('Network.emulateNetworkConditions', {
        offline: params.offline,
        latency: params.latency,
        downloadThroughput: params.down > 0 ? (params.down * 1024) / 8 : -1,  /* kbps → bytes/s */
        uploadThroughput: params.up > 0 ? (params.up * 1024) / 8 : -1,
      });
    } finally {
      await client.detach().catch(() => {});
    }
    return { ok: true, applied: params };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ============================================================
// P2-12. 视频录制 — CDP Page.startScreencast → 存 webm/npy
//   实现简化: 按帧收集 base64, 用户可后续 ffmpeg 拼. 直接输出 mp4 需要 native encoder,
//   暂返 zip of frames 或按需扩展.
//   核心 API: browser_record_start / browser_record_stop
// ============================================================

interface RecordingSession {
  frames: Array<{ ts: number; data: string }>;
  client: import('playwright-core').CDPSession;
  startedAt: number;
  intervalHandle?: NodeJS.Timeout;
}

const recordingSessions = new Map<string, RecordingSession>();

export async function browserRecordStart(args: { surfaceId: string; quality?: number; maxFps?: number }): Promise<{ ok: boolean; error?: string }> {
  const host = getHostBrowserMethod('browserRecordStart');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    if (recordingSessions.has(args.surfaceId)) return { ok: false, error: '录制已开始; 先 browser_record_stop 再重开' };
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: `surface "${args.surfaceId}" 未找到` };
    const client = await page.context().newCDPSession(page);
    const session: RecordingSession = {
      frames: [],
      client,
      startedAt: Date.now(),
    };
    recordingSessions.set(args.surfaceId, session);
    client.on('Page.screencastFrame', async (params: any) => {
      session.frames.push({ ts: params.metadata?.timestamp ?? Date.now() / 1000, data: params.data });
      /* ack 让 Chrome 继续推下一帧 */
      try { await client.send('Page.screencastFrameAck', { sessionId: params.sessionId }); } catch { /* ignore */ }
    });
    await client.send('Page.startScreencast', {
      format: 'jpeg',
      quality: args.quality ?? 80,
      everyNthFrame: Math.max(1, Math.round(60 / (args.maxFps ?? 10))),
    });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export async function browserRecordStop(args: { surfaceId: string; filename?: string }): Promise<{ ok: boolean; frames?: number; durationMs?: number; framesDir?: string; error?: string }> {
  const host = getHostBrowserMethod('browserRecordStop');
  if (host) return host(args);
  try {
    const session = recordingSessions.get(args.surfaceId);
    if (!session) return { ok: false, error: '未在录制' };
    recordingSessions.delete(args.surfaceId);
    try { await session.client.send('Page.stopScreencast'); } catch { /* ignore */ }
    try { await session.client.detach(); } catch { /* ignore */ }

    const { getArtifactPath, ensureDir, writeFile, pathJoin } = await loadArtifactHelpers();
    const base = args.filename?.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 60) || `rec-${Date.now()}`;
    const framesDir = pathJoin(await getArtifactPath(args.surfaceId, 'recordings'), base);
    await ensureDir(framesDir);
    let i = 0;
    for (const f of session.frames) {
      await writeFile(pathJoin(framesDir, `frame-${String(i).padStart(6, '0')}.jpg`), Buffer.from(f.data, 'base64'));
      i++;
    }
    /* 写 metadata + ffmpeg 转换脚本, 用户/agent 需要 mp4 时手动跑
     *   ffmpeg -framerate 10 -i frame-%06d.jpg -c:v libx264 -pix_fmt yuv420p out.mp4 */
    const meta = {
      frames: session.frames.length,
      durationMs: Date.now() - session.startedAt,
      note: `拼 mp4: 在 ${framesDir} 里跑 ffmpeg -framerate 10 -i 'frame-%06d.jpg' -c:v libx264 -pix_fmt yuv420p out.mp4`,
    };
    await writeFile(pathJoin(framesDir, 'meta.json'), JSON.stringify(meta, null, 2));
    return { ok: true, frames: session.frames.length, durationMs: Date.now() - session.startedAt, framesDir };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ============================================================
// P2-DOM 深度解析
// ============================================================

export async function browserGetComputedStyle(args: { surfaceId: string; selector: string; properties?: string[] }): Promise<{ ok: boolean; style?: Record<string, string>; error?: string }> {
  const host = getHostBrowserMethod('browserGetComputedStyle');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: `surface "${args.surfaceId}" 未找到` };
    const style = await page.evaluate(({ selector, properties }: any) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const cs = getComputedStyle(el as any);
      const out: Record<string, string> = {};
      if (properties && Array.isArray(properties) && properties.length > 0) {
        for (const p of properties) out[p] = cs.getPropertyValue(p);
      } else {
        /* 全量太大, 挑常用的几十项 */
        for (const p of ['color', 'background-color', 'font-size', 'font-family', 'font-weight', 'line-height', 'text-align',
          'display', 'position', 'top', 'left', 'right', 'bottom', 'width', 'height', 'padding', 'margin',
          'border', 'border-radius', 'box-shadow', 'opacity', 'transform', 'z-index', 'overflow']) {
          out[p] = cs.getPropertyValue(p);
        }
      }
      return out;
    }, { selector: args.selector, properties: args.properties });
    if (!style) return { ok: false, error: `selector "${args.selector}" 匹配 0 个元素` };
    return { ok: true, style };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export async function browserGetBbox(args: { surfaceId: string; selector: string }): Promise<{ ok: boolean; bbox?: { x: number; y: number; width: number; height: number; inViewport: boolean; visible: boolean }; error?: string }> {
  const host = getHostBrowserMethod('browserGetBbox');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: `surface "${args.surfaceId}" 未找到` };
    const loc = page.locator(args.selector);
    if (await loc.count() === 0) return { ok: false, error: `selector "${args.selector}" 匹配 0 个元素` };
    /* timeout 显式给 —— Playwright 默认 30 秒, 一个"读 bbox"的工具不该有能力卡 30 秒
     * (同一类漏洞刚在 browserClick 的快路径里咬过一次)。 */
    const box = await loc.first().boundingBox({ timeout: 1500 }).catch(() => null);
    if (!box) return { ok: true, bbox: { x: 0, y: 0, width: 0, height: 0, inViewport: false, visible: false } };
    const vp = page.viewportSize() ?? { width: 0, height: 0 };
    const inViewport = box.x < vp.width && box.y < vp.height && box.x + box.width > 0 && box.y + box.height > 0;
    const visible = await loc.first().isVisible().catch(() => false);
    return { ok: true, bbox: { ...box, inViewport, visible } };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export async function browserGetFullDom(args: { surfaceId: string; selector?: string; maxBytes?: number }): Promise<{ ok: boolean; html?: string; truncated?: boolean; size?: number; error?: string }> {
  const host = getHostBrowserMethod('browserGetFullDom');
  if (host) return host(args);
  const mgr = getBrowserManager();
  try {
    const page = await mgr.resolvePage(args.surfaceId);
    if (!page) return { ok: false, error: `surface "${args.surfaceId}" 未找到` };
    const html: string = await page.evaluate((selector: any) => {
      if (selector) {
        const el = document.querySelector(selector);
        return el ? (el as any).outerHTML : '';
      }
      return document.documentElement.outerHTML;
    }, args.selector);
    const maxBytes = args.maxBytes ?? 256_000;
    if (html.length > maxBytes) {
      return { ok: true, html: html.slice(0, maxBytes), truncated: true, size: html.length };
    }
    return { ok: true, html, truncated: false, size: html.length };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}
