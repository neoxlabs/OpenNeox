/**
 * PDF 本地解析 — 用 pdfjs-dist (Mozilla 官方, browser-compatible).
 *
 * 对应 NeoxCloud 的 pdf-parse (Node 端), 但客户端只能用 pdfjs-dist
 * (pdf-parse 是 Node-only).
 *
 * 跟服务端 pdfParser 同语义: 抽 PDF 含文字层的 text, 段落折行.
 * 不支持 OCR 扫描 PDF — 想要 OCR 用户切到云端模式.
 */

/* pdfjs-dist 4.x+ 强制要求 GlobalWorkerOptions.workerSrc (即使 disableWorker=true
 * 也会校验, 不设直接抛 "No GlobalWorkerOptions.workerSrc specified.").
 *
 * 解决: 用 Vite 的 ?worker import 把 pdf.worker 打成 web worker bundle,
 * 然后通过 workerPort 注入 — 跟 Neox Editor Engine worker 注入同款.
 * 这样 pdfjs 在真 worker 跑, 多线程不阻塞主 UI, 大 PDF 也不卡. */

import PdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';

let pdfjsPromise: Promise<any> | null = null;

async function getPdfjs(): Promise<any> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then(mod => {
      /* 初始化一次: 注入 workerPort. 不能用 workerSrc URL (Electron renderer
       * file:// 协议会被安全策略拦), 必须 workerPort 直接给已实例化 worker. */
      if (!mod.GlobalWorkerOptions.workerPort) {
        mod.GlobalWorkerOptions.workerPort = new PdfjsWorker();
      }
      return mod;
    });
  }
  return pdfjsPromise;
}

export async function parsePdfLocal(buffer: ArrayBuffer): Promise<{ markdown: string; pages: number }> {
  const pdfjs = await getPdfjs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
  });
  const pdf = await loadingTask.promise;
  const pages = pdf.numPages;
  const sections: string[] = [];
  for (let i = 1; i <= pages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((it: any) => it.str || '').join(' ');
    sections.push(text.trim());
  }
  const markdown = sections.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return { markdown, pages };
}
