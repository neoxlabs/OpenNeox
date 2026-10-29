
import React from 'react';

const ICON_RAW = import.meta.glob('../assets/icons/file-types/*.svg', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

function iconRawOf(brand: string): string | null {
  const key = Object.keys(ICON_RAW).find((p) => p.endsWith(`/${brand}.svg`));
  return key ? ICON_RAW[key] : null;
}

/** 注入 fill + 强制尺寸 — 跟 FileTypeIcon 同一套处理 */
function colorizeSvg(raw: string, color: string, size: number): string {
  let out = raw.replace(/<path(?![^>]*\sfill=)/g, `<path fill="${color}"`);
  out = out.replace(/<svg([^>]*)>/, (_m, attrs) => {
    const cleaned = String(attrs).replace(/\swidth="[^"]*"/g, '').replace(/\sheight="[^"]*"/g, '');
    return `<svg${cleaned} width="${size}" height="${size}">`;
  });
  return out;
}

export interface ServiceBrandSpec {
  brand: string;
  /** simple-icons 官方 brand color (公开数据) */
  color: string;
  /** 暗色背景下几乎不可见的 mark (纯黑/极深) 需要换一个更亮的同色系值 */
  darkColor?: string;
  label: string;
}

/* kind → brand。这里的 key 是 ServicesSurfaceViewer 的 ConfigKind。 */
const KIND_BRAND: Record<string, ServiceBrandSpec> = {
  maven:            { brand: 'maven',   color: '#c71a36', label: 'Maven' },
  gradle:           { brand: 'gradle',  color: '#02303a', darkColor: '#54a3b5', label: 'Gradle' },
  npm:              { brand: 'npm',     color: '#cb3837', label: 'npm' },
  /* Bun 官方 mark 是奶油色 —— 浅底上几乎看不见, 浅色主题用它的深色描边色 */
  bun:              { brand: 'bun',     color: '#3b3129', darkColor: '#fbf0df', label: 'Bun' },
  deno:             { brand: 'deno',    color: '#000000', darkColor: '#9ca3af', label: 'Deno' },
  python:           { brand: 'python',  color: '#3776ab', darkColor: '#4b8bbe', label: 'Python' },
  go:               { brand: 'go',      color: '#00add8', label: 'Go' },
  cargo:            { brand: 'rust',    color: '#000000', darkColor: '#d1834c', label: 'Rust' },
  dotnet:           { brand: 'dotnet',  color: '#512bd4', darkColor: '#8b6fe8', label: '.NET' },
  flutter:          { brand: 'flutter', color: '#02569b', darkColor: '#42a5f5', label: 'Flutter' },
  make:             { brand: 'makefile', color: '#a42e2b', darkColor: '#c96360', label: 'Make' },
  'docker-compose': { brand: 'docker',  color: '#2496ed', label: 'Docker' },
  shell:            { brand: 'shell',   color: '#4eaa25', label: 'Shell' },
};

/* 命令里出现这些关键词就用对应 brand —— 比 kind 更贴近"这服务到底是什么".
 * 顺序有意义: 越具体的越靠前 (spring-boot 要在 maven/gradle 之前命中)。 */
const CMD_BRAND: Array<[RegExp, ServiceBrandSpec]> = [
  [/spring-boot|bootrun|bootRun/i, { brand: 'spring',  color: '#6db33f', label: 'Spring Boot' }],
  [/docker[\s-]?compose|docker\s+run/i, { brand: 'docker', color: '#2496ed', label: 'Docker' }],
  [/\bvite\b/i,      { brand: 'vite',    color: '#646cff', label: 'Vite' }],
  [/\bnext\b/i,      { brand: 'react',   color: '#61dafb', label: 'Next.js' }],
  [/\bpnpm\b/i,      { brand: 'pnpm',    color: '#f69220', label: 'pnpm' }],
  [/\byarn\b/i,      { brand: 'yarn',    color: '#2c8ebb', label: 'Yarn' }],
  [/\bbun\b/i,       { brand: 'bun',     color: '#3b3129', darkColor: '#fbf0df', label: 'Bun' }],
  [/\bdeno\b/i,      { brand: 'deno',    color: '#000000', darkColor: '#9ca3af', label: 'Deno' }],
  [/\bgradlew?\b/i,  { brand: 'gradle',  color: '#02303a', darkColor: '#54a3b5', label: 'Gradle' }],
  [/\bmvn\b|maven/i, { brand: 'maven',   color: '#c71a36', label: 'Maven' }],
  [/\bcargo\b/i,     { brand: 'rust',    color: '#000000', darkColor: '#d1834c', label: 'Rust' }],
  [/\bgo\s+run\b/i,  { brand: 'go',      color: '#00add8', label: 'Go' }],
  [/\bflutter\b/i,   { brand: 'flutter', color: '#02569b', darkColor: '#42a5f5', label: 'Flutter' }],
  [/\bdotnet\b/i,    { brand: 'dotnet',  color: '#512bd4', darkColor: '#8b6fe8', label: '.NET' }],
  [/python|uvicorn|gunicorn|flask|django/i, { brand: 'python', color: '#3776ab', darkColor: '#4b8bbe', label: 'Python' }],
  [/\bnpm\b/i,       { brand: 'npm',     color: '#cb3837', label: 'npm' }],
  [/\bnode\b/i,      { brand: 'nodejs',  color: '#5fa04e', label: 'Node.js' }],
  [/\bmake\b/i,      { brand: 'makefile', color: '#a42e2b', darkColor: '#c96360', label: 'Make' }],
];

/**
 * 解析服务该用哪个 brand mark。
 * 命令优先于 kind —— kind='shell' 但命令是 `docker compose up` 时, 鲸鱼比终端图标有用。
 */
export function resolveServiceBrand(kind?: string, command?: string): ServiceBrandSpec | null {
  const cmd = (command || '').trim();
  if (cmd) {
    for (const [re, spec] of CMD_BRAND) {
      if (re.test(cmd)) return spec;
    }
  }
  if (kind && KIND_BRAND[kind]) return KIND_BRAND[kind];
  return null;
}

const ShellPromptSvg: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2.5" y="4" width="19" height="16" rx="3" />
    <path d="m7 9.5 3 2.5-3 2.5" />
    <path d="M12.5 15h4.5" />
  </svg>
);

function isDarkTheme(): boolean {
  try { return document.documentElement.getAttribute('data-theme') === 'dark'; } catch { return false; }
}

/** 通用兜底 — 认不出技术栈时给一个中性的"服务方块", 不留空白 */
const GenericServiceSvg: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="7" rx="1.6" />
    <rect x="3" y="13" width="18" height="7" rx="1.6" />
    <line x1="6.5" y1="7.5" x2="6.6" y2="7.5" />
    <line x1="6.5" y1="16.5" x2="6.6" y2="16.5" />
  </svg>
);

export const ServiceKindIcon: React.FC<{
  kind?: string;
  command?: string;
  size?: number;
  className?: string;
  /** 暗色背景 — 纯黑系 mark 会换用 darkColor。不传 = 按当前主题 */
  dark?: boolean;
  /** 统一底座: 圆角方块里放 mark (六成大小)。列表/详情/新建都用它, 外轮廓一致。 */
  tile?: boolean;
}> = ({ kind, command, size = 18, className, dark, tile = false }) => {
  const spec = resolveServiceBrand(kind, command);
  const isDark = dark ?? isDarkTheme();
  const markSize = tile ? Math.round(size * 0.62) : size;
  const wrapStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: size,
    height: size,
    flexShrink: 0,
    lineHeight: 0,
    ...(tile ? {
      borderRadius: Math.round(size * 0.28),
      background: 'var(--neox-bg-elevated, #fff)',
      boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--neox-fg-primary) 10%, transparent)',
    } : null),
  };
  const cls = ['svc-kind-icon', tile ? 'svc-kind-icon--tile' : '', className].filter(Boolean).join(' ');

  if (!spec) {
    return (
      <span className={cls} style={wrapStyle} aria-hidden="true">
        <GenericServiceSvg size={markSize} color="var(--neox-fg-secondary)" />
      </span>
    );
  }
  const color = isDark && spec.darkColor ? spec.darkColor : spec.color;
  if (spec.brand === 'shell') {
    return (
      <span className={cls} style={wrapStyle} aria-hidden="true" title={spec.label}>
        <ShellPromptSvg size={markSize} color="var(--neox-fg-primary)" />
      </span>
    );
  }
  const raw = iconRawOf(spec.brand);
  if (!raw) {
    return (
      <span className={cls} style={wrapStyle} aria-hidden="true" title={spec.label}>
        <GenericServiceSvg size={markSize} color={color} />
      </span>
    );
  }
  return (
    <span
      className={cls}
      style={wrapStyle}
      title={spec.label}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: colorizeSvg(raw, color, markSize) }}
    />
  );
};

export default ServiceKindIcon;
