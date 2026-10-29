
type RGB = [number, number, number];

let mermaidPromise: Promise<any> | null = null;
let lastKey = '';

/** 让浏览器把 token (可能是 var / color-mix 链) 算成具体颜色, 再读出 rgb */
function resolveToken(name: string, fallback: string): RGB {
  const probe = document.createElement('span');
  probe.style.cssText = `position:absolute;visibility:hidden;color:var(${name}, ${fallback})`;
  document.body.appendChild(probe);
  const raw = getComputedStyle(probe).color;
  probe.remove();
  return parseColor(raw) ?? parseColor(fallback) ?? [128, 128, 128];
}

function parseColor(raw: string): RGB | null {
  const rgb = raw.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  /* color-mix 的计算值是 color(srgb r g b) —— 0..1 */
  const srgb = raw.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i);
  if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255];
  const hex = raw.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)) as RGB;
  return null;
}

/** base 上叠 t 比例的 over —— 半透明 token 在画布上的实际观感 */
function mix(base: RGB, over: RGB, t: number): string {
  const c = base.map((b, i) => Math.round(b + (over[i] - b) * t));
  return `#${c.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;
}

function themeVariables(isDark: boolean): Record<string, string | boolean> {
  const canvas = resolveToken('--neox-bg-canvas', isDark ? '#1c1c1e' : '#ffffff');
  const fg = resolveToken('--neox-fg-primary', isDark ? '#e5e5e1' : '#1d1d1f');
  const accent = resolveToken('--neox-primary-500', '#7c5cff');
  /* 图卡片底 = .md-mermaid 的 2.5% 底色 (markdown-message.css); 节点是卡片上的白块 (暗色下稍亮一档),
   * 跟 timeline 里「浅灰面板 + 白卡片」同一个层次。连线标签底必须等于图卡片底, 否则每个标签一块白补丁。 */
  const panel = mix(canvas, fg, 0.025);
  const node = mix(canvas, fg, isDark ? 0.08 : 0);
  const border = mix(canvas, fg, isDark ? 0.22 : 0.14);
  return {
    darkMode: isDark,
    fontFamily: getComputedStyle(document.body).fontFamily,
    fontSize: '13px',
    background: panel,
    primaryColor: node,
    primaryBorderColor: border,
    primaryTextColor: mix(canvas, fg, 1),
    secondaryColor: mix(canvas, accent, isDark ? 0.18 : 0.1),
    secondaryBorderColor: mix(canvas, accent, 0.4),
    secondaryTextColor: mix(canvas, fg, 1),
    tertiaryColor: mix(canvas, fg, 0.025),
    tertiaryBorderColor: border,
    tertiaryTextColor: mix(canvas, fg, 1),
    lineColor: mix(canvas, fg, 0.42),
    textColor: mix(canvas, fg, 0.85),
    mainBkg: node,
    nodeBorder: border,
    clusterBkg: mix(canvas, fg, 0.025),
    clusterBorder: border,
    edgeLabelBackground: panel,
    titleColor: mix(canvas, fg, 1),
    noteBkgColor: mix(canvas, accent, isDark ? 0.16 : 0.08),
    noteBorderColor: mix(canvas, accent, 0.35),
    noteTextColor: mix(canvas, fg, 1),
    actorBkg: node,
    actorBorder: border,
    actorTextColor: mix(canvas, fg, 1),
    signalColor: mix(canvas, fg, 0.6),
    signalTextColor: mix(canvas, fg, 0.85),
    labelBoxBkgColor: node,
    labelBoxBorderColor: border,
  };
}

/** 唯一入口: 拿一个已按当前主题 initialize 好的 mermaid */
export async function getNeoxMermaid(isDark: boolean): Promise<any> {
  if (!mermaidPromise) mermaidPromise = import('mermaid').then((m) => m.default);
  const mermaid = await mermaidPromise;
  const vars = themeVariables(isDark);
  const key = JSON.stringify(vars);
  if (key !== lastKey) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: vars,
      fontFamily: vars.fontFamily,
      flowchart: { curve: 'basis', padding: 14, nodeSpacing: 36, rankSpacing: 44 },
    });
    lastKey = key;
  }
  return mermaid;
}

export function normalizeMermaidSource(code: string): string {
  return code
    /* ① subgraph海外用户 → subgraph 海外用户 */
    .replace(/^(\s*)subgraph(?=[^\s\x00-\x7F])/gm, '$1subgraph ')
    /* ② subgraph 海外用户 → subgraph "海外用户" (仅当裸标题含非 ASCII 且没带方括号) */
    .replace(/^(\s*)subgraph[ \t]+(?!["'])([^\n\[]*[^\x00-\x7F][^\n\[]*)$/gm,
      (_m, indent: string, title: string) => `${indent}subgraph "${title.trim()}"`)
    /* ③ 节点标签里的反斜杠 / 断掉的形状语法 → 加引号包成矩形 (见上面说明) */
    .replace(/(\b[A-Za-z_][\w-]*)\[([^\[\]\n]+)\]/g, (m: string, id: string, inner: string) => {
      const t = inner.trim();
      if (t.startsWith('"')) return m;                       // 已带引号
      if (/^[\\/]/.test(t) && /[\\/]$/.test(t)) return m;    // A[\text\] / A[/text/] 等**故意**的形状
      const risky = inner.includes('\\') || /^\//.test(t);    // 反斜杠, 或开头就断的形状语法
      if (!risky) return m;
      return `${id}["${inner.replace(/"/g, '#quot;')}"]`;
    });
}
