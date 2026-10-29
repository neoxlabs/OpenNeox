
import { useSyncExternalStore } from 'react';

const VSCODE_DARK_BG_FALLBACK = '#151515';
const VSCODE_DARK_FG = '#d4d4d4';
const VSCODE_LIGHT_BG = '#ffffff';
const VSCODE_LIGHT_FG = '#1e1e1e';
const VSCODE_LIGHT_GUTTER = '#ffffff';

/** 暗色编辑器底: 优先吃壳层画布色, 跟 timeline / Surface chrome 一片黑 */
function resolveDarkEditorBg(): string {
  if (typeof document === 'undefined') return VSCODE_DARK_BG_FALLBACK;
  /* getComputedStyle 单独判一次 —— document 存在不代表它也存在 (单测里的最小 stub、
   * 将来任何非浏览器宿主都是这种形态)。少这一句会直接 ReferenceError 打断整条取色路径。 */
  if (typeof getComputedStyle !== 'function') return VSCODE_DARK_BG_FALLBACK;
  const root = document.documentElement;
  const canvas = getComputedStyle(root).getPropertyValue('--neox-bg-canvas').trim();
  if (canvas && !canvas.includes('var(')) return canvas;
  return VSCODE_DARK_BG_FALLBACK;
}

/** 监听 data-theme + data-theme-preset, 任一变化触发 re-render. */
const themeSubscribe = (callback: () => void): (() => void) => {
  if (typeof document === 'undefined') return () => {};
  const root = document.documentElement;
  const obs = new MutationObserver(callback);
  obs.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-theme-preset', 'data-theme-pack'] });
  return () => obs.disconnect();
};
const themeGetSnapshot = (): string => {
  if (typeof document === 'undefined') return 'dark|';
  const root = document.documentElement;
  return `${root.getAttribute('data-theme') || ''}|${root.getAttribute('data-theme-preset') || ''}|${root.getAttribute('data-theme-pack') || ''}`;
};
const themeGetServerSnapshot = themeGetSnapshot;

/** 读 document 当前是不是暗色主题。factory / 无头 DiffEditor 默认必须跟壳层一致,
 *  不能硬默认 light —— Monaco theme 是进程全局的, 错一次会把已打开的 Surface
 *  标识符刷成 #1e1e1e 叠在 #1e1e1e 底上 (看不见), 关键词/注释仍有色。 */
export function resolveDocumentIsDark(): boolean {
  if (typeof document === 'undefined') return true;
  return document.documentElement.getAttribute('data-theme') !== 'light';
}

export function useNeoxEditorTheme(): { isDark: boolean; preset: string } {
  const sig = useSyncExternalStore(themeSubscribe, themeGetSnapshot, themeGetServerSnapshot);
  const [theme, preset, pack] = sig.split('|');
  return { isDark: theme !== 'light', preset: pack || preset };
}

/** 注册 / 刷新 'neox-light' / 'neox-dark', 返回 theme name.
 *  语法色 inherit VS Code base; 只改 editor chrome (bg/gutter/selection). */
export function defineNeoxEditorTheme(editorEngine: any, isDark: boolean): string {
  if (typeof window === 'undefined' || !editorEngine?.editor?.defineTheme) {
    return isDark ? 'vs-dark' : 'vs';
  }
  const bg = isDark ? resolveDarkEditorBg() : VSCODE_LIGHT_BG;
  const fg = isDark ? VSCODE_DARK_FG : VSCODE_LIGHT_FG;
  const gutter = isDark ? bg : VSCODE_LIGHT_GUTTER;
  const name = isDark ? 'neox-dark' : 'neox-light';
  try {
    editorEngine.editor.defineTheme(name, {
      base: isDark ? 'vs-dark' : 'vs',
      inherit: true,
      /* 故意不写 token '' foreground — 那会把所有语法色刷成壳层前景色 */
      rules: [],
      colors: {
        'editor.background': bg,
        'editor.foreground': fg,
        'editorGutter.background': gutter,
        'minimap.background': bg,
        'scrollbar.shadow': '#00000000',
        'editor.lineHighlightBackground': '#00000000',
        'editor.lineHighlightBorder': '#00000000',
        'editorLineNumber.foreground': isDark ? '#858585' : '#237893',
        'editorLineNumber.activeForeground': isDark ? '#c6c6c6' : '#0b216f',
        'editorWidget.background': isDark ? '#252526' : '#f3f3f3',
        'editorWidget.foreground': fg,
        'editorOverviewRuler.border': '#00000000',
        'editor.selectionBackground': isDark ? '#264f78' : '#add6ff',
        'editor.inactiveSelectionBackground': isDark ? '#3a3d41' : '#e5ebf1',
        'editorCursor.foreground': isDark ? '#aeafad' : '#000000',
        'scrollbarSlider.background': isDark ? '#79797966' : '#64646466',
        'scrollbarSlider.hoverBackground': isDark ? '#646464b3' : '#646464b3',
      },
    });
    return name;
  } catch {
    return isDark ? 'vs-dark' : 'vs';
  }
}
