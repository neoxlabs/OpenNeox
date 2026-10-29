import { ipcMain, BrowserWindow, clipboard, nativeImage, dialog, shell } from 'electron';
import { writeFile } from 'node:fs/promises';
import type { NativeImage } from 'electron';

export interface ShareCardRequest {
  /** 正文 (纯文本 / 轻 markdown) */
  text: string;
  /** 生成这条回复的模型, 可选 —— 署名行显示 */
  model?: string;
  /** 本轮消耗 token, 可选 */
  tokens?: number;
  theme?: 'dark' | 'light';
  /** 卡片宽度 (CSS px), 默认 720 */
  width?: number;
}

/**
 * Windows 剪贴板默认的 CF_BITMAP / writeImage **不带 alpha**,
 * 透明圆角会被填成黑或白 —— 分享卡一粘贴四角就脏。
 *
 * 做法: 同时放 PNG (GIMP / 新 Office / 部分 IM 优先读) + 32bpp BITFIELDS DIB
 * (Discord / 微信 / Chrome 等会把第 4 字节当 alpha 用)。
 * **不要**再 writeImage: 它会塞一份不透明位图, 很多应用反而优先用那份。
 */
function nativeImageToAlphaDib(img: NativeImage): Buffer {
  const { width, height } = img.getSize();
  const bgra = img.toBitmap();
  const stride = width * 4;
  /* DIB 行序自底向上 */
  const flipped = Buffer.allocUnsafe(bgra.length);
  for (let y = 0; y < height; y++) {
    const src = y * stride;
    bgra.copy(flipped, (height - 1 - y) * stride, src, src + stride);
  }
  const hdrSize = 40;
  const masks = 12;
  const header = Buffer.alloc(hdrSize + masks);
  header.writeUInt32LE(hdrSize, 0);
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(3, 16); /* BI_BITFIELDS */
  header.writeUInt32LE(flipped.length, 20);
  header.writeUInt32LE(0x00ff0000, hdrSize + 0);
  header.writeUInt32LE(0x0000ff00, hdrSize + 4);
  header.writeUInt32LE(0x000000ff, hdrSize + 8);
  return Buffer.concat([header, flipped]);
}

function writeClipboardImageWithAlpha(img: NativeImage): void {
  if (img.isEmpty()) throw new Error('EMPTY_IMAGE');
  if (process.platform !== 'win32') {
    clipboard.writeImage(img);
    return;
  }
  const png = img.toPNG();
  const dib = nativeImageToAlphaDib(img);
  clipboard.clear();
  clipboard.writeBuffer('PNG', png);
  try { clipboard.writeBuffer('image/png', png); } catch { /* 个别 Electron 版本无此 format */ }
  clipboard.writeBuffer('DIB', dib);
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 轻量 markdown → HTML。只处理分享卡里真正会出现的那几种,
 *  不引 markdown 库: 卡片是给人看的图, 不需要完整 CommonMark。 */
function lightMarkdown(src: string): string {
  const lines = escapeHtml(src).split('\n');
  const out: string[] = [];
  let inCode = false;
  let inList = false;
  /* 代码行攒起来最后一次性拼 —— 若逐行 out.push, join('\n') 会在 <pre><code> 前后
   * 各多出一个字面换行, pre-wrap 下就是代码块顶部/底部各一条空行 (截图里那块空白)。 */
  let codeBuf: string[] = [];
  const flushCode = () => {
    out.push(`<pre><code>${codeBuf.join('\n')}</code></pre>`);
    codeBuf = [];
  };
  for (const raw of lines) {
    const line = raw;
    if (/^```/.test(line.trim())) {
      if (inList) { out.push('</ul>'); inList = false; }
      if (inCode) flushCode();
      inCode = !inCode;
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (!line.trim()) { out.push('<div class="sp"></div>'); continue; }
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  if (inCode) flushCode();
  return out.join('\n');

  function inline(t: string): string {
    return t
      .replace(/`([^`]+)`/g, '<code class="ic">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }
}

/** 卡片圆角 —— 生成端 CSS、抓图后的 alpha 遮罩、渲染端预览三处必须是同一个数 */
const CARD_RADIUS = 20;

function buildCardHtml(req: ShareCardRequest): string {
  const dark = req.theme !== 'light';
  const W = Math.min(1000, Math.max(420, req.width ?? 720));
  const surface = dark
    ? 'radial-gradient(120% 140% at 85% -10%, rgba(124,108,255,0.16), transparent 58%),'
      + 'radial-gradient(110% 120% at -5% 105%, rgba(167,139,250,0.10), transparent 52%),'
      + 'linear-gradient(150deg, #1a1822, #141419 62%, #191320)'
    : 'radial-gradient(120% 140% at 85% -10%, rgba(124,108,255,0.09), transparent 58%),'
      + 'radial-gradient(110% 120% at -5% 105%, rgba(167,139,250,0.07), transparent 52%),'
      + 'linear-gradient(150deg, #fbfaff, #ffffff 62%, #faf8ff)';
  const fg = dark ? '#e9e9ee' : '#1a1a1f';
  const dim = dark ? '#8d8d99' : '#6b6b78';
  const line = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)';
  const codeBg = dark ? 'rgba(255,255,255,0.055)' : 'rgba(20,16,50,0.045)';

  const meta = [req.model ?? '', req.tokens ? `${req.tokens.toLocaleString()} tokens` : '']
    .filter((x): x is string => !!x).map(escapeHtml).join(' · ');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  /* 圆角外那一圈必须真透明 —— html 给了底色的话, 四角照样被填成直角 */
  html{background:transparent}
  /* 一张 surface —— body 就是卡本身, 不再有外框 + 内卡两层。
     四角在 PNG 里就是圆的 (alpha 透明), 预览和导出因此完全一致。 */
  body{width:${W}px;background:${surface};color:${fg};
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    -webkit-font-smoothing:antialiased;padding:0;
    border-radius:${CARD_RADIUS}px;overflow:hidden}
  .card{background:none;border:0;border-radius:0;box-shadow:none;
    /* 底部 22 → 28: 弹窗里那条浮动工具条会压住图的下缘一小截,
       留够余量它就永远碰不到页脚那行字。导出的 PNG 也因此下方更透气。 */
    padding:34px 36px 28px;overflow:hidden}
  /* 品牌行只留字。原来前面还有一颗紫色发光圆点 —— 用户 2026-08-22:「不需要圆点!
     这么简单的 logo」。字标本身已经是标识, 圆点是纯装饰, 还跟正文抢第一眼。 */
  .brand{display:flex;align-items:center;margin-bottom:20px}
  .name{font-size:13.5px;font-weight:700;letter-spacing:.05em;color:${fg}}
  .body{font-size:15.5px;line-height:1.85;letter-spacing:.004em;word-break:break-word}
  .body p{margin:0 0 2px}
  .body .sp{height:11px}
  .body h1{font-size:20px;font-weight:650;margin:14px 0 6px}
  .body h2{font-size:17.5px;font-weight:650;margin:13px 0 5px}
  .body h3{font-size:16px;font-weight:650;margin:12px 0 4px}
  .body ul{margin:4px 0 8px;padding-left:20px}
  .body li{margin:3px 0;line-height:1.8}
  .body code.ic{background:${codeBg};border-radius:4px;padding:1px 5px;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
  .body pre{background:${codeBg};border:1px solid ${line};border-radius:10px;
    padding:10px 13px;margin:8px 0;overflow:hidden}
  .body pre code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-size:13px;line-height:1.65;white-space:pre-wrap;word-break:break-word}
  .foot{margin-top:22px;padding-top:13px;border-top:1px solid ${line};
    display:flex;align-items:center;justify-content:space-between;gap:16px}
  .foot .by{font-size:12px;color:${dim}}
  .foot .mt{font-size:11.5px;color:${dim};font-variant-numeric:tabular-nums;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  </style></head><body><div class="card">
    <div class="brand"><span class="name">Neox</span></div>
    <div class="body">${lightMarkdown(req.text)}</div>
    <div class="foot"><span class="by">由 Neox 生成</span>${meta ? `<span class="mt">${meta}</span>` : ''}</div>
  </div></body></html>`;
}

export function applyRoundedAlpha(buf: Buffer, w: number, h: number, radius: number): Buffer {
  const r = Math.max(0, Math.min(radius, Math.floor(Math.min(w, h) / 2)));
  if (r === 0) return buf;
  /* 每个角的圆心 */
  const corners: Array<[number, number, number, number]> = [
    [0, 0, r, r],                 /* 左上: x<r && y<r, 圆心 (r,r) */
    [w - r, 0, w - r - 1, r],     /* 右上 */
    [0, h - r, r, h - r - 1],     /* 左下 */
    [w - r, h - r, w - r - 1, h - r - 1], /* 右下 */
  ];
  for (const [x0, y0, cx, cy] of corners) {
    for (let y = y0; y < y0 + r; y++) {
      for (let x = x0; x < x0 + r; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= r - 1) continue;                 /* 完全在圆内 */
        const i = (y * w + x) * 4 + 3;               /* BGRA 的 A */
        if (i >= buf.length) continue;
        /* r-1 .. r 之间线性淡出 = 1px 抗锯齿 */
        const a = dist >= r ? 0 : Math.round(255 * (r - dist));
        buf[i] = Math.min(buf[i], a);
      }
    }
  }
  return buf;
}

async function renderAutoHeight(html: string, width: number, scale = 2): Promise<string> {
  const s = Math.min(4, Math.max(1, scale));
  const win = new BrowserWindow({
    width: Math.round(width * s),
    height: Math.round(200 * s),
    show: false,
    skipTaskbar: true,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    return await Promise.race([
      (async () => {
        await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
        win.webContents.setZoomFactor(s);
        /* 中文字体大, 不等 fonts.ready 会截到 fallback 字形 */
        try {
          await win.webContents.executeJavaScript(
            'document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true', true,
          );
        } catch { /* CSP 拦了脚本也无妨, 下面还有定时兜底 */ }
        const h = await win.webContents.executeJavaScript(
          'Math.ceil(document.body.getBoundingClientRect().height)', true,
        ) as number;
        const height = Math.min(4000, Math.max(120, Number(h) || 320));
        win.setSize(Math.round(width * s), Math.round(height * s));
        await new Promise((r) => setTimeout(r, 90));
        const img = await win.webContents.capturePage();
        /* 圆角在这里补 —— 见 applyRoundedAlpha 的说明: capturePage 不给 alpha,
         * CSS 的 border-radius 到不了导出的 PNG。 */
        const dip = img.getSize();
        const bmp = img.toBitmap();
        const px = bmp.length / 4;
        /* toBitmap 的分辨率可能是 DIP 也可能是物理像素, 用字节数反推倍率, 别假设 */
        const ratio = dip.width > 0 && dip.height > 0
          ? Math.max(1, Math.round(Math.sqrt(px / (dip.width * dip.height))))
          : 1;
        const pw = dip.width * ratio;
        const ph = dip.height * ratio;
        if (pw * ph * 4 === bmp.length) {
          const pxPerCss = width > 0 ? pw / width : ratio;
          applyRoundedAlpha(bmp, pw, ph, Math.round(CARD_RADIUS * pxPerCss));
          const rounded = nativeImage.createFromBitmap(bmp, { width: pw, height: ph });
          return `data:image/png;base64,${rounded.toPNG().toString('base64')}`;
        }
        /* 反推不出尺寸就原样返回, 宁可方角也不要糊掉整张图 */
        return `data:image/png;base64,${img.toPNG().toString('base64')}`;
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('share card render timeout')), 15_000)),
    ]);
  } finally {
    try { win.destroy(); } catch { /* ignore */ }
  }
}

export function registerShareCardHandlers(): void {
  ipcMain.handle('share:render-card', async (_e, req: ShareCardRequest) => {
    try {
      const text = String(req?.text ?? '').slice(0, 8000); /* 太长的截断, 卡片不是文档 */
      if (!text.trim()) return { ok: false, error: 'EMPTY' };
      const width = Math.min(1000, Math.max(420, Number(req?.width) || 720));
      const html = buildCardHtml({ ...req, text, width });
      const dataUrl = await renderAutoHeight(html, width, 2);
      return { ok: true, dataUrl };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  /* 复制到剪贴板 —— 直接从 dataUrl 建 nativeImage, 不落盘。
   * Windows 必须走 PNG+DIB 双格式, 否则透明圆角变黑/白。 */
  ipcMain.handle('share:copy-card', async (_e, dataUrl: string) => {
    try {
      const img = nativeImage.createFromDataURL(String(dataUrl || ''));
      writeClipboardImageWithAlpha(img);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  /* 分享到 X —— web intent 带不了图 (媒体上传要 OAuth 走 API), 所以走
   * 「图进剪贴板 + 拉起发帖框」: 用户在 X 的输入框里 ⌘V, 图就贴上了。
   * 这是不接 X API 的前提下最短的路径, 也不用管 token 过期。 */
  ipcMain.handle('share:share-x', async (_e, dataUrl: string, text?: string) => {
    try {
      const img = nativeImage.createFromDataURL(String(dataUrl || ''));
      writeClipboardImageWithAlpha(img);
      const t = String(text ?? '').slice(0, 280);
      await shell.openExternal(
        'https://x.com/intent/post' + (t ? `?text=${encodeURIComponent(t)}` : ''),
      );
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  /* 另存为 PNG —— 给需要发文件的场景 (邮件附件 / 微信发文件)。 */
  ipcMain.handle('share:save-card', async (_e, dataUrl: string) => {
    try {
      const img = nativeImage.createFromDataURL(String(dataUrl || ''));
      if (img.isEmpty()) return { ok: false, error: 'EMPTY_IMAGE' };
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const r = await dialog.showSaveDialog({
        title: '保存分享卡片',
        defaultPath: `neox-${stamp}.png`,
        filters: [{ name: 'PNG', extensions: ['png'] }],
      });
      if (r.canceled || !r.filePath) return { ok: false, error: 'CANCELED' };
      await writeFile(r.filePath, img.toPNG());
      return { ok: true, path: r.filePath };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
}
