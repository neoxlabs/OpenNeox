
export type ShikiToken = { content: string; color?: string; fontStyle?: number };

export type ShikiHighlighter = {
  codeToTokens: (code: string, options: { lang: string; theme: string }) => any;
  getLoadedLanguages: () => string[];
  loadLanguage?: (lang: string) => Promise<void>;
};

let shikiPromise: Promise<ShikiHighlighter> | null = null;

export const SHIKI_LANGS = [
  'javascript', 'typescript', 'jsx', 'tsx', 'json', 'yaml', 'toml',
  'python', 'go', 'rust', 'java', 'kotlin', 'scala', 'ruby', 'php', 'csharp',
  'c', 'cpp', 'objective-c', 'swift',
  'bash', 'shell', 'powershell', 'dockerfile', 'nginx', 'ini',
  'sql', 'graphql', 'markdown', 'xml', 'html', 'css', 'scss', 'less',
  'vue', 'svelte', 'astro', 'diff', 'makefile', 'lua', 'haskell',
] as const;

export const getShiki = (): Promise<ShikiHighlighter> => {
  if (!shikiPromise) {
    shikiPromise = (async () => {
      const shiki = await import('shiki');
      const highlighter = await shiki.createHighlighter({
        themes: ['github-dark', 'github-light'],
        langs: [],
      });
      return highlighter as unknown as ShikiHighlighter;
    })();
  }
  return shikiPromise;
};

const langLoads = new Map<string, Promise<void>>();

/**
 * 确保某语言已加载, 返回可直接传给 codeToTokens 的语言名; 不认识的语言返回 'text'。
 * 同一语言并发调用共用一次加载。
 */
export async function ensureShikiLang(highlighter: ShikiHighlighter, lang: string | undefined): Promise<string> {
  if (!lang) return 'text';
  const normalized = lang.toLowerCase();
  const aliased = LANG_ALIASES[normalized] || normalized;
  if (!(SHIKI_LANGS as readonly string[]).includes(aliased)) return 'text';
  if (highlighter.getLoadedLanguages().includes(aliased)) return aliased;
  if (!highlighter.loadLanguage) return 'text';
  let pending = langLoads.get(aliased);
  if (!pending) {
    pending = highlighter.loadLanguage(aliased).catch((err) => {
      langLoads.delete(aliased);
      throw err;
    });
    langLoads.set(aliased, pending);
  }
  await pending;
  return aliased;
}

export const LANG_ALIASES: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  sh: 'bash',
  zsh: 'bash',
  shell: 'bash',
  py: 'python',
  rs: 'rust',
  cs: 'csharp',
  objc: 'objective-c',
  md: 'markdown',
  yml: 'yaml',
  'c++': 'cpp',
};

export const resolveShikiLang = (lang: string | undefined, loaded: string[]): string => {
  if (!lang) return 'text';
  const normalized = lang.toLowerCase();
  const aliased = LANG_ALIASES[normalized] || normalized;
  return loaded.includes(aliased) ? aliased : 'text';
};

/* 文件名 → 语言。给 diff 用的: 那边没有 ```lang 围栏, 只有一个路径。
 * 认不出来就返回 undefined → resolveShikiLang 落到 'text' (不高亮, 不报错)。 */
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  css: 'css', scss: 'scss', less: 'less',
  html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
  md: 'markdown', markdown: 'markdown',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini',
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
  scala: 'scala', rb: 'ruby', php: 'php', cs: 'csharp',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp',
  m: 'objective-c', mm: 'objective-c', swift: 'swift',
  sql: 'sql', graphql: 'graphql', gql: 'graphql',
  vue: 'vue', svelte: 'svelte', astro: 'astro', lua: 'lua', hs: 'haskell',
};

const SPECIAL_NAME_TO_LANG: Array<[RegExp, string]> = [
  [/^dockerfile$|\.dockerfile$/i, 'dockerfile'],
  [/^(gnu)?makefile$/i, 'makefile'],
  [/^\.?(bash|zsh)(rc|_profile|_history)$/i, 'bash'],
  [/^nginx\.conf$/i, 'nginx'],
];

export function langFromPath(path: string): string | undefined {
  const name = (path.split('/').pop() || '').trim();
  if (!name) return undefined;
  for (const [re, lang] of SPECIAL_NAME_TO_LANG) if (re.test(name)) return lang;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return undefined;
  return EXT_TO_LANG[name.slice(dot + 1).toLowerCase()];
}
