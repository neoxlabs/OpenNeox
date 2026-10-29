import { createHighlighter, type HighlighterGeneric } from 'shiki';
import { SHIKI_LANGS, type ShikiToken } from './shikiHighlighter';

export type ShikiWorkerRequest = { id: number; code: string; lang: string; theme: string };
export type ShikiWorkerResponse = { id: number; tokens: ShikiToken[][] | null };

let highlighterPromise: Promise<HighlighterGeneric<any, any>> | null = null;
const langLoads = new Map<string, Promise<void>>();

function getHighlighter(): Promise<HighlighterGeneric<any, any>> {
  /* 语言按需载: 一次编译全部 40 种语法要 ~200ms, 大多数会话只用到两三种 */
  if (!highlighterPromise) highlighterPromise = createHighlighter({ themes: ['github-dark', 'github-light'], langs: [] });
  return highlighterPromise;
}

async function ensureLang(hl: HighlighterGeneric<any, any>, lang: string): Promise<boolean> {
  if (!(SHIKI_LANGS as readonly string[]).includes(lang)) return false;
  if (hl.getLoadedLanguages().includes(lang)) return true;
  let pending = langLoads.get(lang);
  if (!pending) {
    pending = hl.loadLanguage(lang as any).catch((err) => {
      langLoads.delete(lang);
      throw err;
    });
    langLoads.set(lang, pending);
  }
  await pending;
  return true;
}

self.onmessage = async (ev: MessageEvent<ShikiWorkerRequest>) => {
  const { id, code, lang, theme } = ev.data;
  let tokens: ShikiToken[][] | null = null;
  try {
    const hl = await getHighlighter();
    if (await ensureLang(hl, lang)) {
      const result = hl.codeToTokens(code, { lang: lang as any, theme });
      /* 只回渲染用得到的三个字段: shiki 的 token 还带 offset/explanation 等, 结构化克隆按字段算钱 */
      tokens = result.tokens.map((line) => line.map((t) => ({ content: t.content, color: t.color, fontStyle: t.fontStyle })));
    }
  } catch (err) {
    console.warn('[shiki-worker] highlight failed:', err);
  }
  (self as unknown as Worker).postMessage({ id, tokens } satisfies ShikiWorkerResponse);
};
