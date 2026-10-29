/* ============================================================
 * FileTypeIcon — 文件类型真实 brand logo
 *
 *   SVG 资源放在 assets/icons/file-types/*.svg, 由
 *   `apps/desktop/scripts/fetch-file-type-icons.sh` 从 simple-icons (CC0)
 *   下载到本地 — Vite 构建期 inline 到 bundle, 运行时零网络请求.
 *
 *   渲染走 <img src={url}> + brand color 走 CSS filter? 不: simple-icons SVG 是单色
 *   (currentColor 兼容性), 但每个 brand 有自己 hex color, 我们直接挂 inline style
 *   `color: var` 在 wrapper, SVG 里 path 没 fill 属性会用 currentColor.
 *
 *   实际看 simple-icons 的 SVG: <path d="..."> 没 fill, 默认 black. 直接 mask 着色比
 *   import-as-string 简单 — 用 mask-image 把 SVG 当形状, background-color 控制色.
 *
 *   降级: 没匹配到 brand 时返回 generic 文件图标 (lucide File 自绘 SVG).
 * ============================================================ */

import React from 'react';

/* Vite eager glob — 拿 SVG **源码字符串**, 不是 URL.
 *   走 raw 是因为我们要 inline 渲染 + 注入 fill 颜色;
 *   走 url + mask-image 在 Electron 某些版本表现不稳, 会出现整 box 被填充. */
const ICON_RAW = import.meta.glob('../assets/icons/file-types/*.svg', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

function iconRawOf(brand: string): string | null {
  const key = Object.keys(ICON_RAW).find(p => p.endsWith(`/${brand}.svg`));
  return key ? ICON_RAW[key] : null;
}

/** 给 svg 注入 fill="<color>" — simple-icons path 默认没 fill (黑色), 注入后变彩色品牌 logo.
 *   并强制 width/height 跟外层 size 一致, 避免 SVG 自带 width 引起 layout 抖动. */
function colorizeSvg(raw: string, color: string, size: number): string {
  /* 1. <path 没 fill 属性 → 加上 fill="color" */
  let out = raw.replace(/<path(?![^>]*\sfill=)/g, `<path fill="${color}"`);
  /* 2. <svg ...> 内部强制 width/height — 避免 SVG 自带尺寸推高行 */
  out = out.replace(/<svg([^>]*)>/, (_m, attrs) => {
    const cleaned = attrs
      .replace(/\swidth="[^"]*"/g, '')
      .replace(/\sheight="[^"]*"/g, '');
    return `<svg${cleaned} width="${size}" height="${size}">`;
  });
  return out;
}

/* ============================================================
 * ext / 文件名 → brand id 映射
 *
 *   brand id 跟 assets/icons/file-types/<brand>.svg 一一对应,
 *   不存在 SVG 的 ext 走 fallback (返回 null brand).
 *
 *   color = simple-icons 官方 brand color (公开数据, 不构成商标使用问题).
 * ============================================================ */
interface BrandSpec { brand: string; color: string; }

const SPECIAL_FILES: Array<[RegExp, BrandSpec]> = [
  [/^dockerfile$|\.dockerfile$/i,                      { brand: 'docker',     color: '#2496ed' }],
  [/^docker-compose\.ya?ml$/i,                         { brand: 'docker',     color: '#2496ed' }],
  [/^(gnu)?makefile$/i,                                { brand: 'makefile',   color: '#a42e2b' }],
  [/^\.gitignore$|^\.gitattributes$|^\.gitmodules$/i,  { brand: 'git',        color: '#f05033' }],
  [/^package(-lock)?\.json$|^\.npmrc$|^\.npmignore$/i, { brand: 'npm',        color: '#cb3837' }],
  [/^yarn\.lock$|^\.yarnrc/i,                          { brand: 'yarn',       color: '#2c8ebb' }],
  [/^pnpm-lock\.yaml$|^\.pnpmfile/i,                   { brand: 'pnpm',       color: '#f9ad00' }],
  [/^\.eslintrc|^eslint\.config\./i,                   { brand: 'eslint',     color: '#4b32c3' }],
  [/^\.prettierrc/i,                                   { brand: 'prettier',   color: '#f7b93e' }],
  [/^tsconfig.*\.json$/i,                              { brand: 'typescript', color: '#3178c6' }],
  [/^vite\.config\.|^vitest\.config\./i,               { brand: 'vite',       color: '#646cff' }],
  [/^webpack\.config\./i,                              { brand: 'webpack',    color: '#8dd6f9' }],
];

const EXT_TO_BRAND: Record<string, BrandSpec> = {
  /* 编程语言 */
  ts:    { brand: 'typescript', color: '#3178c6' },
  tsx:   { brand: 'react',      color: '#61dafb' },
  mts:   { brand: 'typescript', color: '#3178c6' },
  cts:   { brand: 'typescript', color: '#3178c6' },
  js:    { brand: 'javascript', color: '#f7df1e' },
  jsx:   { brand: 'react',      color: '#61dafb' },
  mjs:   { brand: 'javascript', color: '#f7df1e' },
  cjs:   { brand: 'javascript', color: '#f7df1e' },
  py:    { brand: 'python',     color: '#3776ab' },
  pyw:   { brand: 'python',     color: '#3776ab' },
  pyi:   { brand: 'python',     color: '#3776ab' },
  rb:    { brand: 'ruby',       color: '#cc342d' },
  rake:  { brand: 'ruby',       color: '#cc342d' },
  php:   { brand: 'php',        color: '#777bb4' },
  java:  { brand: 'java',       color: '#ed8b00' },
  kt:    { brand: 'kotlin',     color: '#7f52ff' },
  kts:   { brand: 'kotlin',     color: '#7f52ff' },
  scala: { brand: 'scala',      color: '#dc322f' },
  sbt:   { brand: 'scala',      color: '#dc322f' },
  rs:    { brand: 'rust',       color: '#000000' },   /* 暗色背景下 generic gray 兜底, 用 CSS 反色 */
  go:    { brand: 'go',         color: '#00add8' },
  c:     { brand: 'c',          color: '#a8b9cc' },
  h:     { brand: 'c',          color: '#a8b9cc' },
  cpp:   { brand: 'cpp',        color: '#00599c' },
  cc:    { brand: 'cpp',        color: '#00599c' },
  cxx:   { brand: 'cpp',        color: '#00599c' },
  hpp:   { brand: 'cpp',        color: '#00599c' },
  hh:    { brand: 'cpp',        color: '#00599c' },
  cs:    { brand: 'csharp',     color: '#a179dc' },
  swift: { brand: 'swift',      color: '#f05138' },
  dart:  { brand: 'dart',       color: '#0175c2' },
  lua:   { brand: 'lua',        color: '#2c2d72' },
  r:     { brand: 'r',          color: '#276dc3' },
  pl:    { brand: 'perl',       color: '#39457e' },
  sh:    { brand: 'shell',      color: '#4eaa25' },
  bash:  { brand: 'shell',      color: '#4eaa25' },
  zsh:   { brand: 'shell',      color: '#4eaa25' },
  fish:  { brand: 'shell',      color: '#4eaa25' },

  /* Web */
  html:  { brand: 'html',       color: '#e34f26' },
  htm:   { brand: 'html',       color: '#e34f26' },
  css:   { brand: 'css',        color: '#1572b6' },
  scss:  { brand: 'sass',       color: '#cc6699' },
  sass:  { brand: 'sass',       color: '#cc6699' },
  less:  { brand: 'less',       color: '#1d365d' },
  vue:   { brand: 'vue',        color: '#4fc08d' },
  svelte:{ brand: 'svelte',     color: '#ff3e00' },
  astro: { brand: 'astro',      color: '#bc52ee' },

  /* 数据 / 配置 */
  json:  { brand: 'json',       color: '#cbcb41' },
  jsonc: { brand: 'json',       color: '#cbcb41' },
  json5: { brand: 'json',       color: '#cbcb41' },
  yml:   { brand: 'yaml',       color: '#cb171e' },
  yaml:  { brand: 'yaml',       color: '#cb171e' },
  toml:  { brand: 'toml',       color: '#9c4221' },
  xml:   { brand: 'xml',        color: '#0060ac' },
  graphql:{ brand: 'graphql',   color: '#e10098' },
  gql:   { brand: 'graphql',    color: '#e10098' },
  sql:   { brand: 'sql',        color: '#4479a1' },

  /* 文档 */
  md:    { brand: 'markdown',   color: '#9099a8' },   /* 黑色 mark 暗色下不显眼, 用中性灰 */
  mdx:   { brand: 'mdx',        color: '#1b1f24' },
  tex:   { brand: 'latex',      color: '#008080' },
  pdf:   { brand: 'pdf',        color: '#ec1c24' },
  doc:   { brand: 'word',       color: '#185abd' },
  docx:  { brand: 'word',       color: '#185abd' },
  xls:   { brand: 'excel',      color: '#107c41' },
  xlsx:  { brand: 'excel',      color: '#107c41' },
  csv:   { brand: 'excel',      color: '#107c41' },
  tsv:   { brand: 'excel',      color: '#107c41' },
  ppt:   { brand: 'powerpoint', color: '#c43e1c' },
  pptx:  { brand: 'powerpoint', color: '#c43e1c' },

  /* 媒体 */
  svg:   { brand: 'svg',        color: '#ffb13b' },
};

/* ============================================================
 * 通用 file 图标 — fallback. 中性灰描边 + 折角.
 * ============================================================ */
const GenericFileSvg: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9.5 1.5H3.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V5.5z" />
    <path d="M9.5 1.5V5.5h4" />
  </svg>
);

/* ============================================================
 * resolveFileBrand — path → BrandSpec | null
 * ============================================================ */
export function resolveFileBrand(filePath: string): BrandSpec | null {
  const base = filePath.split(/[/\\]/).pop()?.toLowerCase() || '';
  for (const [re, spec] of SPECIAL_FILES) {
    if (re.test(base)) return spec;
  }
  const lastDot = base.lastIndexOf('.');
  if (lastDot < 0) return null;
  const ext = base.slice(lastDot + 1);
  return EXT_TO_BRAND[ext] ?? null;
}

/* ============================================================
 * FileTypeIcon — 渲染组件
 *
 *   方案: 用 <img> 拉 SVG URL, 套一层 wrapper 控制大小. SVG 本身是 simple-icons
 *   单色形状, brand 色通过 CSS mask 的方式着色: 实际更简单 — simple-icons SVG
 *   path 默认 fill 黑, 我们用 mask-image 把 svg 当 mask, background-color 上 brand 色.
 *
 *   这样: 所有 icon 风格统一 (扁平 logo 形状), 颜色用各自 brand color, 暗色背景下也清晰.
 * ============================================================ */

interface FileTypeIconProps {
  path: string;
  size?: number;
  className?: string;
  variant?: 'logo' | 'disc';
}

/** 圆盘里显示的短标签 —— 优先用人认得的缩写, 其次退回扩展名前 3 位 */
const DISC_LABEL: Record<string, string> = {
  javascript: 'JS', typescript: 'TS', react: 'TSX', python: 'PY', markdown: 'MD',
  json: 'JSON', html: 'HTML', css: 'CSS', go: 'GO', rust: 'RS', java: 'JAVA',
  ruby: 'RB', php: 'PHP', shell: 'SH', yaml: 'YML', toml: 'TOML', sql: 'SQL',
  docker: 'DK', git: 'GIT', npm: 'NPM', vue: 'VUE', svelte: 'SV', swift: 'SW',
  kotlin: 'KT', c: 'C', cpp: 'C++', csharp: 'C#', dart: 'DART', lua: 'LUA',
  excel: 'X', word: 'W', powerpoint: 'P', pdf: 'PDF',
};

function discLabelOf(brand: string | null, filePath: string): string {
  if (brand && DISC_LABEL[brand]) return DISC_LABEL[brand];
  const ext = ((filePath.split(/[/\\?#]/).pop() || '').split('.').pop() || '').toLowerCase();
  if (/^(png|jpe?g|webp|gif|bmp|heic|avif)$/.test(ext)) return 'IMG';
  return (ext || '?').slice(0, 4).toUpperCase();
}

function discLabelForSize(full: string, size: number): string {
  if (size >= 24) return full;
  if (size >= 16) return full.length <= 3 ? full : full.slice(0, 1);
  return full.slice(0, 1);
}

function discFontSize(labelLen: number, size: number): number {
  const ratio = labelLen <= 1 ? 0.56 : labelLen === 2 ? 0.44 : labelLen === 3 ? 0.34 : 0.27;
  return Math.max(8, Math.round(size * ratio));
}

export function badgeInkOn(background: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(background.trim());
  if (!m) return '#fff';
  const hex = m[1];
  const srgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = srgb.map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  /* 对比度公式两边同时展开后, 比黑更亮/比白更暗的分界正好在 L ≈ 0.179 */
  return L > 0.179 ? '#000' : '#fff';
}

export const FileTypeIcon: React.FC<FileTypeIconProps> = ({ path, size = 14, className, variant = 'logo' }) => {
  const spec = resolveFileBrand(path);
  if (variant === 'disc') {
    const full = discLabelOf(spec?.brand ?? null, path);
    const label = discLabelForSize(full, size);
    const color = spec?.color ?? 'var(--neox-fg-hint, #9aa0a6)';
    const fs = discFontSize(label.length, size);
    return (
      <span
        className={className}
        aria-hidden="true"
        /* title 给**全称** —— 圆盘上截成一个字母, 悬停仍要能问出它是什么 */
        title={full}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: size,
          height: size,
          flexShrink: 0,
          borderRadius: '50%',
          background: color,
          color: badgeInkOn(color),
          fontSize: fs,
          fontWeight: 700,
          lineHeight: 1,
          letterSpacing: label.length > 2 ? '-.02em' : 0,
          fontFamily: 'var(--neox-font-sans, system-ui)',
          userSelect: 'none',
        }}
      >{label}</span>
    );
  }
  const raw = spec ? iconRawOf(spec.brand) : null;
  if (!spec || !raw) {
    return <FileTypeIcon path={path} size={size} className={className} variant="disc" />;
  }
  /* inline 渲染 — fill 直接写进 path, SVG 是单色 brand logo, 不再依赖 CSS mask */
  const colored = colorizeSvg(raw, spec.color, size);
  return (
    <span
      className={className}
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        flexShrink: 0,
        lineHeight: 0,
        borderRadius: '50%',
        overflow: 'hidden',
      }}
      dangerouslySetInnerHTML={{ __html: colored }}
    />
  );
};

export default FileTypeIcon;
