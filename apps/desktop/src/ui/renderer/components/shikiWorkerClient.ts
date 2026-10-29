/* 主线程这一侧: 把分词请求发给 shikiHighlight.worker, 拿回 tokens[行]。
 *
 * 整个应用共用一个 worker —— 语法编译 (loadLanguage) 的钱只付一次。
 * worker 懒创建: 没人看代码块就不起线程、不下 shiki 的 WASM。
 * 放在单独模块而不是 shikiHighlighter.ts: 那个文件 worker 自己也要 import (SHIKI_LANGS),
 * 两边互相引用会把 Worker 构造拖进 worker 包里。 */
import { LANG_ALIASES, SHIKI_LANGS, type ShikiToken } from './shikiHighlighter';
import type { ShikiWorkerRequest, ShikiWorkerResponse } from './shikiHighlight.worker';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (tokens: ShikiToken[][] | null) => void>();

function getWorker(): Worker | null {
  if (worker) return worker;
  /* 测试环境 (vitest/jsdom) 没有 Worker: 代码块照常显示纯文本 */
  if (typeof Worker === 'undefined') return null;
  worker = new Worker(new URL('./shikiHighlight.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<ShikiWorkerResponse>) => {
    const resolve = pending.get(ev.data.id);
    if (!resolve) return;
    pending.delete(ev.data.id);
    resolve(ev.data.tokens);
  };
  worker.onerror = (ev) => {
    /* worker 整个挂了 (脚本加载失败等): 在途请求全部按"无高亮"结清, 下次请求重建 */
    console.warn('[shiki-worker] crashed:', ev.message);
    for (const resolve of pending.values()) resolve(null);
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** 语言名归一: 别名 → 正式名; 不在白名单里的返回 null (不高亮)。 */
export function normalizeShikiLang(lang: string | undefined): string | null {
  if (!lang) return null;
  const lower = lang.toLowerCase();
  const aliased = LANG_ALIASES[lower] || lower;
  return (SHIKI_LANGS as readonly string[]).includes(aliased) ? aliased : null;
}

/** 在 worker 里分词。认不出语言 / 没有 Worker / 分词失败 → null。 */
export function highlightInWorker(code: string, lang: string | undefined, theme: 'github-dark' | 'github-light'): Promise<ShikiToken[][] | null> {
  const resolved = normalizeShikiLang(lang);
  if (!resolved) return Promise.resolve(null);
  const w = getWorker();
  if (!w) return Promise.resolve(null);
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    w.postMessage({ id, code, lang: resolved, theme } satisfies ShikiWorkerRequest);
  });
}
