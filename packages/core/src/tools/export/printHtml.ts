/**
 * 打印用 HTML 外壳
 *
 * 渲染端 (state/exportActions.ts 的 wrapForPrint) 早就有一份, DocSurfaceViewer 里还有
 * 第二份。core 这边要给 agent 导 PDF, 不能 import renderer 的东西, 所以下沉一份。
 *  三份必然漂移 —— 哪天改样式记得一起改, 或者把渲染端两处也换成引用这里。
 *
 * 中文字体栈不能省: Chromium 在无头窗口里默认字体对中文常常回落成方块。
 */

export interface PrintHtmlOptions {
  title: string;
  /** 已经是 HTML 片段 (mammoth / markdown 渲染的产物) */
  bodyHtml: string;
}

export function wrapForPrint(opts: PrintHtmlOptions): string {
  const title = opts.title.replace(/[<>&]/g, '');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  @page { margin: 1.2cm; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei",
                 "Hiragino Sans GB", "Source Han Sans SC", sans-serif;
    font-size: 14px;
    line-height: 1.7;
    color: #1a1a1a;
    margin: 0;
    padding: 0;
  }
  h1, h2, h3, h4, h5, h6 { font-weight: 600; margin: 1.2em 0 0.5em; line-height: 1.3; }
  h1 { font-size: 24px; }
  h2 { font-size: 20px; }
  h3 { font-size: 17px; }
  p { margin: 0.6em 0; }
  ul, ol { padding-left: 1.6em; margin: 0.6em 0; }
  a { color: #6366f1; text-decoration: underline; }
  table { width: 100%; border-collapse: collapse; margin: 1em 0; font-size: 13px; }
  th, td { border: 1px solid #d4d4d8; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #f4f4f5; font-weight: 600; }
  img { max-width: 100%; height: auto; }
  blockquote {
    border-left: 3px solid #6366f1;
    padding: 4px 0 4px 12px;
    margin: 1em 0;
    color: #525252;
  }
  code { font-family: "JetBrains Mono", monospace; font-size: 0.9em;
         background: #f4f4f5; padding: 1px 5px; border-radius: 3px; }
  pre { background: #f4f4f5; padding: 12px; border-radius: 6px; overflow-x: auto; }
</style>
</head>
<body>${opts.bodyHtml}</body>
</html>`;
}
