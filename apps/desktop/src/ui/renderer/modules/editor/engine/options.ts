/**
 * NeoX Editor Engine options
 *
 * Business UI must not hand-roll Monaco gutter/diff options. Keep product
 * semantics here so IDE and Surface render the same NeoX editor.
 */

const MONO_BY_PLATFORM: Record<string, string> = {
  darwin: 'Menlo, Monaco, "Sarasa Mono SC", "PingFang SC", monospace',
  win32: '"Cascadia Mono", "Cascadia Code", "MesloLGS NF", "JetBrains Mono", Consolas, "Sarasa Mono SC", "Microsoft YaHei", monospace',
  linux: '"JetBrains Mono", "DejaVu Sans Mono", "Noto Sans Mono", "MesloLGS NF", "Sarasa Mono SC", monospace',
};

/** <html data-platform> 由 AppShell 写入; 拿不到就用 userAgent 兜底。 */
function detectPlatform(): string {
  try {
    const attr = document.documentElement.getAttribute('data-platform');
    if (attr && MONO_BY_PLATFORM[attr]) return attr;
    const ua = navigator.userAgent;
    if (/Mac OS X|Macintosh/.test(ua)) return 'darwin';
    if (/Windows/.test(ua)) return 'win32';
    if (/Linux/.test(ua)) return 'linux';
  } catch { /* SSR / 测试环境 */ }
  return 'darwin';
}

export const NEOX_EDITOR_FONT_FAMILY = MONO_BY_PLATFORM[detectPlatform()]!;

export interface NeoxEditorOptionsParams {
  isDiff?: boolean;
  minimap?: boolean;
  wordWrap?: 'on' | 'off';
  fontSize?: number;
  lineHeight?: number;
  readOnly?: boolean;
  paddingTop?: number;
  paddingBottom?: number;
  fontFamily?: string;
}

export function getNeoxCodeEditorOptions(params: NeoxEditorOptionsParams = {}): Record<string, any> {
  const readOnly = params.readOnly ?? true;
  return {
    readOnly,
    domReadOnly: readOnly,
    ...(readOnly
      ? { readOnlyMessage: { value: '这份是只读的（Agent 改动预览 / diff 审阅）— 想直接改，从左侧资源管理器打开这个文件' } }
      : {}),
    automaticLayout: true,
    scrollBeyondLastLine: false,
    minimap: { enabled: params.minimap ?? false, side: 'right', renderCharacters: false },
    /* Surface/IDE 默认对齐 Cursor 信息密度: 13 / ~20 (14/22 在右栏显得松、字偏大) */
    fontSize: params.fontSize ?? 13,
    fontFamily: params.fontFamily ?? NEOX_EDITOR_FONT_FAMILY,
    fontLigatures: false,
    fontWeight: '400',
    ...(params.lineHeight ? { lineHeight: params.lineHeight } : { lineHeight: 20 }),
    lineNumbers: 'on' as const,
    lineNumbersMinChars: 3,
    glyphMargin: false,
    folding: false,
    lineDecorationsWidth: params.isDiff ? 6 : 4,
    rulers: [],
    renderLineHighlight: 'none' as const,
    renderWhitespace: 'selection' as const,
    wordWrap: params.wordWrap ?? 'off',
    smoothScrolling: true,
    stickyScroll: { enabled: false },
    scrollbar: {
      vertical: 'auto',
      horizontal: 'auto',
      /* 6px 几乎点不中; IDE CodeEditor 用 8, Surface/Diff 抬到 10 方便拖横滑条 */
      verticalScrollbarSize: 10,
      horizontalScrollbarSize: 10,
      useShadows: false,
      alwaysConsumeMouseWheel: false,
    },
    padding: {
      top: params.paddingTop ?? 0,
      bottom: params.paddingBottom ?? 0,
    },
  };
}

export function getNeoxDiffEditorOptions(params: NeoxEditorOptionsParams = {}): Record<string, any> {
  return {
    ...getNeoxCodeEditorOptions({ ...params, isDiff: true, minimap: false, wordWrap: params.wordWrap ?? 'off' }),
    renderSideBySide: true,
    /* Monaco 默认低于 900px 会退化成 inline diff。Surface 右侧面板常低于这个宽度，
     * inline 模式会把一个替换块的 modified 侧铺成一大片绿色，用户会误以为
     * 未修改行也被标成新增。强制 side-by-side，让红/绿只属于左右两侧真实 diff 行。 */
    renderSideBySideInlineBreakpoint: 0,
    /* compactMode=true 会触发 Monaco smart inline diff：即使 renderSideBySide=true，
     * 窄 surface 仍可能退成单侧 inline，并把 replacement block 整片染绿。
     * NeoX diff 必须稳定保持经典 side-by-side，避免用户看到“全是绿色”。 */
    compactMode: false,
    ignoreTrimWhitespace: false,
    originalEditable: false,
    enableSplitViewResizing: true,
    useInlineViewWhenSpaceIsLimited: false,
    useTrueInlineDiffRendering: false,
    renderOverviewRuler: false,
    overviewRulerLanes: 0,
    overviewRulerBorder: false,
    renderIndicators: false,
    renderMarginRevertIcon: false,
    hideUnchangedRegions: {
      enabled: false,
    },
  };
}
