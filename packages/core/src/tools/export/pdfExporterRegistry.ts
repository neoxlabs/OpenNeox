/**
 * HTML → PDF 的执行器注册表
 *
 * 跟 terminal/diagnostics 同一条路子: **neox-core 对 electron 零依赖**, 而 printToPDF
 * 只有 Electron 主进程有。所以工具侧只认"有没有 executor", 具体实现由宿主注册:
 *   · 桌面端主进程内直跑 runtime → setPdfExporter(renderHtmlToPdfFile)
 *   · 桌面端 runtime 跑在 worker (默认) → 走 hostCapabilities 的反向 RPC 接到这里
 *   · CLI 宿主没有 Electron → 不注册, 工具如实说"不可用", 不抛
 */

export interface PdfExportOptions {
  html: string;
  /** 绝对路径 —— 边界校验由调用方做完再进来 */
  savePath: string;
  pageSize?: 'A4' | 'A3' | 'A5' | 'Letter' | 'Legal';
  landscape?: boolean;
  margins?: { top?: number; bottom?: number; left?: number; right?: number };
}

export interface PdfExportResult {
  success: boolean;
  file_path?: string;
  size?: number;
  error?: string;
}

export type PdfExporter = (options: PdfExportOptions) => Promise<PdfExportResult>;

let globalPdfExporter: PdfExporter | null = null;

export function setPdfExporter(executor: PdfExporter | null): void {
  globalPdfExporter = executor;
}

export function getPdfExporter(): PdfExporter | null {
  return globalPdfExporter;
}
