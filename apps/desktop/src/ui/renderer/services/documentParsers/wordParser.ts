/**
 * Word (docx) 本地解析 — 用 mammoth.browser.
 *
 * 对应 NeoxCloud 的 wordParser, 逻辑/htmlToMarkdown 完全镜像.
 * 输出 HTML 后用极简正则转 markdown, 不引入 turndown 这种重库.
 */

let mammothPromise: Promise<any> | null = null;

async function getMammoth(): Promise<any> {
  if (!mammothPromise) {
    /* renderer 用浏览器 entry (import() 动态加载, 不影响首屏); 主进程 (手机发来的附件走
     * mobile-bridge 解析) 用 node entry —— 浏览器包在 node 里能加载但 zip 读取走的是 DOM 路径。 */
    mammothPromise = (typeof (globalThis as any).window === 'undefined'
      ? import('mammoth' as any)
      : import('mammoth/mammoth.browser.js' as any)
    ).then((m: any) => m.default ?? m);
  }
  return mammothPromise;
}

/** 极简 HTML → Markdown — 跟 NeoxCloud wordParser.htmlToMarkdown 同一份逻辑.
 * 覆盖 mammoth 实际产出的标签子集: h1-h6 / p / strong / em / a / ul/ol/li / table / br. */
function htmlToMarkdown(html: string): string {
  let md = html;
  for (let i = 1; i <= 6; i++) {
    const hashes = '#'.repeat(i);
    md = md.replace(new RegExp(`<h${i}[^>]*>(.*?)<\\/h${i}>`, 'gi'), (_, t) => `\n\n${hashes} ${t.trim()}\n\n`);
  }
  md = md
    .replace(/<p[^>]*>(.*?)<\/p>/gi, (_, t) => `\n\n${t.trim()}\n\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**')
    .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
    .replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
    .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
    .replace(/<\/?ul[^>]*>/gi, '\n')
    .replace(/<\/?ol[^>]*>/gi, '\n')
    .replace(/<tr[^>]*>(.*?)<\/tr>/gi, (_, row) => {
      const cells = String(row).match(/<t[hd][^>]*>(.*?)<\/t[hd]>/gi) || [];
      const items = cells.map(c => c.replace(/<\/?t[hd][^>]*>/gi, '').trim());
      return `| ${items.join(' | ')} |\n`;
    })
    .replace(/<\/?table[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return md;
}

export async function parseWordLocal(buffer: ArrayBuffer): Promise<{ markdown: string }> {
  const mammoth = await getMammoth();
  /* node entry 只认 {buffer} (lib/unzip.js), 浏览器 entry 只认 {arrayBuffer} */
  const input = typeof (globalThis as any).window === 'undefined'
    ? { buffer: (globalThis as any).Buffer.from(buffer) }
    : { arrayBuffer: buffer };
  const result = await mammoth.convertToHtml(input);
  const markdown = htmlToMarkdown(result.value || '');
  return { markdown };
}
