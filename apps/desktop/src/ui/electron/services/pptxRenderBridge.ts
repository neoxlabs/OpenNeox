
import { BrowserWindow } from 'electron';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

const MAX_BODY_BYTES = 24 * 1024 * 1024; /* 24MB · 装饰 HTML 内嵌 base64 图片的余量 */
const RENDER_TIMEOUT_MS = 20_000;

/** offscreen BrowserWindow 渲 HTML → PNG dataUrl. 主进程内直接调用也走这里. */
export async function renderHtmlToPngDataUrl(
  html: string,
  width: number,
  height: number,
  scale = 2,
): Promise<string> {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const s = Math.min(4, Math.max(1, scale));
  const win = new BrowserWindow({
    width: Math.round(w * s),
    height: Math.round(h * s),
    show: false,
    /* 工具窗口: 永不进任务栏 / alt-tab (同 fileSystemHandlers 的 printToPDF 窗口)。 */
    skipTaskbar: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    const result = await Promise.race([
      (async () => {
        await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
        /* zoom = scale → CSS 视口回到 w×h, 像素原生 @scale — 不做事后插值放大 */
        win.webContents.setZoomFactor(s);
        /* 字体加载完再截 — 中文字体大, 不等就截到 fallback 字形 */
        try {
          await win.webContents.executeJavaScript(
            `document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true`,
            true,
          );
        } catch { /* 页面脚本被 CSP 拦之类 · 继续走定时兜底 */ }
        await new Promise((r) => setTimeout(r, 80));
        const img = await win.webContents.capturePage();
        return `data:image/png;base64,${img.toPNG().toString('base64')}`;
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('render-html timeout')), RENDER_TIMEOUT_MS)),
    ]);
    return result;
  } finally {
    try { win.destroy(); } catch { /* ignore */ }
  }
}

let serverRef: Server | null = null;

/**
 * 启动渲染桥 HTTP server. 返回 base URL (含随机 token 路径段).
 * 调用方负责把它塞进 process.env.NEOX_PPTX_BRIDGE_URL (必须在 agent shell spawn 之前).
 */
export function startPptxRenderBridge(): Promise<string> {
  if (serverRef) throw new Error('pptx render bridge already started');
  const token = randomUUID();

  const server = createServer((req, res) => {
    const respond = (code: number, body: unknown) => {
      const json = JSON.stringify(body);
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
      res.end(json);
    };

    if (req.method !== 'POST' || req.url !== `/${token}/render-html`) {
      respond(404, { error: 'not found' });
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        respond(413, { error: 'body too large' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      void (async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            html?: string; width?: number; height?: number; scale?: number;
          };
          if (!body.html || !body.width || !body.height) {
            respond(400, { error: 'html/width/height required' });
            return;
          }
          const dataUrl = await renderHtmlToPngDataUrl(body.html, body.width, body.height, body.scale ?? 2);
          respond(200, { dataUrl });
        } catch (err) {
          respond(500, { error: err instanceof Error ? err.message : String(err) });
        }
      })();
    });
    req.on('error', () => { /* client 掐了 · 忽略 */ });
  });

  serverRef = server;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    /* 127.0.0.1-only + 随机端口 + 随机 token: 本机其它用户/进程猜不到路径 */
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('bridge listen failed'));
        return;
      }
      resolve(`http://127.0.0.1:${addr.port}/${token}`);
    });
  });
}

export function stopPptxRenderBridge(): void {
  try { serverRef?.close(); } catch { /* ignore */ }
  serverRef = null;
}
