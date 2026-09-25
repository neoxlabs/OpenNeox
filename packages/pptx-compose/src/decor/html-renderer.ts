/**
 * decor/html-renderer — HTML/CSS → PNG dataUrl 装饰嵌入 pipeline.
 *
 * 让 agent 用 HTML/CSS (LLM 强项) 描述装饰视觉 (3D 建筑背景 · 复杂纹理 · 精致排版),
 * 我们渲染成 PNG 嵌入 pptx. 语义半失 (装饰是图), 视觉炸.
 *
 * 三种运行时:
 *   1. Electron main (Neox 桌面) · 走 IPC 到主进程 offscreen BrowserView
 *   2. Node standalone · 用 playwright-core 走 headless Chromium
 *   3. Browser · 用 canvas + foreignObject / html2canvas (未来)
 *
 * 主入口 `renderHtmlToImage(html, opts)` 自动 detect 环境.
 * Agent 也可以显式调用 `htmlDecor.<preset>(theme, width, height) → { dataUrl, contentType }`.
 */

export interface HtmlRenderOptions {
  /** 输出宽度 CSS px */
  width: number;
  /** 输出高度 CSS px */
  height: number;
  /** 缩放 · 高 DPI · 默认 2 (@2x) */
  scale?: number;
}

export interface HtmlRenderResult {
  dataUrl: string;
  contentType: 'image/png';
}

/**
 * renderHtmlToImage — 完整 HTML 文档 → PNG dataUrl.
 * html 应该是**完整 HTML 文档字符串**, 含 <html><head><style>...</style></head><body>....
 */
export async function renderHtmlToImage(html: string, opts: HtmlRenderOptions): Promise<HtmlRenderResult> {
  const scale = opts.scale ?? 2;

  /* 1. 优先走同进程 bridge (Electron main 内直接调 compose 时) */
  const neox = getGlobalNeoxBridge();
  if (neox?.renderHtmlToImage) {
    const dataUrl = await neox.renderHtmlToImage(html, opts.width, opts.height, scale);
    return { dataUrl, contentType: 'image/png' };
  }

  /* 2. HTTP 渲染桥 (架构升级) — agent 的 node 子进程走这里.
   * Electron main 起的 127.0.0.1 server, 地址在 NEOX_PPTX_BRIDGE_URL.
   * 这是打包版子进程唯一可靠的渲染路径 (playwright 不随包发布). */
  const bridgeUrl = typeof process !== 'undefined' ? process.env?.NEOX_PPTX_BRIDGE_URL : undefined;
  let bridgeFailure: string | null = null;
  if (bridgeUrl && typeof fetch === 'function') {
    try {
      const resp = await fetch(`${bridgeUrl}/render-html`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ html, width: opts.width, height: opts.height, scale }),
      });
      if (resp.ok) {
        const j = await resp.json() as { dataUrl?: string };
        if (j?.dataUrl) return { dataUrl: j.dataUrl, contentType: 'image/png' };
        bridgeFailure = 'render bridge returned no image';
      } else {
        bridgeFailure = `render bridge HTTP ${resp.status}`;
      }
    } catch (e) {
      bridgeFailure = `render bridge unreachable: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /* 3. Fallback 走 playwright-core (Node · dev 环境) */
  try {
    const pw = await import('playwright-core' as any);
    const browser = await pw.chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: opts.width, height: opts.height },
      deviceScaleFactor: scale,
    });
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    const buffer = await page.screenshot({ type: 'png', omitBackground: false });
    await browser.close();
    const base64 = Buffer.from(buffer).toString('base64');
    return {
      dataUrl: `data:image/png;base64,${base64}`,
      contentType: 'image/png',
    };
  } catch (e) {
    /* 渲不出来必须明确失败, 原因带全, 让调用方决定跳过装饰还是报错:
     * 返回占位图 (如 1x1 透明 PNG) 会让调用方把空图嵌进幻灯片还当成渲染成功。 */
    const reasons = [bridgeFailure, `playwright unavailable: ${e instanceof Error ? e.message : String(e)}`]
      .filter(Boolean)
      .join('; ');
    throw new HtmlRenderUnavailableError(`renderHtmlToImage: no renderer available (${reasons})`);
  }
}

/** 没有任何可用的 HTML 渲染运行时 (Electron 桥 / HTTP 桥 / playwright 都不行)。 */
export class HtmlRenderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HtmlRenderUnavailableError';
  }
}

interface NeoxBridge {
  renderHtmlToImage?: (html: string, w: number, h: number, scale: number) => Promise<string>;
}
function getGlobalNeoxBridge(): NeoxBridge | undefined {
  return (globalThis as any).__neoxComposeBridge__ as NeoxBridge | undefined;
}

/**
 * 让 Electron main 注册桥接 · main.ts 里调:
 *   registerNeoxComposeBridge({ renderHtmlToImage: async (html, w, h, scale) => {...} })
 */
export function registerNeoxComposeBridge(bridge: NeoxBridge): void {
  (globalThis as any).__neoxComposeBridge__ = bridge;
}
