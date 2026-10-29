/**
 * 从文件路径直接打开 Surface — 用户点 message 里的 inline code 路径时调.
 *
 * 跟 agent 调 open_surface 工具走**同一个** surfaceStore.ingestSurfaceEvent 入口,
 * 区别只是触发源是 UI 点击不是 LLM 工具.
 */

import { ingestSurfaceEvent, type SurfaceKind } from './surfaceStore';
import { isPseudoEllipsisPath, resolveWorkspacePath, splitPathAnchor } from '../utils/pathUtils';

const EXT_TO_KIND: Record<string, SurfaceKind> = {
  /* 文档 */
  md: 'doc', mdx: 'doc', markdown: 'doc',
  /* 图表 / 媒体 */
  mmd: 'diagram',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image',
  /* 视频也走 image 类, SurfacePanel 按扩展名换成 VideoSurfaceViewer (原生 <video>) */
  mp4: 'image', m4v: 'image', mov: 'image', webm: 'image',
  svg: 'code',
  /* 用户从 timeline / 文件 chip 点击 .html 时, 默认看源码而不是直接网页渲染。
   * 真正需要 HTML 预览时使用 inline HTML surface；文件源 .html/.htm 统一走 code。 */
  html: 'code', htm: 'code',
  pdf: 'pdf',
  /* S1 Phase 1: 表格 — 点击 .xlsx/.csv/.tsv 走 SheetSurfaceViewer (Univer 只读) */
  xlsx: 'sheet', xls: 'sheet', csv: 'sheet', tsv: 'sheet',
  /* P1: Word 文档 — mammoth → HTML 渲染 (DocxSurfaceViewer 只读) */
  docx: 'docx', doc: 'docx',
  pptx: 'pptx', ppt: 'pptx', pptm: 'pptx', pps: 'pptx', ppsx: 'pptx', ppsm: 'pptx',
  potx: 'pptx', potm: 'pptx', odp: 'pptx',
  /* 源代码 (Monaco read-only) — TS/JS/Python/Go/Rust/Java/...
   * 结构化文本(json/yaml/toml/xml) 也走 code, 跟其他源码并入同一个 "源码" surface 多 tab,
   * Monaco 自带 json 语言高亮. 不再单开 kind='json' 的占位 tab. */
  json: 'code', jsonc: 'code', json5: 'code',
  ts: 'code', tsx: 'code', mts: 'code', cts: 'code',
  js: 'code', jsx: 'code', mjs: 'code', cjs: 'code',
  py: 'code', pyw: 'code',
  java: 'code', kt: 'code', kts: 'code', scala: 'code',
  go: 'code', rs: 'code', rb: 'code', php: 'code',
  c: 'code', h: 'code', cpp: 'code', cc: 'code', cxx: 'code', hpp: 'code', hh: 'code',
  cs: 'code', swift: 'code', m: 'code', mm: 'code',
  sh: 'code', bash: 'code', zsh: 'code', fish: 'code',
  yml: 'code', yaml: 'code', toml: 'code',
  xml: 'code', vue: 'code', svelte: 'code',
  sql: 'code', graphql: 'code', gql: 'code',
  scss: 'code', sass: 'code', less: 'code', css: 'code',
  ini: 'code', env: 'code', conf: 'code',
  diff: 'code', patch: 'code',
  txt: 'code', log: 'code', text: 'code',
  gitignore: 'code', gitattributes: 'code', dockerignore: 'code', npmignore: 'code',
  editorconfig: 'code', prettierrc: 'code', eslintrc: 'code', babelrc: 'code',
  makefile: 'code', dockerfile: 'code',
};

/** 扩展名 —— 不做锚点处理, 只看路径本身 (给 splitPathAnchor 内部判定用) */
function rawExtOf(path: string): string {
  const base = path.split(/[/\\?]/).pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

function extOf(path: string): string {
  return rawExtOf(splitPathAnchor(path).path);
}

/** 判断字符串是否可以被 Surface 预览 — 给 cells/UserCell+AssistantTextCell 决定 inline 路径是否可点击 */
export function isPreviewablePath(text: string): boolean {
  if (!text || text.length > 256) return false;
  const trimmed = text.trim();
  if (/[\r\n\t]/.test(trimmed)) return false;
  const kindGuess = EXT_TO_KIND[extOf(trimmed)];
  const deliverable = kindGuess === 'docx' || kindGuess === 'pdf' || kindGuess === 'pptx' || kindGuess === 'sheet' || kindGuess === 'image' || kindGuess === 'doc';
  if (/\s/.test(trimmed)) {
    if (!deliverable || /^[-$>]|\s-{1,2}\w|[=|&;]/.test(trimmed) || trimmed.length > 160) return false;
  }
  if (/^https?:\/\//i.test(trimmed)) return false;
  /* agent 自己写的省略路径形如 "backend/.../dal/mysql/Foo.java" — fs.stat 必失败,
   * 拦在外面避免给用户红色错误体验. agent 应该写绝对/完整相对路径才能 clickable. */
  if (isPseudoEllipsisPath(trimmed)) return false;
  const hasSlash = /[/\\]/.test(trimmed);
  const ext = extOf(trimmed);
  if (!ext) return false;
  if (!(ext in EXT_TO_KIND)) return false;
  const base = trimmed.split(/[/\\]/).pop() ?? '';
  if (base.toLowerCase() === `.${ext}`) return false;
  /* 至少要含 / 或者文件名形如 "xxx.ext"(不允许纯文本 "test.ts" 这种被误识别) */
  if (!hasSlash) {
    /* 单文件名形态: 必须明确扩展名 + 文件名长度合理; 成品 (论文 / 课件名动辄五六十字) 放到 120 */
    return trimmed.length >= 4 && trimmed.length <= (deliverable ? 120 : 64);
  }
  return true;
}

export function resolveAbs(path: string, workspacePath?: string): string {
  return resolveWorkspacePath(path, workspacePath);
}


/** 用户点击路径 → 在右侧开 Surface(走 store 不走 LLM 工具).
 *  changedLines: 可选, turn_summary chip 点开时带上, Monaco decorations 用这些区间高亮.
 *  editHunks: 可选, 有 hunks 时 CodeSurfaceViewer 切到 Monaco DiffEditor 渲染老/新双栏 diff. */
export function openSurfaceFromPath(opts: {
  sessionId: string;
  path: string;
  workspacePath?: string;
  changedLines?: Array<{ start: number; end: number; kind: 'add' | 'del' | 'modify' }>;
  editHunks?: Array<{
    oldString?: string;
    newString?: string;
    startLine?: number;
    oldLineCount?: number;
    newLineCount?: number;
    oldCharCount?: number;
    newCharCount?: number;
    previewTruncated?: boolean;
    review?: 'pending' | 'accepted' | 'rejected';
  }>;
  fallbackContent?: string;
  /** Git History 等比对: 改前全文, 左右栏左 pane 直接用 (不走 editHunks 审阅). */
  diffOriginal?: string;
  /** E-03 持久化 hunk review state — caller (TimelineStep/TurnSummaryBar) 把对应 timelineEntry.id 传过来,
   *   SingleCodeView 在用户点 ✓/✗ 时通过这 id 调 updateTimelineEntryById 写回 entry.editHunks[i].review,
   *   下次重开 surface 时从 entry 还原 reviewMap. */
  entryId?: string;
  preferKind?: SurfaceKind;
  /** 打开后聚焦滚动到的行号 (1-based) — timeline 文件引用带行号时传. 仅 code kind 消费. */
  line?: number;
  /** Git History / 明确要比对时钉死默认视图 (如 side-by-side). */
  defaultDiffViewMode?: 'preview' | 'inline' | 'side-by-side' | 'render';
}): boolean {
  const {
    sessionId, path, workspacePath, changedLines, editHunks, entryId,
    fallbackContent, diffOriginal, line, preferKind, defaultDiffViewMode,
  } = opts;
  if (!sessionId || !path) return false;
  /* 行号锚点在这里就摘掉: 再往下传的每一步 (resolveAbs / stat / Monaco 取文件)
   * 都是按真实路径找文件的, 带着 `#L10` 一定 ENOENT。
   * 显式传进来的 line 优先于路径里写的 —— 调用方比字符串更知道自己要跳哪。 */
  const anchor = splitPathAnchor(path);
  const cleanPath = anchor.path;
  const focusLine = (typeof line === 'number' && line > 0) ? line : anchor.line;
  const ext = extOf(cleanPath);
  /* preferKind 只在扩展名本来就能打开时生效 —— 不认识的扩展仍然拒绝, 免得开出一个空 surface */
  const kind = EXT_TO_KIND[ext] ? (preferKind ?? EXT_TO_KIND[ext]) : undefined;
  if (!kind) return false;
  const abs = resolveAbs(cleanPath.trim(), workspacePath);
  const title = abs.split(/[/\\]/).filter(Boolean).pop() || cleanPath;

  /* 打开即预批准: 切窗口 workspace 后预览仍稳定, 用户不看到 access denied */
  try {
    const api = (window as any).neox;
    void api?.surfaceRememberAccess?.({
      path: abs,
      root: workspacePath,
      capability: 'read',
    });
  } catch {
    /* ignore — main 侧 knownProjectRoots 仍兜底 */
  }

  const hasMeta = (changedLines && changedLines.length > 0)
    || (editHunks && editHunks.length > 0)
    || fallbackContent
    || (typeof diffOriginal === 'string')
    || (typeof focusLine === 'number' && focusLine > 0)
    || workspacePath
    || defaultDiffViewMode;

  ingestSurfaceEvent(sessionId, {
    action: 'open',
    surface: {
      id: `sfc-click-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
      kind,
      source: { type: 'file', path: abs },
      title,
      pinned: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: hasMeta
        ? { changedLines, editHunks, entryId, fallbackContent, diffOriginal, line: focusLine, workspacePath, defaultDiffViewMode }
        : undefined,
    },
  }, { reveal: true });
  return true;
}
