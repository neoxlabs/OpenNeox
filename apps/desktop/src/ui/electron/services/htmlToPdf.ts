
import { BrowserWindow } from 'electron';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';

export interface HtmlToPdfOptions {
  html: string;
  /** 绝对路径, **且调用方已经做过授权/边界校验** */
  savePath: string;
  pageSize?: 'A4' | 'A3' | 'A5' | 'Letter' | 'Legal';
  landscape?: boolean;
  margins?: { top?: number; bottom?: number; left?: number; right?: number };
}

export interface HtmlToPdfResult {
  success: boolean;
  file_path?: string;
  size?: number;
  error?: string;
}

export async function renderHtmlToPdfFile(options: HtmlToPdfOptions): Promise<HtmlToPdfResult> {
  const { html, savePath } = options;
  if (!html || typeof html !== 'string') return { success: false, error: 'html required' };
  if (!savePath || !path.isAbsolute(savePath)) return { success: false, error: 'savePath 必须是绝对路径' };

  /* 隐藏 BrowserWindow 渲染 HTML → printToPDF → 写盘。
   * 用 loadURL data:text/html;base64,… 比 loadFile 简单 (不用 tmpfile)。 */
  let win: BrowserWindow | null = null;
  try {
    const parent = path.dirname(savePath);
    if (!fsSync.existsSync(parent)) fsSync.mkdirSync(parent, { recursive: true });

    win = new BrowserWindow({
      show: false,
      /* 工具窗口: 永不进任务栏 / alt-tab。show:false 期间本来就不会出现, 但 printToPDF
       * 过程中任何一次意外 show (Electron 某些版本在 loadURL 失败时会短暂现窗) 都会
       * 甩出一个没有图标的条目 —— 那正是 Windows 上"多出来一个 Electron 图标"的形态。
       * Win10 Alt+Tab 对 skipTaskbar 不完全认账, 必须再加 type:toolbar。 */
      skipTaskbar: true,
      ...(process.platform === 'win32' ? { type: 'toolbar' as const } : {}),
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });

    const b64 = Buffer.from(html, 'utf-8').toString('base64');
    await win.loadURL(`data:text/html;charset=utf-8;base64,${b64}`);

    const pdfBuf = await win.webContents.printToPDF({
      pageSize: options.pageSize ?? 'A4',
      landscape: options.landscape ?? false,
      printBackground: true,
      margins: options.margins
        ? {
            top: options.margins.top ?? 0.4,
            bottom: options.margins.bottom ?? 0.4,
            left: options.margins.left ?? 0.4,
            right: options.margins.right ?? 0.4,
          }
        : undefined,
    });

    await fs.writeFile(savePath, pdfBuf);
    const stats = await fs.stat(savePath);
    return { success: true, file_path: savePath, size: stats.size };
  } catch (error: any) {
    return { success: false, error: error?.message || String(error) };
  } finally {
    if (win && !win.isDestroyed()) {
      try { win.close(); } catch { /* ignore */ }
    }
  }
}
