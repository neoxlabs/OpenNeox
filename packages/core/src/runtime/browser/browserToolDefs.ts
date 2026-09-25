/**
 * browserToolDefs — Browser Surface 工具的 `Tool` 规范 (给 LLM agent 用).
 *
 * 设计文档: 内部设计文档
 *
 * 架构:
 *   browserTools.ts (Playwright 包装 30 个函数)
 *     ↑ 直接同进程调用 (不走 HTTP / SDK)
 *   browserToolDefs.ts (本文件 — 32 个 Tool + 1 个 list_surfaces 入口)
 *     ↑ 注册
 *   runtimeTools.ts BASE_TOOLS (browser_list_surfaces 常驻)
 *   builtinPacks.ts browserPack (其余 32 个 tool_search 解锁)
 *
 * 关键约定:
 *   - 所有 surfaceId 都 *optional*. 缺省时 resolveSurfaceId 自动选唯一开着的;
 *     0 个 / N>1 个时抛 error message, agent 看 message 自己纠正.
 *   - 只读工具 isReadOnly=true, 其余 false (调度器据此决定并发).
 *   - parallelSafety 一律 'unsafe' — 同一个 page 上多操作不能并发.
 *     (后续优化: 不同 surface 之间并发可 safe, 用 isConcurrencySafe 按 surfaceId 区分.)
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { getBrowserManager } from './browserManager.js';
import { getBrowserHostController } from './browserHostController.js';
import { getBrowserSession } from './browserSession.js';
import { browserChoose } from './browserChoose.js';
import { buildImageToolResult, compressImageDataUrlIfNeeded } from '../../tools/image/imageProcessor.js';
import { SURFACE_MARKER, type SurfaceMarkerPayload, type Surface } from '../../tools/surface/surfaceTypes.js';
import {
  browserNavigate, browserBack, browserForward, browserReload,
  browserScreenshot, browserGetState,
  browserGetAriaTree, browserQuery, browserGetText,
  browserClick, browserType, browserPressKey, browserScroll, browserHover,
  browserSelectOption, browserFillForm,
  browserWaitFor, browserWaitForNavigation,
  browserGetConsoleLogs, browserGetNetwork, browserGetResponseBody,
  browserExpect, browserEval,
  browserGetCookies, browserSetCookies, browserClearCookies,
  browserGetLocalStorage, browserSetLocalStorage,
  browserMockResponse, browserClearMocks, browserListMocks,
  browserSetInputFiles,
  /* Computer-Use */
  browserClickAt, browserMouseMove, browserDrag,
  browserKeyboardType, browserKeyboardPress,
  browserSetViewport,
  browserWaitForNetworkIdle,
  browserHighlight,
  browserA11yScan,
  browserGetPerfMetrics,
  browserPdf,
  browserExportStorageState,
  browserImportStorageState,
  browserSyncDailyLogins,
  browserWaitForDownload,
  browserThrottle,
  browserRecordStart,
  browserRecordStop,
  browserGetComputedStyle,
  browserGetBbox,
  browserGetFullDom,
} from './browserTools.js';

// ============================================================================
// surfaceId 缺省解析 — 单 surface 场景下 agent 不用关心 id
// ============================================================================

const FIRST_SURFACE_ID = 'default';

async function resolveSurfaceId<T extends { surfaceId?: string }>(
  args: T,
  opts?: { createsSurface?: boolean },
): Promise<T & { surfaceId: string }> {
  if (args.surfaceId) return args as T & { surfaceId: string };
  const surfaces = await getBrowserManager().listSurfaces();
  if (surfaces.length === 0) {
    /* 建 surface 的那个工具自带钥匙, 别拿"还没有 surface"把它挡在门外 */
    if (opts?.createsSurface) {
      return { ...args, surfaceId: FIRST_SURFACE_ID };
    }
    throw new Error(
      'No browser surface is open. Call browser_navigate({url}) first — it opens one; ' +
      'browser_list_surfaces then shows it.',
    );
  }
  if (surfaces.length > 1) {
    const list = surfaces.map(s => `${s.surfaceId}(${s.title || s.url})`).join(', ');
    throw new Error(
      `${surfaces.length} browser surfaces are open. Specify surfaceId. Available: ${list}`,
    );
  }
  return { ...args, surfaceId: surfaces[0]!.surfaceId };
}

/** camelCase → snake_case, browserGetAriaTree → browser_get_aria_tree. */
function toolNameFromFn(fn: Function): string {
  const raw = fn.name || 'browser_unknown';
  return raw.replace(/[A-Z]/g, l => '_' + l.toLowerCase()).replace(/^_/, '');
}

interface WrapOpts<A> {
  /** 生成 banner 上显示的简短 detail — 如 "baidu.com" / "#submit" / "全页" */
  describe?: (args: A) => string;
  /** 这个工具自己会建 surface (browser_navigate) —— 一个都没有时不该被挡下, 见 FIRST_SURFACE_ID。 */
  createsSurface?: boolean;
}

/**
 * 包装 async 函数 → Tool.function. 自动做:
 *   1. surfaceId 解析 (agent 不用传 id)
 *   2. JSON.stringify 结果
 *   3. error → ok:false
 *   4. **BrowserSession.withActivity** — 一处装完所有 browser_* tool 的 refcount + 活动事件.
 *      Chrome 会因此按需起 / 关, banner 会显示当前工具名 + detail.
 */
function wrap<A extends { surfaceId?: string }, R>(
  fn: (args: A & { surfaceId: string }) => Promise<R>,
  opts?: WrapOpts<A & { surfaceId: string }>,
): (args: any, ctx?: { signal?: AbortSignal; sessionId?: string }) => Promise<string> {
  const toolName = toolNameFromFn(fn);
  return async (args: any, ctx?: { signal?: AbortSignal; sessionId?: string }) => {
    try {
      const resolved = await resolveSurfaceId(args || {}, { createsSurface: opts?.createsSurface });
      let detail: string | undefined;
      if (opts?.describe) {
        try { detail = opts.describe(resolved as any); } catch { /* 忽略 */ }
      }
      const result = await getBrowserSession().withActivity(
        toolName,
        detail,
        () => fn(resolved as any),
        ctx?.signal,
        ctx?.sessionId,
      );
      return JSON.stringify(result);
    } catch (err: any) {
      return JSON.stringify({ ok: false, error: err?.message || String(err) });
    }
  };
}

// ============================================================================
// 共用 schema 片段 — 复用减少冗余
// ============================================================================

const surfaceIdSchema = {
  type: 'string',
  description: 'Browser surface id (from browser_list_surfaces). Optional when only one browser is open.',
};
const locatorSchemaProps = {
  ref: {
    type: 'number',
    description: 'Number from the `page.actionable` list in the previous result — "3: button \"Submit\"" means ref: 3. '
      + 'PREFER THIS over guessing a selector: it points at the exact element you just saw. '
      + 'Refs are re-issued by every result, so always use the ones from the LATEST result; a stale ref fails loudly '
      + 'instead of clicking the wrong thing.',
  },
  selector: { type: 'string', description: 'CSS selector, when you already know it. e.g. "#submit", ".btn-primary".' },
  role: { type: 'string', description: 'ARIA role. Pair with `name` for role+name lookup.' },
  name: { type: 'string', description: 'Accessible name for role+name lookup.' },
  text: { type: 'string', description: 'Visible text substring match (loose, last resort).' },
  dialog: {
    type: 'object',
    description: 'How to answer a native alert/confirm/prompt this action opens: {accept: true|false, text?: "…"} '
      + '(text is the prompt answer). Without it, alert is accepted and confirm/prompt are CANCELLED; either way the '
      + 'result reports `dialog` with what popped up.',
    properties: {
      accept: { type: 'boolean' },
      text: { type: 'string' },
    },
  },
};
const timeoutSchema = { type: 'number', description: 'Timeout in ms.' };

// ============================================================================
// 0. Discovery — always-active, 常驻 BASE_TOOLS
// ============================================================================

export const browserListSurfacesTool: Tool = {
  name: 'browser_list_surfaces',
  description:
    'List currently open browser surfaces (Neox 内嵌浏览器 tabs) in the user\'s right panel. ' +
    'Returns `{ count, surfaces: [{surfaceId, url, title}], hint }`. ' +
    'RARELY NEEDED: only when the user refers to a page ALREADY open ("the browser", "this page") and you must ' +
    'find which tab. When you have a URL, skip this and go straight to browser_run with a navigate step — ' +
    'it opens the browser itself. ' +
    'To DO anything, use `browser_run` — it takes a whole sequence in one call and its result already ' +
    'carries the page state you need for the next batch. You do not need tool_search first.',
  group: 'execute',
  parallelSafety: 'safe',
  isReadOnly: true,
  resultType: 'contextual',
  parameters: { type: 'object', properties: {} },
  async function(): Promise<string> {
    try {
      const mgr = getBrowserManager();
      const surfaces = await mgr.listSurfaces();
      if (surfaces.length > 0) {
        return JSON.stringify({
          ok: true,
          count: surfaces.length,
          surfaces,
          hint: 'Use browser_run({steps:[...]}) to act on it — navigate/click/type/eval in one call; '
            + 'surfaceId can be omitted when only one is open. No tool_search needed.',
        });
      }
      /* 没匹配到 neox-sfc-* — 跑 diagnose 给 agent 看现场.
       * 三种情况:
       *   A. rawTargets 没 webview URL (只有主窗口/DevTools) → Electron 没暴露 webview 给 CDP, 需要主进程 attach
       *   B. rawTargets 有 webview 但 playwrightPages 没 → Playwright 过滤掉了 (可能 type 不是 page)
       *   C. playwrightPages 有但 windowName 不对 → 烙印未生效, 用户刷新页面 */
      const diag = await mgr.diagnose();
      const userPages = diag.playwrightPages.filter(d =>
        d.url !== 'about:blank' && !d.url.startsWith('devtools://') && !d.url.startsWith('chrome-extension://')
      );
      /* Chrome 的 Target.getTargets 会带上 iframe / worker / browser / service_worker,
       * Win 上尤其多。那些本来就不是 page, 拿来跟 Playwright pages 比会误报
       * "webview 没注册成 page" —— 能力报告就是这么把能用的浏览器判死的。 */
      const PAGE_TYPES = new Set(['page', 'webview', 'tab']);
      const userRawPages = diag.rawTargets.filter(t =>
        PAGE_TYPES.has(String(t.type || ''))
        && t.url && t.url !== 'about:blank'
        && !t.url.startsWith('devtools://') && !t.url.startsWith('chrome-extension://')
      );
      let hint: string;
      if (getBrowserHostController()) {
        hint = 'No browser surface open. Suggest user click "+ 打开 → 浏览器" in the right panel, or call open_surface({kind:"web", source:{type:"url", url:"..."}}).';
      } else if (diag.rawTargets.length === 0) {
        hint = '浏览器后端没起来 (Chrome 启动失败? 查 EXTERNAL_CHROME 日志). Restart Neox.';
      } else if (userPages.length > 0) {
        hint = `Playwright sees ${userPages.length} page(s) but none have window.name="neox-sfc-*". Call browser_navigate to brand the tab, or ask user to refresh.`;
      } else if (userRawPages.length > userPages.length) {
        hint = `CDP has ${userRawPages.length} page-like target(s) but Playwright only attached ${userPages.length}. Call browser_navigate({url}) to create a tab we own — do not treat this as a missing Electron webview.`;
      } else {
        hint = 'No browser surface open — that is normal at the start. Go straight to browser_run({steps:[{action:"navigate",args:{url}}, ...]}); it opens one. Do not call this tool again.';
      }
      return JSON.stringify({
        ok: true,
        count: 0,
        surfaces: [],
        hint,
        diagnostic: diag,
        lastConnectError: mgr.lastConnectError ?? undefined,
      });
    } catch (err: any) {
      return JSON.stringify({ ok: false, error: err?.message || String(err) });
    }
  },
};

export const browserDiagnoseTool: Tool = {
  name: 'browser_diagnose',
  description:
    'Dump raw CDP state — list all Pages across all BrowserContexts with their URL/title/window.name. ' +
    'Use when browser_list_surfaces returns count=0 but the user insists a browser is open — this tells ' +
    'you whether CDP sees the webview at all (multi-context bug) vs the window.name 烙印 failed.',
  group: 'execute',
  parallelSafety: 'safe',
  isReadOnly: true,
  resultType: 'contextual',
  parameters: { type: 'object', properties: {} },
  async function(): Promise<string> {
    try {
      const diag = await getBrowserManager().diagnose();
      return JSON.stringify({
        ok: true,
        rawTargetCount: diag.rawTargets.length,
        playwrightPageCount: diag.playwrightPages.length,
        ...diag,
      });
    } catch (err: any) {
      return JSON.stringify({ ok: false, error: err?.message || String(err) });
    }
  },
};

// ============================================================================
// 1. Navigation — 4 tools
// ============================================================================

export const browserNavigateTool: Tool = {
  name: 'browser_navigate',
  description:
    'Navigate the browser to a URL. URL missing protocol auto-prepends https://. ' +
    'Returns final `url` + `title` after load (default waits domcontentloaded). ' +
    'To EXTRACT DATA from the page afterwards: prefer captured API responses ' +
    '(browser_get_network + browser_get_response_body) or one-shot DOM reads (browser_eval) ' +
    '— never screenshots — and see use_skill("web-data-extraction") for bulk/multi-page data.',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema,
      url: { type: 'string', description: 'Destination URL. about:blank / http(s) / file: all accepted.' },
      waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'], description: 'Default "load".' },
      timeout: timeoutSchema,
    },
    required: ['url'],
  },
  function: wrap(browserNavigate, {
    describe: a => { try { return new URL(a.url).host || a.url; } catch { return a.url; } },
    /* 入口工具: 没有 surface 时它自己开一个 (createIfMissing), 不该被"还没有 surface"挡住 */
    createsSurface: true,
  }),
};

export const browserBackTool: Tool = {
  name: 'browser_back',
  description: 'Navigate browser history backwards. Returns the URL landed on (or current url if no history).',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: { surfaceId: surfaceIdSchema, timeout: timeoutSchema },
  },
  function: wrap(browserBack),
};

export const browserForwardTool: Tool = {
  name: 'browser_forward',
  description: 'Navigate browser history forwards.',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: { surfaceId: surfaceIdSchema, timeout: timeoutSchema },
  },
  function: wrap(browserForward),
};

export const browserReloadTool: Tool = {
  name: 'browser_reload',
  description: 'Reload the current page (equivalent to F5 / Cmd+R).',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: { surfaceId: surfaceIdSchema, timeout: timeoutSchema },
  },
  function: wrap(browserReload),
};

// ============================================================================
// 2. Visual perception — 2 tools
// ============================================================================

export const browserScreenshotTool: Tool = {
  name: 'browser_screenshot',
  description:
    'Capture PNG/JPEG of the page. Multimodal models see the image directly. ' +
    'For DOM inspection prefer browser_get_aria_tree (10x cheaper). ' +
    'ELEMENT SCREENSHOT: pass `selector` to capture only that element (agent no longer computes clip). ' +
    'VISUAL REGRESSION: pass `baseline: "<name>"` + `baselineMode: "save"` on first run to save baseline, ' +
    '`baselineMode: "compare"` on subsequent runs to compare + get diff ratio/png. Baselines land in ~/.neox/browser-artifacts/<surfaceId>/baseline/.',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: true,
  resultType: 'contextual',
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema,
      fullPage: { type: 'boolean', description: 'Capture full scroll-height. Default false (viewport only).' },
      clip: {
        type: 'object',
        description: 'Rectangle to clip: { x, y, width, height }.',
        properties: {
          x: { type: 'number' }, y: { type: 'number' },
          width: { type: 'number' }, height: { type: 'number' },
        },
      },
      format: { type: 'string', enum: ['png', 'jpeg'], description: 'Default png.' },
      quality: { type: 'number', description: 'JPEG quality 0-100. Ignored for png.' },
      selector: { type: 'string', description: 'CSS selector — screenshot only this element (no full-page, no clip math).' },
      baseline: { type: 'string', description: 'Visual regression baseline name (a-zA-Z0-9_-). Combine with baselineMode.' },
      baselineMode: { type: 'string', enum: ['save', 'compare'], description: '"save" to snapshot baseline; "compare" to diff current vs saved.' },
      diffThreshold: { type: 'number', description: 'Compare mode: pixel diff ratio tolerance (0-1). Default 0.02.' },
    },
  },
  async function(args: any, ctx?: { signal?: AbortSignal; sessionId?: string }): Promise<string> {
    try {
      const resolved = await resolveSurfaceId(args || {});
      const detail = resolved.selector
        ? `selector ${resolved.selector}`
        : resolved.fullPage ? '全页' : '视口';
      const result = await getBrowserSession().withActivity(
        'browser_screenshot',
        detail,
        () => browserScreenshot(resolved as any),
        ctx?.signal,
        ctx?.sessionId,
      );
      if (!result.ok || !result.base64) {
        return JSON.stringify({ ok: false, error: result.error || 'screenshot failed' });
      }
      /* IMAGE_RESULT_PREFIX 协议 — kernel imageToolResult 解析为 image_url content block,
       * 多模态模型直接看到像素, 而不是看一长串 base64 字符串. */
      /* 统一预算漏斗: BrowserView capturePage 是全分辨率 PNG (Retina 下动辄 2800×1800+),
       * 直传字节和 token 都爆表, 进会话前必须压 (长边 1568 / JPEG q72 / ~1.2MB). */
      let mediaType = args?.format === 'jpeg' ? 'image/jpeg' : 'image/png';
      let base64 = result.base64;
      let dims = `${result.width}×${result.height}`;
      const funneled = await compressImageDataUrlIfNeeded(`data:${mediaType};base64,${base64}`);
      if (funneled.compressed) {
        const fm = funneled.url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s);
        if (fm) {
          mediaType = fm[1];
          base64 = fm[2];
          if (funneled.width && funneled.height) dims = `${funneled.width}×${funneled.height}`;
        }
      }
      return buildImageToolResult([{
        base64,
        mediaType,
        label: `Browser screenshot (surface ${resolved.surfaceId}, ${dims})`,
      }]);
    } catch (err: any) {
      return JSON.stringify({ ok: false, error: err?.message || String(err) });
    }
  },
};

export const browserGetStateTool: Tool = {
  name: 'browser_get_state',
  description: 'Get the current URL + title. Fast / cheap; call before navigate to know where we are.',
  group: 'execute',
  parallelSafety: 'safe',
  isReadOnly: true,
  resultType: 'contextual',
  parameters: {
    type: 'object',
    properties: { surfaceId: surfaceIdSchema },
  },
  function: wrap(browserGetState),
};

// ============================================================================
// 3. DOM perception — 3 tools
// ============================================================================

export const browserGetAriaTreeTool: Tool = {
  name: 'browser_get_aria_tree',
  description:
    'Get the compact ARIA accessibility tree of the page. **Recommended over screenshot** for ' +
    'understanding page structure — gives roles, names, values for every meaningful element. ' +
    'Returns `{ tree: { role, name?, value?, children: [...] } }`. Generic containers auto-pruned.',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: true,
  resultType: 'contextual',
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema,
      maxDepth: { type: 'number', description: 'Max recursion depth. Default 12.' },
      pruneGeneric: { type: 'boolean', description: 'Drop role="generic" / "none" containers without name. Default true.' },
    },
  },
  function: wrap(browserGetAriaTree),
};

export const browserQueryTool: Tool = {
  name: 'browser_query',
  description: 'Count + sample inner text of elements matching a CSS selector. Cheap "does this exist?" check.',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: true,
  resultType: 'contextual',
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema,
      selector: { type: 'string', description: 'CSS selector.' },
      limit: { type: 'number', description: 'Max text samples returned. Default 10.' },
    },
    required: ['selector'],
  },
  function: wrap(browserQuery),
};

export const browserGetTextTool: Tool = {
  name: 'browser_get_text',
  description:
    'Get inner text of a specific element (locator) or entire page body when no locator given. ' +
    'Use this to read a heading / paragraph / error message etc.',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: true,
  resultType: 'contextual',
  parameters: {
    type: 'object',
    properties: { surfaceId: surfaceIdSchema, ...locatorSchemaProps },
  },
  function: wrap(browserGetText),
};

// ============================================================================
// 4. Interaction — 7 tools
// ============================================================================

export const browserClickTool: Tool = {
  name: 'browser_click',
  description:
    'Click an element. Element resolved by selector > role+name > text (one required). ' +
    'For double-click pass clickCount=2; for right-click pass button="right". ' +
    'Returns the resulting url/title inline (navigated=true if the click caused navigation, ' +
    'already settled to domcontentloaded) — no need to call browser_get_state afterwards.',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema, ...locatorSchemaProps,
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default left.' },
      clickCount: { type: 'number', description: '1 (default) or 2 for double-click.' },
      modifiers: {
        type: 'array',
        items: { type: 'string', enum: ['Shift', 'Control', 'Meta', 'Alt'] },
        description: 'Held modifier keys.',
      },
      timeout: timeoutSchema,
    },
  },
  function: wrap(browserClick, {
    describe: a => a.selector || a.role || a.text || '',
  }),
};

export const browserChooseTool: Tool = {
  name: 'browser_choose',
  description:
    'Answer on-page multiple-choice questions one by one like a person: scroll to each question, '
    + 'move the mouse to the chosen option and click it. Picks come from Jev (a fast choice model, '
    + '~0.5s each, all questions asked in parallel). Picks below minConfidence are NOT clicked and '
    + 'come back in `handBack` with their text: read those yourself and answer them with click. '
    + 'With no arguments it finds radio-button questions itself and skips answered ones; '
    + '`recheck: true` also re-judges the answered ones and lists where Jev disagrees (changes nothing). '
    + 'Use for quizzes/exams/surveys shown on the page; not for scraping. Needs Jev enabled.',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema,
      questions: { type: 'string', description: 'Omit (with options) to auto-detect radio-button questions. Else: selector matching every question container.' },
      options: { type: 'string', description: 'Omit to auto-detect. Else: selector, inside one question container, matching its options in order.' },
      minConfidence: { type: 'number', description: 'Only click picks at or above this (default 0.6).' },
      limit: { type: 'number', description: 'Answer at most this many, from the first question (default all).' },
      context: { type: 'string', description: 'Selector of shared material (e.g. a reading passage) given with every question.' },
      recheck: { type: 'boolean', description: 'Also re-judge questions already answered (e.g. a paper done before) and report disagreements. Does not change them.' },
    },
  },
  function: wrap(browserChoose, {
    describe: a => (a.recheck ? '逐题作答 · 核对已答' : a.limit ? `逐题作答 · ${a.limit} 题` : '逐题作答'),
  }),
};

export const browserTypeTool: Tool = {
  name: 'browser_type',
  description:
    'Type text into an input. By default clears existing value first (set clear=false to append). ' +
    'Pass submit=true to press Enter after typing (form submit / search) — the result then carries ' +
    'the post-submit url/title inline (navigated=true, settled), no browser_get_state needed.',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema, ...locatorSchemaProps,
      text: { type: 'string', description: 'Text to enter.' },
      delay: { type: 'number', description: 'ms between keypresses (humanize). Only when clear=false.' },
      clear: { type: 'boolean', description: 'Clear field first. Default true.' },
      submit: { type: 'boolean', description: 'Press Enter after typing. Default false.' },
      timeout: timeoutSchema,
    },
    required: ['text'],
  },
  function: wrap(browserType, {
    describe: a => `${a.selector || a.role || ''} · "${(a.text || '').slice(0, 30)}"`,
  }),
};

export const browserPressKeyTool: Tool = {
  name: 'browser_press_key',
  description:
    'Press a single key (or chord). Examples: "Enter", "Escape", "ArrowDown", "Control+A", "Meta+K". ' +
    'If a locator (selector/role) is provided, presses on that element after focus; otherwise global. ' +
    'Enter returns the resulting url/title inline (navigated=true if it submitted, settled).',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema,
      key: { type: 'string', description: 'Key name. Modifier chords use "+": "Control+A".' },
      selector: { type: 'string' }, role: { type: 'string' }, name: { type: 'string' },
      timeout: timeoutSchema,
    },
    required: ['key'],
  },
  function: wrap(browserPressKey),
};

export const browserScrollTool: Tool = {
  name: 'browser_scroll',
  description:
    'Scroll the page. Three modes: (1) selector → scroll element into view; (2) x+y → scroll to absolute ' +
    'coords; (3) direction+amount → scroll by delta (default down 400px).',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema,
      selector: { type: 'string' }, role: { type: 'string' }, name: { type: 'string' },
      x: { type: 'number', description: 'Absolute X coord (with y).' },
      y: { type: 'number', description: 'Absolute Y coord (with x).' },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Delta direction.' },
      amount: { type: 'number', description: 'Delta px. Default 400.' },
      timeout: timeoutSchema,
    },
  },
  function: wrap(browserScroll),
};

export const browserHoverTool: Tool = {
  name: 'browser_hover',
  description: 'Hover over an element (triggers :hover styles + tooltips). Locator required.',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: { surfaceId: surfaceIdSchema, ...locatorSchemaProps, timeout: timeoutSchema },
  },
  function: wrap(browserHover),
};

export const browserSelectOptionTool: Tool = {
  name: 'browser_select_option',
  description: 'Set a `<select>` element\'s value. Returns selected values for confirmation.',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema,
      selector: { type: 'string', description: 'CSS for the <select>.' },
      value: {
        type: ['string', 'array'],
        items: { type: 'string' },
        description: 'Value attribute(s) of the <option> to select. Array for multi-select.',
      },
      label: { type: 'string', description: 'Visible option text, when you know the label but not the value (e.g. "紧急").' },
      timeout: timeoutSchema,
    },
    required: ['selector'],
  },
  function: wrap(browserSelectOption),
};

export const browserFillFormTool: Tool = {
  name: 'browser_fill_form',
  description:
    'Fill a multi-field form in one call. Each field: { selector, value }. ' +
    'If submit=true, presses Enter on the last field — works for most forms.',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema,
      fields: {
        type: ['array', 'object'],
        description: 'Either an array of { selector, value } filled in order, or a plain map {"#user": "admin", "#pass": "…"}.',
        items: {
          type: 'object',
          properties: { selector: { type: 'string' }, value: { type: 'string' } },
          required: ['selector', 'value'],
        },
      },
      submit: { type: 'boolean', description: 'Press Enter on last field after fill. Default false.' },
      timeout: timeoutSchema,
    },
    required: ['fields'],
  },
  function: wrap(browserFillForm),
};

// ============================================================================
// 5. Waiting — 2 tools
// ============================================================================

export const browserWaitForTool: Tool = {
  name: 'browser_wait_for',
  description:
    'Wait for one of: a selector (visible/attached/hidden/detached) · a URL pattern · network idle · ' +
    'a specific response · a JS predicate returns truthy. Default timeout 30s. ' +
    'Use this between navigate and interactions to let the page settle.',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: true,
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema,
      kind: {
        type: 'string',
        enum: ['selector', 'url', 'network_idle', 'response', 'function'],
        description: 'Which kind of wait. Each kind reads its specific fields below.',
      },
      selector: { type: 'string' },
      state: { type: 'string', enum: ['attached', 'detached', 'visible', 'hidden'], description: 'For kind=selector. Default visible.' },
      urlPattern: { type: 'string', description: 'Glob for kind=url. e.g. "**/dashboard".' },
      responseUrlPattern: { type: 'string', description: 'Glob for kind=response.' },
      predicate: { type: 'string', description: 'JS for kind=function. Bare expression auto-wrapped: "document.readyState===\'complete\'".' },
      timeout: timeoutSchema,
    },
    required: ['kind'],
  },
  function: wrap(browserWaitFor),
};

export const browserWaitForNavigationTool: Tool = {
  name: 'browser_wait_for_navigation',
  description:
    'Wait until the page reaches the given load state. Use right after click on a link / form submit. ' +
    'Default waitUntil="load".',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: true,
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema,
      waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] },
      timeout: timeoutSchema,
    },
  },
  function: wrap(browserWaitForNavigation),
};

// ============================================================================
// 6. Network + console — 3 tools (all read-only)
// ============================================================================

export const browserGetConsoleLogsTool: Tool = {
  name: 'browser_get_console_logs',
  description:
    'Read page console (log/info/warn/error/debug/trace) from the ring buffer (last ~200 entries). ' +
    'Filter by level / since timestamp.',
  group: 'execute',
  parallelSafety: 'safe',
  isReadOnly: true,
  resultType: 'contextual',
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema,
      level: { type: 'string', enum: ['log', 'info', 'warn', 'error', 'debug', 'trace'] },
      since: { type: 'number', description: 'ms epoch; only entries >= since.' },
      limit: { type: 'number', description: 'Max entries returned. Default 100.' },
    },
  },
  function: wrap(browserGetConsoleLogs),
};

export const browserGetNetworkTool: Tool = {
  name: 'browser_get_network',
  description:
    'Read network requests from the ring buffer (last ~200). Supports filters: urlContains, method, ' +
    'status range, resourceType, failedOnly. Each entry has a `requestId` you pass to ' +
    'browser_get_response_body to fetch the body.',
  group: 'execute',
  parallelSafety: 'safe',
  isReadOnly: true,
  resultType: 'contextual',
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema,
      urlContains: { type: 'string', description: 'Substring of request URL.' },
      method: { type: 'string', description: 'GET / POST / ...' },
      statusGte: { type: 'number' }, statusLte: { type: 'number' },
      resourceType: { type: 'string', description: 'document / xhr / fetch / script / stylesheet / ...' },
      failedOnly: { type: 'boolean', description: 'Only failed or status >= 400.' },
      since: { type: 'number' }, limit: { type: 'number', description: 'Default 50.' },
    },
  },
  function: wrap(browserGetNetwork),
};

export const browserGetResponseBodyTool: Tool = {
  name: 'browser_get_response_body',
  description:
    'Fetch the response body for a request id from browser_get_network. Text mime → utf-8 string; ' +
    'binary → base64 with isBase64=true. Truncates at maxBytes (default 64KB).',
  group: 'execute',
  parallelSafety: 'safe',
  isReadOnly: true,
  resultType: 'contextual',
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema,
      requestId: { type: 'string', description: 'requestId field from browser_get_network result.' },
      maxBytes: { type: 'number', description: 'Truncate body at this size. Default 65536.' },
    },
    required: ['requestId'],
  },
  function: wrap(browserGetResponseBody),
};

// ============================================================================
// 7. Assertion + eval — 2 tools
// ============================================================================

export const browserExpectTool: Tool = {
  name: 'browser_expect',
  description:
    'Assert a UI condition with built-in polling (does NOT throw — returns {ok, actual, message}). ' +
    'Kinds: visible (locator) · text (locator+substring or /regex/) · url (glob/pattern or /regex/) · ' +
    'count (selector+count) · value (selector+input value substring). Default timeout 5s.',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: true,
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema,
      kind: { type: 'string', enum: ['visible', 'text', 'url', 'count', 'value'] },
      selector: { type: 'string' }, role: { type: 'string' }, name: { type: 'string' },
      text: { type: 'string', description: 'Substring; or "/regex/" for regex.' },
      pattern: { type: 'string', description: 'For kind=url. Glob ("**/dashboard") or "/regex/".' },
      count: { type: 'number', description: 'For kind=count.' },
      value: { type: 'string', description: 'For kind=value; input.value substring.' },
      timeout: timeoutSchema,
    },
    required: [],
  },
  function: wrap(browserExpect),
};

export const browserEvalTool: Tool = {
  name: 'browser_eval',
  description:
    'Run arbitrary JavaScript in the page context. Returns the value (must be JSON-safe). ' +
    'Use as an escape hatch when no specific tool fits. Default timeout 10s. ' +
    '⚠️ Can execute anything the page can — fetch, cookies, redirect. Use sparingly.',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema,
      js: {
        type: 'string',
        description: 'JS to run IN THE PAGE. Any of these forms work: an expression ("document.title"), '
          + 'an arrow/function literal ("() => document.title"), or statements ("const n = document.querySelectorAll(\'tr\').length; return n"). '
          + 'Aliases `expression` / `script` / `code` are accepted too.',
      },
      expression: { type: 'string', description: 'Alias of `js`.' },
      script: { type: 'string', description: 'Alias of `js`.' },
      code: { type: 'string', description: 'Alias of `js`.' },
      args: { type: 'array', description: 'Single-arg passed to the function (must be JSON-safe).' },
      timeout: timeoutSchema,
    },
    required: ['js'],
  },
  function: wrap(browserEval),
};

// ============================================================================
// 8. Cookies + storage — 5 tools
// ============================================================================

export const browserGetCookiesTool: Tool = {
  name: 'browser_get_cookies',
  description: 'Get cookies (optionally filtered by URL domains). Returns name/value/domain/path/expires/...',
  group: 'execute',
  parallelSafety: 'safe',
  isReadOnly: true,
  resultType: 'contextual',
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema,
      urls: { type: 'array', items: { type: 'string' }, description: 'Only cookies valid for these URLs.' },
    },
  },
  function: wrap(browserGetCookies),
};

export const browserSetCookiesTool: Tool = {
  name: 'browser_set_cookies',
  description: 'Set/replace cookies. Each cookie requires either `url` or `domain` (plus path).',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema,
      cookies: {
        type: 'array',
        description: 'Each: { name, value, url? | domain+path?, expires?, httpOnly?, secure?, sameSite? }.',
        items: { type: 'object' },
      },
    },
    required: ['cookies'],
  },
  function: wrap(browserSetCookies),
};

export const browserClearCookiesTool: Tool = {
  name: 'browser_clear_cookies',
  description: 'Clear cookies for given URLs (or all cookies when urls omitted — logs out everywhere).',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema,
      urls: { type: 'array', items: { type: 'string' } },
    },
  },
  function: wrap(browserClearCookies),
};

export const browserGetLocalStorageTool: Tool = {
  name: 'browser_get_local_storage',
  description: 'Read localStorage for the current page origin. Pass `key` for single; omit for full dump.',
  group: 'execute',
  parallelSafety: 'safe',
  isReadOnly: true,
  resultType: 'contextual',
  parameters: {
    type: 'object',
    properties: { surfaceId: surfaceIdSchema, key: { type: 'string' } },
  },
  function: wrap(browserGetLocalStorage),
};

export const browserSetLocalStorageTool: Tool = {
  name: 'browser_set_local_storage',
  description: 'Set / remove a localStorage key. Pass value=null to delete.',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema,
      key: { type: 'string' },
      value: { type: ['string', 'null'], description: 'null = remove.' },
    },
    required: ['key', 'value'],
  },
  function: wrap(browserSetLocalStorage),
};

// ============================================================================
// 9. Network mock — 3 tools
// ============================================================================

export const browserMockResponseTool: Tool = {
  name: 'browser_mock_response',
  description:
    'Intercept network requests matching urlPattern and return a canned response. Useful for testing ' +
    'frontend error states / loading states without touching the backend. Pattern is Playwright glob ' +
    '(e.g. "**/api/login") or RegExp source.',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema,
      urlPattern: { type: 'string' },
      status: { type: 'number', description: 'Default 200.' },
      body: { type: 'string', description: 'Response body string.' },
      contentType: { type: 'string', description: 'Auto-inferred from body if JSON-looking.' },
      headers: { type: 'object', description: 'Extra response headers.' },
      method: { type: 'string', description: 'Restrict to method (GET / POST / ...). Default any.' },
    },
    required: ['urlPattern'],
  },
  function: wrap(browserMockResponse),
};

export const browserClearMocksTool: Tool = {
  name: 'browser_clear_mocks',
  description: 'Remove mocks. Omit urlPattern to clear all on this surface; specify to scope.',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema,
      urlPattern: { type: 'string' },
      method: { type: 'string' },
    },
  },
  function: wrap(browserClearMocks),
};

export const browserListMocksTool: Tool = {
  name: 'browser_list_mocks',
  description: 'List active mocks on this surface (pattern, method, status, ...).',
  group: 'execute',
  parallelSafety: 'safe',
  isReadOnly: true,
  resultType: 'contextual',
  parameters: {
    type: 'object',
    properties: { surfaceId: surfaceIdSchema },
  },
  function: wrap(browserListMocks),
};

// ============================================================================
// 10. File upload — 1 tool
// ============================================================================

export const browserSetInputFilesTool: Tool = {
  name: 'browser_set_input_files',
  description:
    'Attach local files to a `<input type=file>` element. `paths` is an array of absolute filesystem ' +
    'paths visible to the agent process. Use to test upload forms (avatar / attachment / PDF).',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema,
      selector: { type: 'string', description: 'CSS for the <input type=file>.' },
      paths: { type: 'array', items: { type: 'string' }, description: 'Absolute local paths.' },
      timeout: timeoutSchema,
    },
    required: ['selector', 'paths'],
  },
  function: wrap(browserSetInputFiles),
};

// ============================================================================
// 11. Computer-Use — 像素坐标级 (canvas / 反爬场景, screenshot 后定位)
// ============================================================================

export const browserClickAtTool: Tool = {
  name: 'browser_click_at',
  description:
    'Click at exact pixel coordinates (绕过 DOM selector). Use when: page has canvas/SVG without ' +
    'queryable DOM (Figma / drawing app), strong anti-bot protection, or you just took a screenshot ' +
    'and know coordinates. Default humanize=true uses Bezier-curve mouse path + micro-jitter — ' +
    'reasonable for most anti-bot scenarios. Coordinates are CSS pixels relative to viewport top-left.',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema,
      x: { type: 'number', description: 'Viewport X, CSS px from left.' },
      y: { type: 'number', description: 'Viewport Y, CSS px from top.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'] },
      clickCount: { type: 'number', description: '1 default, 2 for double-click.' },
      humanize: { type: 'boolean', description: 'Bezier path + jitter. Default true.' },
    },
    required: ['x', 'y'],
  },
  function: wrap(browserClickAt),
};

export const browserMouseMoveTool: Tool = {
  name: 'browser_mouse_move',
  description:
    'Move cursor to (x, y) without clicking. Useful for hover-only animations / triggering tooltips ' +
    'on non-DOM elements. steps>1 makes it gradual.',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema,
      x: { type: 'number' },
      y: { type: 'number' },
      steps: { type: 'number', description: 'Move steps. Default 8 (humanlike).' },
    },
    required: ['x', 'y'],
  },
  function: wrap(browserMouseMove),
};

export const browserDragTool: Tool = {
  name: 'browser_drag',
  description:
    'Drag from (fromX, fromY) to (toX, toY). Use for canvas drawing, slider knobs, drag-and-drop ' +
    'reordering in non-selector-friendly UIs. duration controls smoothness.',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema,
      fromX: { type: 'number' }, fromY: { type: 'number' },
      toX: { type: 'number' }, toY: { type: 'number' },
      duration: { type: 'number', description: 'Total ms. Default 500.' },
    },
    required: ['fromX', 'fromY', 'toX', 'toY'],
  },
  function: wrap(browserDrag),
};

export const browserKeyboardTypeTool: Tool = {
  name: 'browser_keyboard_type',
  description:
    'Type text into the currently focused element (use after clicking an input). Default delay = ' +
    'humanlike 50-120ms random per char — anti-bot friendly. Pass delay:0 for instant typing.',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema,
      text: { type: 'string' },
      delay: { type: 'number', description: 'ms per char. Omit for humanlike random.' },
    },
    required: ['text'],
  },
  function: wrap(browserKeyboardType),
};

export const browserKeyboardPressTool: Tool = {
  name: 'browser_keyboard_press',
  description:
    'Press a single key (or chord) globally — no element required. Examples: "Enter", "Escape", ' +
    '"ArrowDown", "Control+A", "Meta+K", "Tab". Use after focus or for global hotkeys.',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: {
      surfaceId: surfaceIdSchema,
      key: { type: 'string' },
    },
    required: ['key'],
  },
  function: wrap(browserKeyboardPress),
};

// ============================================================================
// 12. Multi-Tab — 并行查 / 对比 / 测试用例多 step
// ============================================================================

/** 生成新 surfaceId, 跟 openSurfaceTool 的 genId 同款. */
function genSurfaceId(): string {
  return `sfc-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export const browserNewTabTool: Tool = {
  name: 'browser_new_tab',
  description:
    'Open a new browser tab in the user\'s right panel — creates a real Neox web surface (tab in UI) ' +
    'AND mounts a BrowserView showing the URL. Returns surfaceId you can pass to other browser_* tools. ' +
    'Cookies/localStorage shared with sibling tabs (workspace partition). Use to compare pages / ' +
    'have multiple targets / 等多步登录.',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Initial URL. Defaults to about:blank.' },
      surfaceId: { type: 'string', description: 'Optional custom id. Omit for auto-generated.' },
      title: { type: 'string', description: 'Optional tab title. Auto-inferred from URL host if omitted.' },
      pinned: { type: 'boolean', description: 'Pin tab so new surfaces don\'t replace it. Default false.' },
    },
  },
  /* 这个工具不调 Playwright newPage. 跟 open_surface 同款返 SURFACE_MARKER JSON,
   * renderer 收到 → surfaceStore 加 surface → WebSurfaceViewer 自动 mount BrowserView →
   * BrowserView 的 webContents 烙 window.name=neox-sfc-<id> → 后续 browser_list_surfaces /
   * resolvePage 都找得到. 一条链路, 不再 newPage 飘窗口外. */
  function: async (args: any): Promise<string> => {
    const surfaceId = args?.surfaceId || genSurfaceId();
    const rawUrl = (args?.url || 'about:blank').trim();
    const url = /^[a-z][a-z0-9+.-]*:/i.test(rawUrl) || rawUrl.startsWith('about:') ? rawUrl : ('https://' + rawUrl);
    const inferredTitle = (() => {
      if (args?.title) return args.title;
      try { return new URL(url).host || url; } catch { return url; }
    })();
    const now = Date.now();
    const surface: Surface = {
      id: surfaceId,
      kind: 'web',
      source: { type: 'url', url },
      title: inferredTitle,
      pinned: args?.pinned === true,
      createdAt: now,
      updatedAt: now,
    };
    const payload: SurfaceMarkerPayload = {
      [SURFACE_MARKER]: true,
      action: 'open',
      surface,
    };
    return JSON.stringify(payload);
  },
};

export const browserCloseTabTool: Tool = {
  name: 'browser_close_tab',
  description:
    'Close a browser tab (Neox web surface) by surfaceId. Sends a surface close event — renderer ' +
    'removes the tab from UI and the BrowserView is destroyed. Use after finishing with a tab created ' +
    'by browser_new_tab.',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: { surfaceId: surfaceIdSchema },
    required: ['surfaceId'],
  },
  function: async (args: any): Promise<string> => {
    if (!args?.surfaceId) return JSON.stringify({ ok: false, error: 'surfaceId is required' });
    const payload: SurfaceMarkerPayload = {
      [SURFACE_MARKER]: true,
      action: 'close',
      surfaceId: args.surfaceId,
    };
    return JSON.stringify(payload);
  },
};

// ============================================================================
// ============================================================================

/* 简单直通函数 — 大多数新 tool 的 function body 都是 "resolve surface → 调 impl → 返 JSON",
 *  用一个 helper 消除样板. 只有 screenshot / list_mocks 等有特殊 result 处理的还保留自定义 body. */
function makeSimpleBrowserTool<A extends { surfaceId?: string }>(
  name: string,
  description: string,
  properties: Record<string, any>,
  impl: (args: A & { surfaceId: string }) => Promise<any>,
  opts: { isReadOnly?: boolean; required?: string[] } = {},
): Tool {
  return {
    name,
    description,
    group: 'execute',
    parallelSafety: 'unsafe',
    isReadOnly: opts.isReadOnly ?? false,
    resultType: 'contextual',
    parameters: {
      type: 'object',
      properties: { surfaceId: surfaceIdSchema, ...properties },
      required: opts.required,
    },
    async function(args: any): Promise<string> {
      try {
        const resolved = await resolveSurfaceId(args || {});
        const result = await impl(resolved as any);
        return JSON.stringify(result);
      } catch (err: any) {
        return JSON.stringify({ ok: false, error: err?.message || String(err) });
      }
    },
  };
}

export const browserSetViewportTool = makeSimpleBrowserTool(
  'browser_set_viewport',
  'Resize browser viewport (responsive/mobile testing). Common: 1440×900 (desktop), 1024×768 (tablet), 375×667 (iPhone SE), 390×844 (iPhone 14). deviceScaleFactor=2 emulates Retina; isMobile=true sends touch events.',
  {
    width: { type: 'number', description: 'Viewport width in px.' },
    height: { type: 'number', description: 'Viewport height in px.' },
    deviceScaleFactor: { type: 'number', description: 'DPR. Default 1. Use 2 for Retina.' },
    isMobile: { type: 'boolean', description: 'Emulate mobile (touch events). Default false.' },
  },
  browserSetViewport,
  { required: ['width', 'height'] },
);

export const browserWaitForNetworkIdleTool = makeSimpleBrowserTool(
  'browser_wait_for_network_idle',
  'Wait until network is idle (no in-flight requests for `idleMs`). Default idleMs=500 uses Playwright networkidle load state. Useful after navigate / SPA route change to ensure lazy-loaded content settled before screenshot/assert.',
  {
    idleMs: { type: 'number', description: 'Idle window ms. Default 500. Non-default uses polling fallback.' },
    timeout: { type: 'number', description: 'Total timeout ms. Default 30000.' },
  },
  browserWaitForNetworkIdle,
  { isReadOnly: true },
);

export const browserHighlightTool = makeSimpleBrowserTool(
  'browser_highlight',
  'Draw a colored outline + glow around an element for a moment (default 1500ms). Use BEFORE click/type on important interactions — user + agent both see visually where the action lands. Scrolls the element into view. Non-blocking (returns immediately).',
  {
    selector: { type: 'string', description: 'CSS selector.' },
    role: { type: 'string', description: 'ARIA role (with name).' },
    name: { type: 'string', description: 'Accessible name (with role).' },
    text: { type: 'string', description: 'Visible text (loose match, last resort).' },
    durationMs: { type: 'number', description: 'Highlight duration. Default 1500.' },
    color: { type: 'string', description: 'CSS color, default #ef4444 (red).' },
  },
  browserHighlight,
  { isReadOnly: true },
);

export const browserA11yScanTool = makeSimpleBrowserTool(
  'browser_a11y_scan',
  'Run axe-core accessibility scan. Auto-injects axe from CDN if not present. Returns WCAG 2.1 violations with impact level + failure summary + up to 3 offending nodes each. Use for a11y audit before shipping UI.',
  {
    selector: { type: 'string', description: 'Limit scan to a subtree. Omit to scan full page.' },
    minSeverity: { type: 'string', enum: ['minor', 'moderate', 'serious', 'critical'], description: 'Filter out below this. Default no filter.' },
  },
  browserA11yScan,
  { isReadOnly: true },
);

export const browserGetPerfMetricsTool = makeSimpleBrowserTool(
  'browser_get_perf_metrics',
  'Get Core Web Vitals + timing: LCP (Largest Contentful Paint ms), FCP, CLS (Cumulative Layout Shift), TTFB, DOMContentLoaded, load event, JS heap used/total bytes. Call AFTER page has settled (browser_wait_for_network_idle first).',
  {},
  browserGetPerfMetrics,
  { isReadOnly: true },
);

export const browserPdfTool = makeSimpleBrowserTool(
  'browser_pdf',
  'Export current page as PDF (Chromium Page.printToPDF). Result: file path in ~/.neox/browser-artifacts/<surfaceId>/pdf/ + base64 for immediate use. Supports A4/A3/Letter/Legal/Tabloid, landscape, margins.',
  {
    format: { type: 'string', enum: ['A4', 'A3', 'Letter', 'Legal', 'Tabloid'], description: 'Paper size. Default A4.' },
    landscape: { type: 'boolean', description: 'Landscape orientation. Default false.' },
    printBackground: { type: 'boolean', description: 'Include CSS backgrounds. Default true.' },
    scale: { type: 'number', description: 'Scale 0.1-2. Default 1.' },
    margin: {
      type: 'object',
      description: 'Margins, e.g. { top:"1in", bottom:"1in", left:"0.5in", right:"0.5in" }. Units: in/mm/cm/px.',
      properties: {
        top: { type: 'string' }, right: { type: 'string' }, bottom: { type: 'string' }, left: { type: 'string' },
      },
    },
  },
  browserPdf,
  { isReadOnly: true },
);

export const browserExportStorageStateTool = makeSimpleBrowserTool(
  'browser_export_storage_state',
  'Save current cookies + localStorage to disk under a name (default "default"). Later use browser_import_storage_state with the same name to restore. Use to save a logged-in state once, reuse across test runs / sessions.',
  {
    name: { type: 'string', description: 'Storage state name. Default "default". a-zA-Z0-9_- chars only.' },
  },
  browserExportStorageState,
  { isReadOnly: false },
);

export const browserImportStorageStateTool = makeSimpleBrowserTool(
  'browser_import_storage_state',
  'Restore cookies + localStorage previously saved via browser_export_storage_state. localStorage restore navigates to each origin briefly (10s each). Returns cookiesLoaded / originsLoaded count.',
  {
    name: { type: 'string', description: 'Storage state name. Default "default".' },
  },
  browserImportStorageState,
);

/* 不走 makeSimpleBrowserTool: 那层先解析 surfaceId (没开浏览器就抛), 而这个工具正是要在
 * 没开/先关掉浏览器的状态下跑。 */
export const browserSyncDailyLoginsTool: Tool = {
  name: 'browser_sync_daily_logins',
  description:
    'Bring the user\'s everyday Chrome login state (cookies) into the agent browser, so sites they are already '
    + 'signed into on this machine do not ask the agent to log in again. Copies the Cookies DB from the daily Chrome '
    + 'profile into an exclusively reserved agent profile, then restarts the agent browser. Only works when the user enabled '
    + 'browserUse.reuseDailyLogins in ~/.neox/config.json (or pass force:true when the user explicitly asked). '
    + 'Call it when a site shows a login page the user is known to be signed into.',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: {
      force: { type: 'boolean', description: 'true only when the user explicitly asked to reuse their logins right now.' },
    },
  },
  async function(a: Record<string, unknown>): Promise<string> {
    return JSON.stringify(await browserSyncDailyLogins({ force: a?.force === true }));
  },
} as unknown as Tool;

export const browserWaitForDownloadTool = makeSimpleBrowserTool(
  'browser_wait_for_download',
  'Wait for a download event (Playwright download listener). Trigger the download first (click "Download" button), THEN call this. Saves to ~/.neox/browser-artifacts/<surfaceId>/downloads/<filename>. Timeout default 30s.',
  {
    timeout: { type: 'number', description: 'Max wait ms. Default 30000.' },
  },
  browserWaitForDownload,
);

export const browserThrottleTool = makeSimpleBrowserTool(
  'browser_throttle',
  'Emulate network conditions. Presets: offline, slow-3g, fast-3g, 4g, wifi, no-throttle. Or custom { downloadKbps, uploadKbps, latencyMs, offline }. Use to test loading behavior under weak network / offline states.',
  {
    preset: { type: 'string', enum: ['offline', 'slow-3g', 'fast-3g', '4g', 'wifi', 'no-throttle'], description: 'Preset. no-throttle restores.' },
    downloadKbps: { type: 'number', description: 'Custom download kbps. Overrides preset.' },
    uploadKbps: { type: 'number', description: 'Custom upload kbps. Overrides preset.' },
    latencyMs: { type: 'number', description: 'Custom latency ms. Overrides preset.' },
    offline: { type: 'boolean', description: 'Force offline. Overrides preset.' },
  },
  browserThrottle,
);

export const browserRecordStartTool = makeSimpleBrowserTool(
  'browser_record_start',
  'Start recording page as a series of JPEG frames via CDP screencast. maxFps default 10, quality default 80. Later call browser_record_stop to persist frames + get framesDir. Use for demoing bug repro or generating training data.',
  {
    quality: { type: 'number', description: 'JPEG quality 0-100. Default 80.' },
    maxFps: { type: 'number', description: 'Max frames per second. Default 10.' },
  },
  browserRecordStart,
);

export const browserRecordStopTool = makeSimpleBrowserTool(
  'browser_record_stop',
  'Stop screencast and persist all frames as frame-000000.jpg ... under ~/.neox/browser-artifacts/<surfaceId>/recordings/<filename>/. Includes meta.json + ffmpeg command hint to stitch mp4. Returns { frames, durationMs, framesDir }.',
  {
    filename: { type: 'string', description: 'Recording folder name (safe chars). Default rec-<ts>.' },
  },
  browserRecordStop,
);

export const browserGetComputedStyleTool = makeSimpleBrowserTool(
  'browser_get_computed_style',
  'Get resolved CSS values (getComputedStyle) for an element. Pass `properties: [...]` to filter; otherwise returns ~30 common ones (color/font/box/position). Useful to verify styling after theme/mode changes.',
  {
    selector: { type: 'string', description: 'CSS selector.' },
    properties: { type: 'array', items: { type: 'string' }, description: 'Optional whitelist, e.g. ["color","background-color"].' },
  },
  browserGetComputedStyle,
  { isReadOnly: true, required: ['selector'] },
);

export const browserGetBboxTool = makeSimpleBrowserTool(
  'browser_get_bbox',
  'Get element geometry: x/y/width/height + inViewport + visible. Fast alternative to full get_aria_tree when you already know the selector and need coordinates for click_at / drag / mouse_move.',
  {
    selector: { type: 'string', description: 'CSS selector.' },
  },
  browserGetBbox,
  { isReadOnly: true, required: ['selector'] },
);

export const browserGetFullDomTool = makeSimpleBrowserTool(
  'browser_get_full_dom',
  'Get outerHTML of an element (or full page if no selector). Default cap 256KB — truncated:true when hit. Use for deep DOM analysis / template extraction / debugging elements that get_aria_tree simplifies away.',
  {
    selector: { type: 'string', description: 'CSS selector (omit → whole document.documentElement).' },
    maxBytes: { type: 'number', description: 'Truncate cap. Default 256000.' },
  },
  browserGetFullDom,
  { isReadOnly: true },
);

// ============================================================================
// Export — flat arrays for runtimeTools registration
// ============================================================================

/** Always-active 工具 — 进 BASE_TOOLS. 只有 list_surfaces 一个, 让 agent 永远能发现状态. */
export const BROWSER_BASE_TOOLS: Tool[] = [browserListSurfacesTool];

/** Pack 工具 — tool_search("browser") 解锁. 40 个交互/读取/诊断/computer-use/multi-tab 工具. */
export const BROWSER_PACK_TOOLS: Tool[] = [
  /* 诊断 */
  browserDiagnoseTool,
  /* 导航 */
  browserNavigateTool, browserBackTool, browserForwardTool, browserReloadTool,
  /* 视觉 */
  browserScreenshotTool, browserGetStateTool,
  /* DOM */
  browserGetAriaTreeTool, browserQueryTool, browserGetTextTool,
  /* 交互 (DOM) */
  browserClickTool, browserTypeTool, browserPressKeyTool, browserScrollTool,
  browserHoverTool, browserSelectOptionTool, browserFillFormTool, browserChooseTool,
  /* Computer-Use (像素坐标) */
  browserClickAtTool, browserMouseMoveTool, browserDragTool,
  browserKeyboardTypeTool, browserKeyboardPressTool,
  /* 等待 */
  browserWaitForTool, browserWaitForNavigationTool,
  /* 网络 / console */
  browserGetConsoleLogsTool, browserGetNetworkTool, browserGetResponseBodyTool,
  /* 断言 / eval */
  browserExpectTool, browserEvalTool,
  /* cookies / storage */
  browserGetCookiesTool, browserSetCookiesTool, browserClearCookiesTool,
  browserGetLocalStorageTool, browserSetLocalStorageTool,
  /* mocks */
  browserMockResponseTool, browserClearMocksTool, browserListMocksTool,
  /* upload */
  browserSetInputFilesTool,
  /* Multi-tab */
  browserNewTabTool, browserCloseTabTool,
  /* UI 测试强化 (P0/P1/P2) — 视口 / 网络空闲 / 高亮 / a11y / 性能 / PDF / 存储态 /
     下载 / 网速 / 视频 / 深度 DOM */
  browserSetViewportTool,
  browserWaitForNetworkIdleTool,
  browserHighlightTool,
  browserA11yScanTool,
  browserGetPerfMetricsTool,
  browserPdfTool,
  browserExportStorageStateTool,
  browserImportStorageStateTool,
  browserSyncDailyLoginsTool,
  browserWaitForDownloadTool,
  browserThrottleTool,
  browserRecordStartTool,
  browserRecordStopTool,
  browserGetComputedStyleTool,
  browserGetBboxTool,
  browserGetFullDomTool,
];

const MODEL_FACING_NAMES = new Set([
  'browser_run',
  /* 录过的脚本 0 token 复跑 —— 模型看不见它就永远不会用, 那这套录制等于白做 */
  'browser_replay',
  /* 感知 */
  'browser_get_aria_tree', 'browser_screenshot', 'browser_get_state',
  'browser_query', 'browser_get_text', 'browser_get_bbox',
  /* 会话 / 诊断 / 登录态 */
  'browser_list_surfaces', 'browser_diagnose',
  'browser_export_storage_state', 'browser_import_storage_state',
  /* 排查用的一次性读取 (不会诱发逐步点击) */
  'browser_get_console_logs', 'browser_get_network', 'browser_get_response_body',
  'browser_close_tab',
]);

/** 供 browser_run 调用的指令集 (name → Tool)。**所有**工具都在这里, 包括不对模型暴露的。 */
export const BROWSER_INSTRUCTION_SET: Map<string, Tool> =
  new Map(BROWSER_PACK_TOOLS.map(t => [t.name, t]));

export const BROWSER_PACK_TOOL_NAMES: string[] =
  ['browser_run', 'browser_replay', ...BROWSER_PACK_TOOLS.map(t => t.name)];

/** pack 解锁时真正交到模型手里的工具名。排查时 NEOX_BROWSER_EXPOSE_ALL=1 放开全部。 */
export const MODEL_FACING_BROWSER_TOOL_NAMES: string[] =
  process.env.NEOX_BROWSER_EXPOSE_ALL === '1'
    ? [...BROWSER_PACK_TOOL_NAMES]
    : BROWSER_PACK_TOOL_NAMES.filter(n => MODEL_FACING_NAMES.has(n));
