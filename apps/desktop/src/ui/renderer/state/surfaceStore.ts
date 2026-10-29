/**
 * surfaceStore — 订阅 agent 工具 open_surface / update_surface / close_surface 的输出,
 * 维护 per-session 的右栏 Surface 列表 (跟 backgroundTasksStore 同款 useSyncExternalStore 模式).
 *
 * agent 调 open_surface 工具 → 工具返回包含 SURFACE_MARKER 的 JSON →
 * NeoxRuntimeBridge 的 stream subscription 解析 → 调 ingestSurfaceEvent →
 * SurfacePanel 读 store 渲染对应 viewer.
 *
 * 设计:
 *   - per-session 隔离: 切 session 不串
 *   - 上限 8 个: 防爆右栏 tab. 超过时挤掉最早的非 pinned
 *   - pinned 不被挤掉: 用户手动钉的永远保留, 直到主动关
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { getGlobalLanguage } from '../hooks/useI18n';
import { getAgentTurnEditForPath, getAgentTurnEdits } from './agentTurnEditsStore';
import { filePathKey, normalizePath } from '../utils/pathUtils';

export type SurfaceKind =
  | 'doc'
  | 'diagram'
  | 'image'
  | 'html'
  | 'svg'
  | 'web'
  | 'pdf'
  | 'code'     /* 源代码 (Monaco read-only, 按扩展名自动 syntax 高亮, 含 json/yaml/toml/xml) */
  | 'diff'
  | 'plan'
  | 'todo'
  | 'services' /* P1: 服务治理总控页 (master-detail, 内嵌多个 service 的 log tabs) */
  | 'sheet'    /* S1 Phase 1: 表格 (Univer 渲染 .xlsx / .csv / inline IWorkbookData, 只读) */
  | 'docx'     /* P1: Word 文档 (.docx — mammoth 转 HTML 渲染, 只读) */
  | 'pptx'
  | 'team'
  | 'files'
  | 'git'
  | 'terminal'
  | 'review'
  | 'plugin';

/** Plan section status — viewer 用 `<!-- status: ... -->` 注释识别 */
export type PlanSectionStatus = 'pending' | 'in_progress' | 'done';

/** Plan 增量 op — 跟 neox-core surfaceTypes.ts PlanOp 同步 */
export type PlanOp =
  | { kind: 'content'; content: string }
  | { kind: 'append'; text: string }
  | { kind: 'replace_section'; heading: string; content: string }
  | { kind: 'set_section_status'; heading: string; status: PlanSectionStatus }
  | { kind: 'add_note'; text: string };

export type TodoStatus = 'pending' | 'in_progress' | 'done' | 'skipped';
export interface TodoItem { id: string; text: string; status: TodoStatus; }
export interface TodoState { items: TodoItem[]; }

export type SurfaceSource =
  | { type: 'file'; path: string }
  | { type: 'inline'; content: string }
  | { type: 'url'; url: string };

export interface Surface {
  id: string;
  kind: SurfaceKind;
  source: SurfaceSource;
  title: string;
  pinned: boolean;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/** agent 建 tab 后轨道角标亮多久 */
const AGENT_LIVE_MS = 15_000;

/** 这条 surface 正在生成 / 刚被 agent 打开 — 轨道打运行中角标, 不自动展开右栏. */
export function isSurfaceLive(s: Surface, now = Date.now()): boolean {
  const meta = s.metadata as Record<string, unknown> | undefined;
  if (meta?.__streaming === true) return true;
  const liveAt = meta?.__agentLive;
  return typeof liveAt === 'number' && now - liveAt < AGENT_LIVE_MS;
}

/** SURFACE marker — 必须跟 neox-core/tools/surface/surfaceTypes.ts 同步 */
const SURFACE_MARKER = '__neox_surface_event__';

interface SurfaceEventPayload {
  action: 'open' | 'update' | 'close' | 'plan_op' | 'todo_replace';
  surface?: Surface;
  surfaceId?: string;
  patch?: Partial<Surface>;
  planOp?: PlanOp;
  todoItems?: TodoItem[];
  ensureSurface?: { kind: SurfaceKind; title?: string; pinned?: boolean };
  /** 用户在界面上手动开的 (+ 菜单), 不是 agent 推的 —— terminal 这类只认这条路 */
  byUser?: boolean;
}

const surfacesBySession = new Map<string, Map<string, Surface>>();


type SurfaceMergeMode =
  /** 一个会话一份, 与 source 无关 —— 再开就是激活已有那份 (服务 / Team / 文件 / Git / 待办) */
  | { mode: 'singleton'; adoptTitle?: boolean; adoptSource?: boolean }
  /** 一个会话一个 host surface, 内容挂进 host.metadata.tabs (viewer 必须消费 tabs 才能选这个) */
  | { mode: 'host-tabs'; hostTitle: string; identity: 'source' | 'tab-id' }
  /** 顶层独立 tab, 但**同一个文件只有一份** —— 同 path 再开 = 激活已有那个 */
  | { mode: 'per-source' }
  /** 每次 open 都是真·新的一份 (内容各不相同, 也没有稳定 path 可比) */
  | { mode: 'always-new' };

export type SurfaceMergePolicy = SurfaceMergeMode & {
  persistent?: boolean;
};

export const AGENT_REVEAL_KINDS: ReadonlySet<string> = new Set([
  'pptx', 'docx', 'pdf', 'sheet', 'image', 'doc', 'diagram', 'html', 'svg',
]);

export const SURFACE_MERGE_POLICY: Record<SurfaceKind, SurfaceMergePolicy> = {
  /* 这几类的 viewer 目前都是"一个 surface 渲一个文件"(DocSurfaceViewer / DiagramSurfaceViewer /
   * ImageSurfaceViewer / HtmlSurfaceViewer / DiffSurfaceViewer 都不消费 metadata.tabs),
   * 所以走 per-source: 顶层各占一个 tab, 但同一个文件永远只有一个。 */
  doc: { mode: 'per-source' },
  diagram: { mode: 'per-source' },
  image: { mode: 'per-source' },
  html: { mode: 'per-source' },
  svg: { mode: 'per-source' },
  /* diff 不自动展: agent 改一次文件就来一份, 一轮能来十几份 —— 那是过程不是成品。 */
  diff: { mode: 'per-source' },
  /* host + 内部 tab 条 —— 这几个 viewer 已经实现了 tabs */
  code: { mode: 'host-tabs', hostTitle: '源码', identity: 'source' },
  /* 一屏审阅: 一个会话一份, 再开就是同一个 */
  review: { mode: 'singleton', adoptSource: true },
  sheet: { mode: 'host-tabs', hostTitle: '表格', identity: 'source' },
  pdf: { mode: 'host-tabs', hostTitle: 'PDF', identity: 'source' },
  docx: { mode: 'host-tabs', hostTitle: 'Word', identity: 'source' },
  pptx: { mode: 'host-tabs', hostTitle: 'PPT', identity: 'source' },
  /* web 故意按 tab.id 而不是 URL 认身份: 一个 tab 背后是一个真实 BrowserView,
   * 同一个 URL 开两个标签页是浏览器的正常语义, 不能合并掉。 */
  web: { mode: 'host-tabs', hostTitle: '浏览器', identity: 'tab-id', persistent: true },
  /* 工作区级的工具窗口 —— 天然只有一份, 开出两个一模一样的没有任何意义 */
  services: { mode: 'singleton', persistent: true },
  files: { mode: 'singleton', persistent: true },
  git: { mode: 'singleton', persistent: true },
  team: { mode: 'singleton', adoptTitle: true },
  /* 待办: 模型每轮换个 surface_id 就多长一个「待办清单」tab (todo_replace 里那段
   * ensureSurface 兜底就是为此写的) —— 单实例 + 吃下新内容才是正解。 */
  todo: { mode: 'singleton', adoptTitle: true, adoptSource: true },
  /* 计划: 两份 plan 的内容真的不一样, 合并 = 丢内容, 只能各占一个 tab。 */
  plan: { mode: 'always-new' },
  terminal: { mode: 'singleton', persistent: true },
  /* 插件面板: 每个面板一份 (身份 = 它的 neox-plugin:// 地址, 见 sourceIdentity), 跟 files/git 一样是工作区常驻工具窗 */
  plugin: { mode: 'per-source', persistent: true },
};

/** 这个 kind 是不是"工作区常驻" —— 唯一真相是上面那张表的 persistent 字段。 */
export function isPersistentSurfaceKind(kind: SurfaceKind | string): boolean {
  return SURFACE_MERGE_POLICY[kind as SurfaceKind]?.persistent === true;
}

/** 这个 kind 的 surface 内部自带 tab 条吗 (host-tabs 策略) —— SurfacePanel 靠它决定要不要渲染 chrome bar。
 *  同样从表派生: 新增一个 host-tabs kind 时不用再记得去 SurfacePanel 补名单。 */
export function surfaceHasInternalTabs(kind: SurfaceKind | string): boolean {
  return SURFACE_MERGE_POLICY[kind as SurfaceKind]?.mode === 'host-tabs';
}

/** 内部别名 (历史调用点很多, 保留短名) */
const isPersistentKind = isPersistentSurfaceKind;

/**
 * surface 的"身份" —— per-source / host-tabs 策略靠它判断"是不是同一个东西"。
 *
 * 路径判等一律走 pathUtils.filePathKey (= 全仓唯一那份 canonicalWorkspacePath):
 * Windows 折大小写 + 盘符 / UNC / 重复斜杠 / `.` `..` 全部归一。
 * 别在这里手写路径比较 —— `C:\W\A.md` / `c:/w/a.md` / `/w/内部设计文档`
 * 这类写法差异在 mac 上基本碰不到, 到 Windows 上就是"同一个文件开出好几个 tab"。
 *
 * 只有文件源有稳定身份; inline / url 每次都是新的一份, 返回 null。
 */
/* 以下几个导出仅为可测 (见 __tests__/surfaceStore.identity.test.ts)。
 * 它们是「同一文件开出多个 tab」和「别名丢失导致 update 静默消失」这两类事故的判定点。 */
export function sourceIdentity(surface: Surface): string | null {
  /* 插件面板的地址是稳定的 (同一插件同一入口永远同一个), 拿它当身份 —— 否则再点一次就多一个 tab */
  if (surface.kind === 'plugin' && surface.source?.type === 'url') return `plugin:${surface.source.url}`;
  if (surface.source?.type !== 'file') return null;
  return filePathKey(surface.source.path ?? '') || null;
}

/** source 里真的有内容吗 —— singleton 的 adoptSource 用它挡住空占位覆盖已有内容 */
export function hasMeaningfulSource(surface: Surface): boolean {
  const src = surface.source;
  if (!src) return false;
  if (src.type === 'inline') return String(src.content ?? '').trim().length > 0;
  return true;
}

/**
 * open 时被合并掉的 surface id → 真正承载它的那个 surface id。
 *
 * 合并是对的, 但模型 / UI 后面还会拿着**它自己给的那个 id** 发 update / plan_op /
 * todo_replace / close。没有这张别名表, 那些事件会 `map.get()` 落空后静默丢失 ——
 * 工具早就把"成功"回给模型了, 用户却什么都没看到, 这是最坏的一类 bug。
 * (todo_replace 里那段 ensureSurface 兜底就是这个问题的局部补丁, 现在由别名表统一解决。)
 */
const surfaceIdAliasBySession = new Map<string, Map<string, string>>();

export function aliasSurfaceId(sessionId: string, fromId: string, toId: string): void {
  if (!fromId || !toId || fromId === toId) return;
  let m = surfaceIdAliasBySession.get(sessionId);
  if (!m) { m = new Map(); surfaceIdAliasBySession.set(sessionId, m); }
  /* 压平别名链: 已经指向 fromId 的一并改指 toId, 查表永远只走一跳 */
  for (const [k, v] of m) if (v === fromId) m.set(k, toId);
  m.set(fromId, toId);
}

export function resolveSurfaceId(sessionId: string, surfaceId: string): string {
  return surfaceIdAliasBySession.get(sessionId)?.get(surfaceId) ?? surfaceId;
}

/** surface 真的被关掉时, 指向它的别名也要一起清, 否则别名表只涨不落 */
export function dropAliasesTo(sessionId: string, surfaceId: string): void {
  const m = surfaceIdAliasBySession.get(sessionId);
  if (!m) return;
  for (const [k, v] of m) if (v === surfaceId || k === surfaceId) m.delete(k);
  if (m.size === 0) surfaceIdAliasBySession.delete(sessionId);
}

const listeners = new Set<() => void>();
const cachedArrayBySession = new Map<string, Surface[]>();
/** 当前活跃 tab — per session, key = sessionId, value = surfaceId(undefined 表示无 active) */
const activeBySession = new Map<string, string | undefined>();
/** Streaming surface 映射: toolCallId → tempSurfaceId. open_surface 还在 stream args 时建临时 surface, 真 surface 一到就 dispose. */
const streamingByToolCall = new Map<string, string>();
/** 已经从 localStorage 恢复过的 session id 集合 — 第一次 useSurfaces 时 lazy 加载, 之后不重复. */
const restoredSessions = new Set<string>();

let persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
const PERSIST_DEBOUNCE_MS = 250;
/** P1-18: per-session inflight persist chain — 防快速 reorder 时多个 persistNow 并发 IPC,
 *  main 端写入完成顺序可能错乱 (旧数据后落覆盖新数据). 走链式串行: 当前 inflight 完成后才
 *  跑下一次, 同一 session 永远只一个 IPC 在飞. */
const persistInflight = new Map<string, Promise<void>>();

function schedulePersist(sessionId: string): void {
  if (!sessionId) return;
  const existing = persistTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  persistTimers.set(sessionId, setTimeout(() => {
    void persistNow(sessionId);
    persistTimers.delete(sessionId);
  }, PERSIST_DEBOUNCE_MS));
}

async function persistNow(sessionId: string): Promise<void> {
  /* P1-18: 链式串行 — 等当前 inflight 完成再跑新一次, 保证 main 端顺序写入. */
  const prev = persistInflight.get(sessionId);
  if (prev) {
    /* 排队等前一次完成. await prev 不抛 (内部已 catch). */
    await prev.catch(() => {});
  }
  const task = doPersistOnce(sessionId);
  persistInflight.set(sessionId, task);
  try {
    await task;
  } finally {
    /* 只 delete 自己, 不删后面排队那个 (可能已被新的 setMap 替换). */
    if (persistInflight.get(sessionId) === task) {
      persistInflight.delete(sessionId);
    }
  }
}

async function doPersistOnce(sessionId: string): Promise<void> {
  try {
    const api = (window as any).neox;
    if (!api?.uiStateSetSurfaces) return;
    const map = surfacesBySession.get(sessionId);
    if (!map || map.size === 0) {
      await api.uiStateSetSurfaces(sessionId, null);
      return;
    }
    const surfaces = Array.from(map.values()).filter(s => {
      const meta = (s.metadata as any) ?? {};
      return !meta.__streaming;
    });
    if (surfaces.length === 0) {
      await api.uiStateSetSurfaces(sessionId, null);
      return;
    }
    await api.uiStateSetSurfaces(sessionId, {
      surfaces,
      activeId: activeBySession.get(sessionId),
    });
  } catch (err) {
    console.warn('[surfaceStore] persist failed:', err);
  }
}

async function restoreFromStorage(sessionId: string): Promise<void> {
  if (!sessionId) return;
  if (restoredSessions.has(sessionId)) return;
  restoredSessions.add(sessionId);
  try {
    const api = (window as any).neox;
    if (!api?.uiStateGetSurfaces) return;
    const r = await api.uiStateGetSurfaces(sessionId);
    if (!r?.success || !r.state) return;
    const { surfaces, activeId } = r.state;
    if (!Array.isArray(surfaces)) return;
    let map = surfacesBySession.get(sessionId);
    if (!map) { map = new Map(); surfacesBySession.set(sessionId, map); }
    let touched = false;
    for (const s of surfaces) {
      if (!s?.id) continue;
      if (map.has(s.id)) continue;
      if (s.kind === 'code'
          && (s as Surface).source?.type === 'inline'
          && !String(((s as Surface).source as { content?: string })?.content ?? '').trim()) {
        continue;
      }
      const restoredSurface = normalizeIncomingSurface(s as Surface);
      const policy: SurfaceMergePolicy = SURFACE_MERGE_POLICY[restoredSurface.kind] ?? { mode: 'per-source' };
      if (policy.mode === 'singleton' || policy.mode === 'host-tabs') {
        if (Array.from(map.values()).some(x => x.kind === restoredSurface.kind)) continue;
      } else if (policy.mode === 'per-source') {
        const key = sourceIdentity(restoredSurface);
        if (key && Array.from(map.values()).some(x => x.kind === restoredSurface.kind && sourceIdentity(x) === key)) {
          continue;
        }
      }
      map.set(restoredSurface.id, restoredSurface);
      touched = true;
    }
    if (activeId && !activeBySession.get(sessionId)) {
      /* 上面可能刚把 activeId 指着的那份当重复丢掉了 —— 直接存回去就是个死指针,
       * 面板会渲染成一片空白。认不到就退到还活着的第一个。 */
      const liveActive = map.has(activeId) ? activeId : Array.from(map.keys())[0];
      if (liveActive) {
        activeBySession.set(sessionId, liveActive);
        touched = true;
      }
    }
    if (touched) {
      rebuildCache(sessionId);
      emit();
    }
  } catch (err) {
    console.warn('[surfaceStore] restore failed:', err);
  }
}

function emit(): void {
  for (const fn of listeners) {
    try { fn(); } catch (err) { console.error('[surfaceStore]', err); }
  }
  /* emit 后所有"已被监听过的 session"都 schedule 一次 persist.
   * 这里偷懒: 遍历 surfacesBySession 所有 key 都 schedule. */
  for (const sessionId of surfacesBySession.keys()) {
    schedulePersist(sessionId);
  }
}

function requestSurfacePanelOpen(sessionId: string, surface: Surface): void {
  if (typeof window === 'undefined') return;
  const source =
    surface.source.type === 'file' ? surface.source.path :
    surface.source.type === 'url' ? surface.source.url :
    undefined;
  window.dispatchEvent(new CustomEvent('neox:surface-panel-open-requested', {
    detail: { sessionId, surfaceId: surface.id, kind: surface.kind, source },
  }));
}

function surfaceFileExt(surface: Surface): string {
  if (surface.source.type !== 'file') return '';
  const base = surface.source.path.split(/[/\\?#]/).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** 按路径后缀判断该用哪个 viewer。文件管理器的就地预览要用 —— 它不进 store,
 *  所以拿不到 ingest 时那套归一化, 需要一个纯函数版本。默认 code (Monaco 按后缀高亮)。 */
export function surfaceKindForPath(path: string): SurfaceKind {
  /* 只取 basename 的扩展名 —— 整串 split('.') 在 `e:\foo.bar\a.json` 上仍对,
   * 但 `C:\dir.with.dots\Makefile` 会误判; 统一走 basename 更稳. */
  const base = path.split(/[/\\?#]/).pop() || '';
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
  return (ext && FILE_EXT_SURFACE_KIND[ext]) || 'code';
}

const FILE_EXT_SURFACE_KIND: Record<string, SurfaceKind> = {
  pdf: 'pdf',
  docx: 'docx',
  doc: 'docx',
  pptx: 'pptx',
  ppt: 'pptx',
  pptm: 'pptx',
  pps: 'pptx',
  ppsx: 'pptx',
  ppsm: 'pptx',
  potx: 'pptx',
  potm: 'pptx',
  odp: 'pptx',
  xlsx: 'sheet',
  xls: 'sheet',
  csv: 'sheet',
  tsv: 'sheet',
  /* 视频 → image 类, SurfacePanel 换成 VideoSurfaceViewer */
  mp4: 'image',
  m4v: 'image',
  mov: 'image',
  webm: 'image',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
};

/** 已下线 kind — 无 viewer, 禁止 ingest 成空页. chart→diagram 可救则 remap. */
const UNSUPPORTED_SURFACE_KINDS = new Set(['chart']);
/** 只允许用户手动开、不接受 agent 推送的 kind (见 SurfaceKind 上 terminal 的说明) */
const USER_ONLY_SURFACE_KINDS = new Set(['terminal', /* 插件面板跑插件自己的脚本, 只由用户在右栏点开 */ 'plugin']);

function normalizeSurfaceSourcePath(surface: Surface): Surface {
  if (surface.source?.type !== 'file') return surface;
  const raw = surface.source.path;
  if (!raw) return surface;
  const normalized = normalizePath(raw);
  if (!normalized || normalized === raw) return surface;
  return { ...surface, source: { ...surface.source, path: normalized } };
}

function normalizeIncomingSurface(incoming: Surface): Surface {
  const surface = normalizeSurfaceSourcePath(incoming);
  /* 旧会话 / 过期 tool 结果可能仍带 terminal|chart. chart 有 mermaid 内容时降级 diagram. */
  const rawKind = String(surface.kind);
  if (rawKind === 'chart') {
    const inline = surface.source?.type === 'inline' ? String(surface.source.content || '') : '';
    if (inline.trim()) {
      return {
        ...surface,
        kind: 'diagram',
        metadata: { ...(surface.metadata ?? {}), normalizedFromKind: 'chart' },
      };
    }
  }

  /* Agent/tool 调 open_surface 时 kind 偶尔会给成 code/doc, 但文件本身是
   * .docx/.pdf/.xlsx 这类二进制容器。必须按后缀纠正到专用 viewer,
   * 否则源码/Markdown viewer 会把 ZIP/PDF bytes 当文本显示成 `PK...`。 */
  if (surface.source?.type === 'url' && /^file:\/\//i.test(String(surface.source.url))
      && /\.(mp4|m4v|mov|webm)$/i.test(String(surface.source.url).split(/[?#]/)[0]!)) {
    let p = String(surface.source.url);
    try { p = decodeURIComponent(new URL(p).pathname); } catch { /* 原样 */ }
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1); /* Windows file:///C:/… */
    return {
      ...surface,
      kind: 'image',
      source: { type: 'file', path: normalizePath(p) || p },
      metadata: { ...(surface.metadata ?? {}), normalizedFromKind: surface.kind },
    };
  }

  const ext = surfaceFileExt(surface);
  const kindFromExt = ext ? FILE_EXT_SURFACE_KIND[ext] : undefined;
  if (kindFromExt && surface.kind !== kindFromExt) {
    return {
      ...surface,
      kind: kindFromExt,
      metadata: {
        ...(surface.metadata ?? {}),
        normalizedFromKind: surface.kind,
        normalizedByExt: ext,
      },
    };
  }

  /* Agent open_surface({kind:'html'}) → 归一成 code surface.
   * 纯交付 (无待审 edit) 默认「渲染」; 有待审 hunk 时由 ingest / syncTurnEdits 改成「源码」低幅.
   * 用户点 timeline/file chip 走 openSurfaceFromPath (kind 已是 code), 不进此分支, 仍默认源码. */
  if (surface.kind === 'html' && (ext === 'html' || ext === 'htm' || !ext)) {
    return {
      ...surface,
      kind: 'code',
      metadata: {
        ...(surface.metadata ?? {}),
        normalizedFromKind: 'html',
        defaultDiffViewMode: 'render',
      },
    };
  }
  return surface;
}

function hasPendingReviewHunks(hunks: any[] | undefined): boolean {
  if (!hunks?.length) return false;
  return hunks.some((h) =>
    (h?.review ?? 'pending') === 'pending'
    && typeof h?.oldString === 'string'
    && h.oldString.length > 0
    && !h.previewTruncated,
  );
}

/** 自动 open_surface 常不带 editHunks; 从本轮 turn edits 补齐, 并在有待审时切到源码低幅. */
function enrichCodeTabFromTurnEdits(
  sessionId: string,
  tabPath: string,
  tab: {
    changedLines?: any;
    editHunks?: any;
    entryId?: string;
    defaultDiffViewMode?: string;
  },
): typeof tab {
  let editHunks = tab.editHunks;
  let changedLines = tab.changedLines;
  let entryId = tab.entryId;
  let defaultDiffViewMode = tab.defaultDiffViewMode;

  if (!editHunks?.length && tabPath && !tabPath.startsWith('inline-')) {
    const fromStore = getAgentTurnEditForPath(sessionId, tabPath);
    if (fromStore?.editHunks?.length) {
      editHunks = fromStore.editHunks;
      changedLines = changedLines ?? fromStore.changedLines;
      entryId = entryId ?? fromStore.editHunks[0]?.__sourceEntryId;
    }
  }

  if (hasPendingReviewHunks(editHunks) && defaultDiffViewMode === 'render') {
    defaultDiffViewMode = 'inline';
  }

  if (
    editHunks === tab.editHunks
    && changedLines === tab.changedLines
    && entryId === tab.entryId
    && defaultDiffViewMode === tab.defaultDiffViewMode
  ) {
    return tab;
  }
  return { ...tab, editHunks, changedLines, entryId, defaultDiffViewMode };
}

/* ────────────────────────────── host-tabs 策略实现 ──────────────────────────────
 * 一个会话一个 host surface (id 恒为 `<kind>-host-<sessionId>`), 文件/页面挂进
 * host.metadata.tabs。identity='source' 按文件路径认身份 (同一个文件只会有一个 tab),
 * identity='tab-id' 按 tab.id 认身份 (web: 同 URL 允许多个标签页)。
 * ──────────────────────────────────────────────────────────────────────────── */

/** code tab 独有的附加字段 —— diff / 高亮 / 聚焦行, 从 metadata 抽出来挂到 tab 上 */
function readCodeTabMeta(newSurface: Surface): {
  changedLines?: any[];
  editHunks?: any[];
  fallbackContent?: string;
  diffOriginal?: string;
  entryId?: string;
  focusLine?: number;
  defaultDiffViewMode?: string;
} {
  const meta = (newSurface.metadata ?? {}) as any;
  const rawFocusLine = (meta.line ?? meta.focusLine) as number | undefined;
  return {
    changedLines: meta.changedLines as any[] | undefined,
    editHunks: meta.editHunks as any[] | undefined,
    fallbackContent: meta.fallbackContent as string | undefined,
    diffOriginal: typeof meta.diffOriginal === 'string' ? meta.diffOriginal : undefined,
    /* E-03: entryId — timeline entry 来源, SingleCodeView 用它写回 hunk.review 持久化 */
    entryId: meta.entryId as string | undefined,
    focusLine: typeof rawFocusLine === 'number' && rawFocusLine > 0 ? Math.floor(rawFocusLine) : undefined,
    /* 默认视图模式挂 tab 不挂 host —— agent html stamp 的 'render' 不能污染同 host 的其它 tab */
    defaultDiffViewMode: meta.defaultDiffViewMode as string | undefined,
  };
}

function buildCodeTabExtras(sessionId: string, newSurface: Surface, incomingPath: string): Record<string, any> {
  const m = readCodeTabMeta(newSurface);
  return {
    fallbackContent: m.fallbackContent,
    diffOriginal: m.diffOriginal,
    focusLine: m.focusLine,
    /* focusNonce 每次点击都变: 同一行重复点击也能重新触发 reveal (viewer 的 effect dep) */
    focusNonce: m.focusLine != null ? Date.now() : undefined,
    /* agent 自动 open 常缺 hunk / 误 stamp render → 对齐手动 Review 的低幅源码 */
    ...enrichCodeTabFromTurnEdits(sessionId, incomingPath, {
      changedLines: m.changedLines,
      editHunks: m.editHunks,
      entryId: m.entryId,
      defaultDiffViewMode: m.defaultDiffViewMode,
    }),
  };
}

/** 同一个文件被再次打开 —— 激活已有 tab, 但 changedLines 等要刷成最新的
 *  (用户上一轮看过这文件, 这轮又改了, 高亮区间不一样)。 */
function mergeCodeTab(sessionId: string, tab: any, newSurface: Surface, incomingPath: string): any {
  const m = readCodeTabMeta(newSurface);
  const merged = {
    ...tab,
    changedLines: m.changedLines ?? tab.changedLines,
    editHunks: m.editHunks ?? tab.editHunks,
    fallbackContent: m.fallbackContent ?? tab.fallbackContent,
    diffOriginal: m.diffOriginal ?? tab.diffOriginal,
    /* entryId 用新的 (用户点击重新打开总是带最新 timelineEntry.id), 否则保留旧的 */
    entryId: m.entryId ?? tab.entryId,
    /* 带行号重开已有 tab → 更新聚焦行 + 新 nonce 重新触发滚动 */
    focusLine: m.focusLine ?? tab.focusLine,
    focusNonce: m.focusLine != null ? Date.now() : tab.focusNonce,
    /* 每次 open 刷新默认模式: agent html→render, chip→undefined(源码) */
    defaultDiffViewMode: m.defaultDiffViewMode,
  };
  return { ...merged, ...enrichCodeTabFromTurnEdits(sessionId, incomingPath, merged) };
}

/** 空白页 —— about:blank / 空串 / 只有空白字符都算。
 *  单独抽出来是因为"什么算空白"必须只有一个口径: 判重用一份、UI 文案用另一份的话,
 *  迟早出现"列表里两条空白, 卡片说只有一条"。 */
export function isBlankTabUrl(url: unknown): boolean {
  const s = String(url ?? '').trim().toLowerCase();
  return s === '' || s === 'about:blank';
}

function openIntoHostTabs(
  sessionId: string,
  map: Map<string, Surface>,
  newSurface: Surface,
  policy: Extract<SurfaceMergePolicy, { mode: 'host-tabs' }>,
): void {
  const kind = newSurface.kind;
  const byTabId = policy.identity === 'tab-id';
  const isCode = kind === 'code';

  /* "home 请求": inline + content === '' 是 openKindHome 发的引导请求 —— 不挂占位 tab,
   *   host tabs 保持空, viewer 看到空 tabs 就渲染 KindHomeView。web 没有引导页。 */
  const isHomeRequest = !byTabId
    && newSurface.source.type === 'inline'
    && (newSurface.source.content ?? '') === '';

  /* tab.url 存的是**能真正读文件的那份路径** (normalizePath: 归一斜杠/`.`/`..`, 保大小写);
   * 判等另走 filePathKey。两者绝不能混用 —— 小写化的路径在 macOS 上打不开。 */
  const incomingPath = newSurface.source.type === 'file'
    ? normalizePath(newSurface.source.path)
    : newSurface.source.type === 'inline'
      ? `inline-${newSurface.id}`
      : newSurface.id;
  const incomingKey = filePathKey(incomingPath);
  /* web 的 tab.url 是真 URL (BrowserView 要用); 其余 kind 复用 url 字段存 path
   * (BrowserTab 类型兼容, 历史如此)。 */
  const incomingUrl = byTabId
    ? (newSurface.source.type === 'url' ? newSurface.source.url : 'about:blank')
    : incomingPath;

  const incomingTab: any = isHomeRequest ? null : {
    id: newSurface.id,
    url: incomingUrl,
    title: newSurface.title || (byTabId ? '' : (incomingPath.split(/[/\\]/).pop() || 'untitled')),
    ...(isCode ? buildCodeTabExtras(sessionId, newSurface, incomingPath) : {}),
  };

  const existing = Array.from(map.values()).find(s => s.kind === kind);
  if (existing) {
    const rawTabs = (existing.metadata?.tabs as any[] | undefined) ?? [];
    /* 盘上已经堆了重复空白页的用户, 靠"以后不再加"是清不掉的 —— 那几条会一直在。
     * 每次进来先把已有的空白页收敛成一条 (退出时清理是优化, 进来时清扫才是保证)。
     * 只对 tab-id 身份 (web) 做: 别的 kind 的 url 字段存的是路径, 不存在空白页。 */
    const existingTabs = byTabId
      ? rawTabs.filter((t: any, i: number) =>
          !isBlankTabUrl(t?.url) || rawTabs.findIndex((x: any) => isBlankTabUrl(x?.url)) === i)
      : rawTabs;
    if (!incomingTab) {
      const cleanedTabs = existingTabs.filter((t: any) => !String(t.url ?? '').startsWith('inline-'));
      if (cleanedTabs.length !== existingTabs.length) {
        map.set(existing.id, {
          ...existing,
          metadata: {
            ...(existing.metadata ?? {}),
            tabs: cleanedTabs,
            activeTabId: cleanedTabs[0]?.id,
          },
          updatedAt: Date.now(),
        });
      }
      activeBySession.set(sessionId, existing.id);
      rebuildCache(sessionId);
      emit();
      return;
    }
    /* 已经开着同一个东西 → 激活那个 tab, 不重复加 (避免双 viewer 同写同一文件) */
    const sameTab = byTabId
      ? (existingTabs.find((t: any) => t.id === incomingTab.id)
         ?? (isBlankTabUrl(incomingTab.url)
             ? existingTabs.find((t: any) => isBlankTabUrl(t.url))
             : undefined))
      : existingTabs.find((t: any) => filePathKey(String(t.url ?? '')) === incomingKey);
    const dedupedTabs = !sameTab
      ? [...existingTabs, incomingTab]
      : (isCode
          ? existingTabs.map((t: any) => (t === sameTab ? mergeCodeTab(sessionId, t, newSurface, incomingPath) : t))
          : existingTabs);
    const incomingLive = (newSurface.metadata as Record<string, unknown> | undefined)?.__agentLive;
    const updated: Surface = {
      ...existing,
      /* 外层 source 跟随激活 tab, 这样 SurfacePanel / viewer 取 source 也指向当前文件。
       * web 例外: 它的内容全在 BrowserView 里, host.source 不参与渲染。 */
      source: (!sameTab && !byTabId && newSurface.source.type === 'file')
        ? { type: 'file', path: newSurface.source.path }
        : existing.source,
      metadata: {
        ...(existing.metadata ?? {}),
        /* agent 往已有 host 再塞 tab 时也要亮轨道角标, 否则第二次 open 看起来没动静. */
        ...(typeof incomingLive === 'number' ? { __agentLive: incomingLive } : {}),
        tabs: dedupedTabs,
        activeTabId: sameTab ? sameTab.id : incomingTab.id,
      },
      updatedAt: Date.now(),
    };
    map.set(existing.id, updated);
    activeBySession.set(sessionId, existing.id);
    rebuildCache(sessionId);
    emit();
    return;
  }

  /* 没有现成 host —— 创建外层。home 模式 tabs=[], 否则塞第一个 tab。 */
  const hostMeta = { ...(newSurface.metadata ?? {}) };
  /* host 级不保留 defaultDiffViewMode — 只活在 tab 上, 防多 tab 串味 */
  delete (hostMeta as any).defaultDiffViewMode;
  const hostSurface: Surface = {
    ...newSurface,
    id: `${kind}-host-${sessionId}`,
    title: policy.hostTitle,
    metadata: {
      ...hostMeta,
      tabs: incomingTab ? [incomingTab] : [],
      activeTabId: incomingTab ? incomingTab.id : undefined,
    },
  };
  map.set(hostSurface.id, hostSurface);
  activeBySession.set(sessionId, hostSurface.id);
  rebuildCache(sessionId);
  emit();
}

/**
 * TurnSummaryBar 写入本轮 edits 后调用 — 把已自动打开、但缺 hunk 的 code tab 补齐审阅数据.
 * (open_surface 往往早于 turn_summary, ingest 当时 store 还是空的.)
 */
export function syncTurnEditsIntoCodeSurfaces(sessionId: string): void {
  if (!sessionId || !getAgentTurnEdits(sessionId)) return;
  const map = surfacesBySession.get(sessionId);
  if (!map) return;
  let touched = false;
  for (const [id, surface] of map.entries()) {
    if (surface.kind !== 'code') continue;
    const tabs = (surface.metadata?.tabs as any[] | undefined) ?? [];
    if (tabs.length === 0) continue;
    let tabTouched = false;
    const nextTabs = tabs.map((t) => {
      const path = String(t?.url ?? '');
      const enriched = enrichCodeTabFromTurnEdits(sessionId, path, t);
      if (enriched !== t) tabTouched = true;
      return enriched;
    });
    if (!tabTouched) continue;
    map.set(id, {
      ...surface,
      metadata: { ...(surface.metadata ?? {}), tabs: nextTabs },
      updatedAt: Date.now(),
    });
    touched = true;
  }
  if (!touched) return;
  rebuildCache(sessionId);
  emit();
}

function normalizeSessionSurfaces(sessionId: string): void {
  const map = surfacesBySession.get(sessionId);
  if (!map || map.size === 0) return;
  let touched = false;
  for (const [id, surface] of map.entries()) {
    const normalized = normalizeIncomingSurface(surface);
    if (normalized !== surface) {
      map.set(id, normalized);
      touched = true;
    }
  }
  if (!touched) return;
  rebuildCache(sessionId);
  emit();
}

/* ────── plan markdown ops ─────────────────────────────────────────
 * Plan 内容是 markdown. 这里实现 5 种增量 op:
 *   - content / append: 字符串拼接
 *   - replace_section: 按 heading 文本找到一节(标题行 → 下一同级或更高级标题前)并替换
 *   - set_section_status: 在 heading 行后追加 / 替换 `<!-- status: ... -->` 注释
 *   - add_note: 在 "## 笔记" / "## Notes" 节追加一行 bullet(没有就在文末建一节)
 * 实现求稳不求快, plan 一般几千字, 性能足够.
 */

const PLAN_STATUS_RE = /<!--\s*status:\s*(pending|in_progress|done)\s*-->/i;
const NOTES_HEADING_RE = /^(#{1,6})\s+(笔记|Notes?)\s*(<!--[^>]*-->)?\s*$/i;

function headingLevel(line: string): number {
  const m = /^(#{1,6})\s+/.exec(line);
  return m ? m[1].length : 0;
}

function headingTitle(line: string): string {
  /* 去掉 "## " 前缀, 末尾 status 注释和空白 */
  const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
  if (!m) return '';
  return m[1].replace(PLAN_STATUS_RE, '').trim();
}

function findSectionRange(lines: string[], heading: string): { start: number; end: number; level: number } | null {
  const target = heading.trim();
  for (let i = 0; i < lines.length; i++) {
    const lvl = headingLevel(lines[i]);
    if (lvl === 0) continue;
    if (headingTitle(lines[i]) !== target) continue;
    /* 找到 — 扫到下一同级或更高级 heading */
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const ll = headingLevel(lines[j]);
      if (ll > 0 && ll <= lvl) { end = j; break; }
    }
    return { start: i, end, level: lvl };
  }
  return null;
}

function applyPlanOp(content: string, op: PlanOp): string {
  if (op.kind === 'content') return op.content;

  if (op.kind === 'append') {
    const sep = content.length === 0 || content.endsWith('\n') ? '' : '\n';
    const tail = op.text.startsWith('\n') ? op.text : '\n' + op.text;
    return content + sep + tail;
  }

  const lines = content.split('\n');

  if (op.kind === 'replace_section') {
    const range = findSectionRange(lines, op.heading);
    if (!range) {
      /* 没找到 → 当 append 处理(加一节) */
      return applyPlanOp(content, { kind: 'append', text: op.content });
    }
    const newLines = op.content.split('\n');
    lines.splice(range.start, range.end - range.start, ...newLines);
    return lines.join('\n');
  }

  if (op.kind === 'set_section_status') {
    for (let i = 0; i < lines.length; i++) {
      if (headingLevel(lines[i]) === 0) continue;
      if (headingTitle(lines[i]) !== op.heading.trim()) continue;
      const line = lines[i];
      const cleaned = line.replace(PLAN_STATUS_RE, '').replace(/\s+$/, '');
      lines[i] = `${cleaned} <!-- status: ${op.status} -->`;
      return lines.join('\n');
    }
    /* 没找到对应 heading — 静默忽略, 不当错误 */
    return content;
  }

  if (op.kind === 'add_note') {
    /* 找现有 "## 笔记" / "## Notes" */
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (NOTES_HEADING_RE.test(lines[i])) { idx = i; break; }
    }
    const bullet = `- ${op.text.trim()}`;
    if (idx === -1) {
      /* 没有 — 在文末建一节 */
      const sep = content.length === 0 || content.endsWith('\n') ? '' : '\n';
      return content + sep + '\n## 笔记\n\n' + bullet + '\n';
    }
    /* 找笔记节的尾部, 插入 bullet */
    const lvl = headingLevel(lines[idx]);
    let endIdx = lines.length;
    for (let j = idx + 1; j < lines.length; j++) {
      const ll = headingLevel(lines[j]);
      if (ll > 0 && ll <= lvl) { endIdx = j; break; }
    }
    /* 在 endIdx 前插入 bullet, 跳过尾部空行 */
    let insertAt = endIdx;
    while (insertAt > idx + 1 && lines[insertAt - 1].trim() === '') insertAt--;
    lines.splice(insertAt, 0, bullet);
    return lines.join('\n');
  }

  return content;
}


/** 某一条会话的视图 = 它自己的 surface + 其它会话里的**常驻** surface (服务/浏览器) */
function disposeStreamingPlaceholder(sessionId: string, toolCallId: string | undefined): string | undefined {
  if (!toolCallId) return undefined;
  const tempId = streamingByToolCall.get(toolCallId);
  if (!tempId) return undefined;
  streamingByToolCall.delete(toolCallId);
  surfacesBySession.get(sessionId)?.delete(tempId);
  return tempId;
}

function rebuildOne(sessionId: string): void {
  const own = surfacesBySession.get(sessionId);
  const merged: Surface[] = own ? [...own.values()] : [];
  const seen = new Set(merged.map((s) => s.id));
  for (const [otherSid, otherMap] of surfacesBySession) {
    if (otherSid === sessionId) continue;
    for (const sf of otherMap.values()) {
      if (isPersistentKind(sf.kind) && !seen.has(sf.id)) { merged.push(sf); seen.add(sf.id); }
    }
  }
  if (merged.length === 0) {
    cachedArrayBySession.delete(sessionId);
    return;
  }
  /* 排序: 常驻的钉最前 (它们一直在, 位置要稳), 然后 pinned, 然后按 createdAt 升序 */
  merged.sort((a, b) => {
    const pa = isPersistentKind(a.kind) ? 0 : 1;
    const pb = isPersistentKind(b.kind) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return a.createdAt - b.createdAt;
  });
  const prevArr = cachedArrayBySession.get(sessionId);
  if (prevArr && prevArr.length === merged.length && prevArr.every((s, i) => s === merged[i])) {
    return;
  }
  cachedArrayBySession.set(sessionId, merged);
}

function findPersistentOwner(surfaceId: string, exceptSession: string): string | null {
  for (const [sid, m] of surfacesBySession) {
    if (sid === exceptSession) continue;
    const sf = m.get(surfaceId);
    if (sf && isPersistentKind(sf.kind)) return sid;
  }
  return null;
}

function rebuildCache(sessionId: string): void {
  /* 常驻 surface 是跨会话共享的, 所以任何一处变动都要让**所有**会话的视图跟上 ——
   * 只刷新变动的那条, 别的会话就会停在旧快照上 (比如在 A 里开了服务, 切到 B 看不见)。
   * 会话数是十几条量级、每条的 map 很小, 全量重建的成本可以忽略。 */
  rebuildOne(sessionId);
  /* 必须连 cachedArrayBySession 的 key 一起遍历: 一条只"看"不"开"的会话
   * (自己没开过任何 surface, 只是借常驻的看) 在 surfacesBySession 里根本没有 key,
   * 只按 surfacesBySession 刷新的话它会永远停在第一次算出来的那份快照上 ——
   * 在 A 里关掉服务, 切到 B 还挂着个点不开的幽灵 tab。 */
  for (const sid of surfacesBySession.keys()) {
    if (sid !== sessionId) rebuildOne(sid);
  }
  for (const sid of cachedArrayBySession.keys()) {
    if (sid !== sessionId && !surfacesBySession.has(sid)) rebuildOne(sid);
  }
}

/** 把工具返回字符串尝试解析成 SurfaceEventPayload — 不是 marker 就返回 null */
export function parseSurfaceMarker(raw: string): SurfaceEventPayload | null {
  if (!raw || typeof raw !== 'string') return null;
  if (!raw.includes(SURFACE_MARKER)) return null;
  try {
    const obj = JSON.parse(raw);
    if (obj && obj[SURFACE_MARKER] === true && typeof obj.action === 'string') {
      return obj as SurfaceEventPayload;
    }
  } catch { /* not JSON */ }
  return null;
}

export function ingestSurfaceEvent(
  sessionId: string,
  payload: SurfaceEventPayload,
  opts?: { toolCallId?: string; reveal?: boolean },
): void {
  if (!sessionId) return;
  let map = surfacesBySession.get(sessionId);
  if (!map) { map = new Map(); surfacesBySession.set(sessionId, map); }

  if (payload.action === 'open' && payload.surface) {
    const rawKind = String(payload.surface.kind || '');
    /* terminal 只认用户手动开 (payload.byUser); chart 无内容时拒绝 (有 mermaid 时 normalize remap 成 diagram)。 */
    if ((USER_ONLY_SURFACE_KINDS.has(rawKind) && !payload.byUser)
      || (rawKind === 'chart' && !(payload.surface.source?.type === 'inline' && String((payload.surface.source as any).content || '').trim()))) {
      console.warn('[surfaceStore] open rejected: unsupported kind', { kind: rawKind, sessionId });
      return;
    }
    const newSurface = normalizeIncomingSurface(payload.surface);
    if (!opts?.reveal) {
      newSurface.metadata = { ...(newSurface.metadata ?? {}), __agentLive: Date.now() };
    }
    newSurface.metadata = {
      ...(newSurface.metadata ?? {}),
      __openedBy: (payload.byUser || opts?.reveal) ? 'user' : 'agent',
    };
    if (UNSUPPORTED_SURFACE_KINDS.has(String(newSurface.kind))) {
      console.warn('[surfaceStore] open rejected after normalize: unsupported kind', { kind: newSurface.kind, sessionId });
      /* 拒了也要把占位收掉 —— 否则标签栏上留一个永远打不开的"生成中…" */
      if (disposeStreamingPlaceholder(sessionId, opts?.toolCallId)) { rebuildCache(sessionId); emit(); }
      return;
    }
    /* 用户点的照开; agent 开的只有交付物展开右栏, 过程类只在上下文栏留胶囊 (见 AGENT_REVEAL_KINDS)。 */
    if (opts?.reveal || AGENT_REVEAL_KINDS.has(String(newSurface.kind))) requestSurfacePanelOpen(sessionId, newSurface);
    /* 真 surface 到了 → dispose 对应的 streaming temp surface */
    {
      const tempId = disposeStreamingPlaceholder(sessionId, opts?.toolCallId);
      if (tempId && activeBySession.get(sessionId) === tempId) {
        activeBySession.set(sessionId, newSurface.id);
      }
    }
    /* P3+: 'services' 是 single-instance surface (整个 panel 总控页, 多 tab 无意义).
     *   如果已经有 'services' surface, 不开新的, 只激活现有的. 同样适用于 'web'
     *   同 URL — 防止反复点 "Open" 在 web preview 时无限开 tab.
     * Team P2: 'team' 同款单实例 (一个 session 一个活跃 Team, 面板数据在 teamRunStore) —
     *   新一轮 team_run 复用 tab 只刷 metadata.teamId + title (新 goal). */
    if (isPersistentKind(newSurface.kind)) {
      for (const [otherSid, otherMap] of surfacesBySession) {
        if (otherSid === sessionId) continue;
        const shared = Array.from(otherMap.values()).find(s => s.kind === newSurface.kind);
        if (!shared) continue;
        if (newSurface.metadata) {
          otherMap.set(shared.id, {
            ...shared,
            metadata: { ...(shared.metadata ?? {}), ...newSurface.metadata },
            updatedAt: Date.now(),
          });
        }
        activeBySession.set(sessionId, shared.id);
        if (map.size === 0) surfacesBySession.delete(sessionId);
        rebuildCache(otherSid);
        emit();
        return;
      }
    }

    const policy: SurfaceMergePolicy = SURFACE_MERGE_POLICY[newSurface.kind] ?? { mode: 'per-source' };

    if (policy.mode === 'singleton') {
      /* 一个会话一份, 与 source 无关 —— 再开就是激活已有那份。 */
      const existing = Array.from(map.values()).find(s => s.kind === newSurface.kind);
      if (existing) {
        map.set(existing.id, {
          ...existing,
          ...(policy.adoptTitle && newSurface.title ? { title: newSurface.title } : {}),
          /* adoptSource: 待办这类"单实例但内容会整份换掉"的 kind 要吃下新内容,
           * 否则第二次 open 的清单会被静默丢掉。服务/Git/文件的 source 是空占位, 不动。 */
          source: policy.adoptSource && hasMeaningfulSource(newSurface) ? newSurface.source : existing.source,
          metadata: newSurface.metadata
            ? { ...(existing.metadata ?? {}), ...newSurface.metadata }
            : existing.metadata,
          updatedAt: Date.now(),
        });
        aliasSurfaceId(sessionId, newSurface.id, existing.id);
        activeBySession.set(sessionId, existing.id);
        rebuildCache(sessionId);
        emit();
        return;
      }
    } else if (policy.mode === 'host-tabs') {
      openIntoHostTabs(sessionId, map, newSurface, policy);
      return;
    } else if (policy.mode === 'per-source') {
      /* 顶层独立 tab, 但**同一个文件只有一份**: 同 path 再开 = 激活已有那个,
       * 顺带把 metadata 刷成最新的 (changedLines / line 等)。
       * inline / url 源没有稳定身份, 拿不到 key, 只能当成新的一份。 */
      const key = sourceIdentity(newSurface);
      const existing = key
        ? Array.from(map.values()).find(s => s.kind === newSurface.kind && sourceIdentity(s) === key)
        : undefined;
      if (existing) {
        map.set(existing.id, {
          ...existing,
          title: newSurface.title || existing.title,
          source: newSurface.source,
          metadata: newSurface.metadata
            ? { ...(existing.metadata ?? {}), ...newSurface.metadata }
            : existing.metadata,
          updatedAt: Date.now(),
        });
        aliasSurfaceId(sessionId, newSurface.id, existing.id);
        activeBySession.set(sessionId, existing.id);
        rebuildCache(sessionId);
        emit();
        return;
      }
    }

    /* singleton 首份 / per-source 首次打开这个文件 / always-new —— 新建一份。 */
    map.set(newSurface.id, newSurface);
    /* 新打开自动切为 active(用户最关心新出现的) */
    activeBySession.set(sessionId, newSurface.id);
    rebuildCache(sessionId);
    emit();
    return;
  }

  /* 下面这些动作都拿着"调用方给的 id"来找 surface —— 先过一遍别名表, 否则
   * open 时被合并掉的那个 id 会查不到, 事件静默丢失 (见 surfaceIdAliasBySession)。 */
  const targetId = payload.surfaceId ? resolveSurfaceId(sessionId, payload.surfaceId) : undefined;

  if (payload.action === 'update' && targetId && payload.patch) {
    const existing = map.get(targetId);
    if (!existing) {
      const owner = findPersistentOwner(targetId, sessionId);
      if (owner) ingestSurfaceEvent(owner, payload);
      return;
    }
    const updated: Surface = {
      ...existing,
      ...payload.patch,
      id: existing.id, // id 不可变
      createdAt: existing.createdAt, // 也不可变
      updatedAt: Date.now(),
    };
    map.set(updated.id, updated);
    rebuildCache(sessionId);
    emit();
    return;
  }

  if (payload.action === 'plan_op' && targetId && payload.planOp) {
    const existing = map.get(targetId);
    if (!existing) {
      console.warn('[surfaceStore] plan_op rejected: surface_id not found', { surfaceId: payload.surfaceId, available: Array.from(map.keys()) });
      return;
    }
    if (existing.kind !== 'plan') {
      console.warn('[surfaceStore] plan_op rejected: kind mismatch', { surfaceId: payload.surfaceId, expected: 'plan', actual: existing.kind });
      return;
    }
    const oldContent = existing.source.type === 'inline' ? existing.source.content : '';
    const newContent = applyPlanOp(oldContent, payload.planOp);
    const updated: Surface = {
      ...existing,
      source: { type: 'inline', content: newContent },
      updatedAt: Date.now(),
    };
    map.set(updated.id, updated);
    rebuildCache(sessionId);
    emit();
    return;
  }

  if (payload.action === 'todo_replace' && targetId && Array.isArray(payload.todoItems)) {
    let existing = map.get(targetId);
    if (!existing && payload.ensureSurface) {
      /* 本会话已经有 todo surface 就复用它 —— 否则模型换个 id 就多长一个"待办清单"tab */
      existing = [...map.values()].find((s) => s.kind === 'todo');
    }
    if (!existing) {
      if (!payload.ensureSurface) {
        console.warn('[surfaceStore] todo_replace rejected: surface_id not found', { surfaceId: payload.surfaceId, available: Array.from(map.keys()) });
        return;
      }
      const now = Date.now();
      const created: Surface = {
        id: targetId,
        kind: 'todo',
        source: { type: 'inline', content: JSON.stringify({ items: [] } satisfies TodoState) },
        title: payload.ensureSurface.title || '待办清单',
        pinned: payload.ensureSurface.pinned === true,
        createdAt: now,
        updatedAt: now,
      };
      map.set(created.id, created);
      existing = created;
    }
    if (existing.kind !== 'todo') {
      console.warn('[surfaceStore] todo_replace rejected: kind mismatch', { surfaceId: payload.surfaceId, expected: 'todo', actual: existing.kind });
      return;
    }
    const newState: TodoState = { items: payload.todoItems };
    const updated: Surface = {
      ...existing,
      source: { type: 'inline', content: JSON.stringify(newState) },
      updatedAt: Date.now(),
    };
    map.set(updated.id, updated);
    rebuildCache(sessionId);
    emit();
    return;
  }

  if (payload.action === 'close' && targetId) {
    if (!map.has(targetId)) {
      /* 关的是别的会话开的常驻 surface —— 转交给真正的主人, 语义是"整个工作区都关掉" */
      const owner = findPersistentOwner(targetId, sessionId);
      if (!owner) return;
      /* 别因为一次"借来的关闭"给这条会话留个空 map */
      if (map.size === 0) surfacesBySession.delete(sessionId);
      ingestSurfaceEvent(owner, payload);
      return;
    }
    const viewOrder = (cachedArrayBySession.get(sessionId) ?? []).map(s => s.id);
    const closedIdx = viewOrder.indexOf(targetId);
    map.delete(targetId);
    /* surface 没了, 指向它的别名也要一起清 —— 否则别名表只涨不落, 而且一个已关闭的
     * id 还会把后续事件引到空处。 */
    dropAliasesTo(sessionId, targetId);
    if (activeBySession.get(sessionId) === targetId) {
      const survivors = viewOrder.filter(id => id !== targetId && (map.has(id) || !!findPersistentOwner(id, sessionId)));
      /* closedIdx 位置上现在站的就是原来的右邻; 关的是最后一个就退到左邻 */
      const next = closedIdx >= 0
        ? (survivors[closedIdx] ?? survivors[closedIdx - 1] ?? survivors[survivors.length - 1])
        : survivors[0];
      activeBySession.set(sessionId, next);
    }
    if (map.size === 0) {
      surfacesBySession.delete(sessionId);
      activeBySession.delete(sessionId);
    }
    rebuildCache(sessionId);
    /* 常驻的被关掉后, 别的会话的 active 可能还指着它 —— 那会渲染出一片空白面板。
     * 重建完视图再统一把这些死指针挪到各自视图里的第一个。 */
    for (const [sid, activeId] of activeBySession) {
      if (activeId !== targetId || sid === sessionId) continue;
      const next = cachedArrayBySession.get(sid)?.[0]?.id;
      if (next) activeBySession.set(sid, next); else activeBySession.delete(sid);
    }
    emit();
  }
}

export function abandonStreamingSurface(sessionId: string, toolCallId: string | undefined): void {
  if (!sessionId || !toolCallId) return;
  if (!disposeStreamingPlaceholder(sessionId, toolCallId)) return;
  rebuildCache(sessionId);
  emit();
}

/** Streaming: agent 还在 stream open_surface args 时调用. 一旦 kind 出现就先建一个空 temp surface, 让用户立刻看到 tab. */
export function ingestStreamingSurfaceInit(
  sessionId: string,
  opts: { toolCallId: string; kind: SurfaceKind; title?: string; pinned?: boolean },
): void {
  if (!sessionId || !opts?.toolCallId || !opts?.kind) return;
  if (UNSUPPORTED_SURFACE_KINDS.has(String(opts.kind))) return;
  const tempId = `sfc-stream-${opts.toolCallId}`;
  let map = surfacesBySession.get(sessionId);
  if (!map) { map = new Map(); surfacesBySession.set(sessionId, map); }
  if (map.has(tempId)) return; // 已 init 过, 不重复建

  const now = Date.now();
  const surface: Surface = {
    id: tempId,
    kind: opts.kind,
    source: { type: 'inline', content: '' },
    title: opts.title || (getGlobalLanguage() === 'zh' ? `${opts.kind} 生成中…` : `Generating ${opts.kind}…`),
    pinned: opts.pinned === true,
    metadata: { __streaming: true, __toolCallId: opts.toolCallId },
    createdAt: now,
    updatedAt: now,
  };
  map.set(tempId, surface);
  streamingByToolCall.set(opts.toolCallId, tempId);
  activeBySession.set(sessionId, tempId);
  rebuildCache(sessionId);
  emit();
}

/** Streaming: agent 流式输出 content 期间持续追加. partialContent 是迄今为止抽出的完整片段(不是 delta). */
export function ingestStreamingSurfaceContent(
  sessionId: string,
  opts: { toolCallId: string; partialContent: string },
): void {
  if (!sessionId || !opts?.toolCallId) return;
  const map = surfacesBySession.get(sessionId);
  if (!map) return;
  const tempId = streamingByToolCall.get(opts.toolCallId);
  if (!tempId) return;
  const existing = map.get(tempId);
  if (!existing) return;
  /* idempotent: 同样 content 不重渲染 */
  if (existing.source.type === 'inline' && existing.source.content === opts.partialContent) return;

  const updated: Surface = {
    ...existing,
    source: { type: 'inline', content: opts.partialContent },
    updatedAt: Date.now(),
  };
  map.set(tempId, updated);
  rebuildCache(sessionId);
  emit();
}

/**
 * 从 open_surface 工具的 partial JSON args buffer 里抽取 kind / source.type / content.
 *
 * tool args 边流边变, buffer 可能是任何中间态:
 *   `{"kind":"`                                      → 啥都拿不到
 *   `{"kind":"plan"`                                 → kind='plan'
 *   `{"kind":"plan","source":{"type":"inline","cont` → kind+sourceType, content 还没开始
 *   `{"kind":"plan","source":{"type":"inline","content":"# 方` → content='# 方' (partial)
 *
 * 转义处理: 用 JSON.parse 把 partial `"<head>...` 反转义, 自动处理 \", \\, \n, \uXXXX.
 * 遇到末尾不完整的 \ 或 \uXX 时, 砍掉再 parse.
 */
export function extractPartialOpenSurfaceArgs(buffer: string): {
  kind?: SurfaceKind;
  sourceType?: 'file' | 'inline' | 'url';
  content?: string;
  title?: string;
} {
  const result: { kind?: SurfaceKind; sourceType?: 'file' | 'inline' | 'url'; content?: string; title?: string } = {};
  if (!buffer) return result;

  const kindMatch = buffer.match(/"kind"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (kindMatch) result.kind = kindMatch[1] as SurfaceKind;

  const titleMatch = buffer.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (titleMatch) result.title = titleMatch[1];

  const typeMatch = buffer.match(/"source"\s*:\s*\{[^}]*?"type"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (typeMatch) result.sourceType = typeMatch[1] as 'file' | 'inline' | 'url';

  const cKey = buffer.search(/"content"\s*:\s*"/);
  if (cKey >= 0) {
    const colonIdx = buffer.indexOf(':', cKey);
    const openQuote = buffer.indexOf('"', colonIdx + 1);
    if (openQuote > 0) {
      let i = openQuote + 1;
      let escape = false;
      let endIdx = -1;
      while (i < buffer.length) {
        const c = buffer[i];
        if (escape) escape = false;
        else if (c === '\\') escape = true;
        else if (c === '"') { endIdx = i; break; }
        i++;
      }
      let raw: string;
      if (endIdx >= 0) {
        raw = buffer.slice(openQuote, endIdx + 1);
      } else {
        let safeEnd = buffer.length;
        if (escape) safeEnd--; // 截掉末尾孤立的 \
        const tail = buffer.slice(Math.max(openQuote + 1, safeEnd - 6), safeEnd);
        const uMatch = tail.match(/\\u[0-9a-fA-F]{0,3}$/);
        if (uMatch) safeEnd -= uMatch[0].length;
        raw = buffer.slice(openQuote, safeEnd) + '"';
      }
      try { result.content = JSON.parse(raw); }
      catch { /* 极少数畸形, 这 tick 不更新 */ }
    }
  }

  return result;
}

/** 用户操作: 切换 active tab */
export function setActiveSurface(sessionId: string, surfaceId: string | undefined): void {
  activeBySession.set(sessionId, surfaceId);
  emit();
}

export function cleanupSurfaceSession(sessionId: string): void {
  if (!sessionId) return;
  /* 取消正在排队的 persist timer */
  const t = persistTimers.get(sessionId);
  if (t) { clearTimeout(t); persistTimers.delete(sessionId); }
  /* 清模块级 Map/Set — 注意 persistInflight 的 Promise 自然 resolve 后会自清 (line 129-130),
   *  但 IPC inflight 期间 Promise 闭包仍持 sessionId 字符串引用; 这里强删 entry, Promise
   *  resolve 时 get(sessionId) !== task 短路, 不再 delete (已删). 不影响 IPC 完成性. */
  persistInflight.delete(sessionId);
  surfacesBySession.delete(sessionId);
  cachedArrayBySession.delete(sessionId);
  activeBySession.delete(sessionId);
  restoredSessions.delete(sessionId);
  surfaceIdAliasBySession.delete(sessionId);
  /* 清掉该 session 下的所有 streaming tracking — streamingByToolCall 是 toolCallId 索引,
   *  不知道哪些属于此 session. 这是 streaming 中临时态, session 删时若有未完成 streaming
   *  本就该跟着死, 但 toolCallId 没记 sessionId. 留 BACKLOG: streamingByToolCall 加 sessionId
   *  tag 后才能精确清; 当前 entry 数量极小 (单数位), 不构成泄漏. */
  emit();
  /* 同步把 SQLite 那边的 surface 状态也擦掉 — 防重启时 restoreFromStorage 又把数据拉回来. */
  const api = (window as any).neox;
  if (api?.uiStateSetSurfaces) {
    void api.uiStateSetSurfaces(sessionId, null).catch(() => { /* 删 session 流程不该被卡 */ });
  }
}

/** 用户操作: 关闭 surface */
export function closeSurface(sessionId: string, surfaceId: string): void {
  ingestSurfaceEvent(sessionId, { action: 'close', surfaceId });
}

/** 用户操作 (web surface 内部 tab CRUD). 这些不走 SURFACE_MARKER, 直接改 store. */

export interface BrowserTab {
  id: string;
  url: string;
  title?: string;
  loading?: boolean;
  pinned?: boolean;
}

/** 在指定 web surface 加一个 tab. 失败 (surface 不存在或非 web kind) 静默返 null. */
export function addBrowserTab(sessionId: string, webSurfaceId: string, tab: BrowserTab): string | null {
  const map = surfacesBySession.get(sessionId);
  const s = map?.get(webSurfaceId);
  if (!s || s.kind !== 'web') return null;
  const tabs = ((s.metadata?.tabs as BrowserTab[]) ?? []).slice();
  if (!tabs.some(t => t.id === tab.id)) tabs.push(tab);
  map!.set(webSurfaceId, {
    ...s,
    metadata: { ...(s.metadata ?? {}), tabs, activeTabId: tab.id },
    updatedAt: Date.now(),
  });
  rebuildCache(sessionId);
  emit();
  return tab.id;
}

/** 切换当前 active tab. */
export function setActiveBrowserTab(sessionId: string, webSurfaceId: string, tabId: string): void {
  const map = surfacesBySession.get(sessionId);
  const s = map?.get(webSurfaceId);
  /* web (Chrome 风) + code (源码 host) + sheet (表格 host) 都用同款 metadata.tabs/activeTabId — 共用此 helper. */
  if (!s || (s.kind !== 'web' && s.kind !== 'code' && s.kind !== 'sheet' && s.kind !== 'pdf' && s.kind !== 'docx' && s.kind !== 'pptx')) return;
  map!.set(webSurfaceId, {
    ...s,
    metadata: { ...(s.metadata ?? {}), activeTabId: tabId },
    updatedAt: Date.now(),
  });
  rebuildCache(sessionId);
  emit();
}

/** 关掉一个 tab. 如果 active 被关, fallback 到剩下的最后一个; 全关空了就 surface 整个关掉. */
export function closeBrowserTab(sessionId: string, webSurfaceId: string, tabId: string): void {
  const map = surfacesBySession.get(sessionId);
  const s = map?.get(webSurfaceId);
  if (!s || (s.kind !== 'web' && s.kind !== 'code' && s.kind !== 'sheet' && s.kind !== 'pdf' && s.kind !== 'docx' && s.kind !== 'pptx')) return;
  const tabs = ((s.metadata?.tabs as BrowserTab[]) ?? []).filter(t => t.id !== tabId);
  if (tabs.length === 0) {
    /* 没 tab 了, 关闭整个 web surface */
    ingestSurfaceEvent(sessionId, { action: 'close', surfaceId: webSurfaceId });
    return;
  }
  const currentActive = s.metadata?.activeTabId as string | undefined;
  const newActive = currentActive === tabId ? tabs[tabs.length - 1]!.id : currentActive!;
  map!.set(webSurfaceId, {
    ...s,
    metadata: { ...(s.metadata ?? {}), tabs, activeTabId: newActive },
    updatedAt: Date.now(),
  });
  rebuildCache(sessionId);
  emit();
}

/** 更新 tab 的 url / title / loading 等. 通常由 BrowserView 反向同步 (get_state poll). */
export function updateBrowserTab(sessionId: string, webSurfaceId: string, tabId: string, patch: Partial<BrowserTab>): void {
  const map = surfacesBySession.get(sessionId);
  const s = map?.get(webSurfaceId);
  if (!s || s.kind !== 'web') return;
  const tabs = ((s.metadata?.tabs as BrowserTab[]) ?? []).map(t => t.id === tabId ? { ...t, ...patch } : t);
  map!.set(webSurfaceId, {
    ...s,
    metadata: { ...(s.metadata ?? {}), tabs },
    updatedAt: Date.now(),
  });
  rebuildCache(sessionId);
  emit();
}

/** 用户操作: pin / unpin */
export function togglePinSurface(sessionId: string, surfaceId: string): void {
  const existing = surfacesBySession.get(sessionId)?.get(surfaceId);
  if (!existing) return;
  ingestSurfaceEvent(sessionId, {
    action: 'update',
    surfaceId,
    patch: { pinned: !existing.pinned },
  });
}

/** 浅合并 surface.metadata — 文件预览导航等 viewer 本地状态回写用.
 *  不走 ingest open (会触发 panel-open / singleton 合并副作用). */
export function patchSurfaceMetadata(
  sessionId: string,
  surfaceId: string,
  patch: Record<string, unknown>,
): void {
  if (!sessionId || !surfaceId || !patch) return;
  const map = surfacesBySession.get(sessionId);
  const s = map?.get(surfaceId);
  if (!s) return;
  map!.set(surfaceId, {
    ...s,
    metadata: { ...(s.metadata ?? {}), ...patch },
    updatedAt: Date.now(),
  });
  rebuildCache(sessionId);
  emit();
}

export function refreshFileSurfaces(absPath: string): void {
  const target = filePathKeyOf(absPath);
  if (!target) return;
  let touched = false;
  for (const [sessionId, map] of surfacesBySession) {
    for (const [id, s] of map) {
      if (s.source?.type !== 'file') continue;
      if (filePathKeyOf((s.source as { path?: string }).path) !== target) continue;
      map.set(id, { ...s, source: { ...s.source }, updatedAt: Date.now() });
      touched = true;
    }
    if (touched) rebuildCache(sessionId);
  }
  if (touched) emit();
}

export function closeSurfacesForDeletedFile(absPath: string): void {
  const target = filePathKeyOf(absPath);
  if (!target) return;
  for (const [sessionId, map] of surfacesBySession) {
    const doomed: string[] = [];
    for (const [id, s] of map) {
      if (s.source?.type !== 'file') continue;
      if (filePathKeyOf((s.source as { path?: string }).path) !== target) continue;
      doomed.push(id);
    }
    for (const id of doomed) closeSurface(sessionId, id);
  }
}

/** 路径比较用的归一化 key — 大小写不敏感 (macOS/Windows), 去掉结尾斜杠。 */
function filePathKeyOf(p: unknown): string {
  if (typeof p !== 'string' || !p) return '';
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
};

/** 测试用: 直接跑一遍"重启后从 SQLite 恢复" (生产里由 useSurfaces 触发)。 */
export function __restoreForTest(sessionId: string): Promise<void> {
  return restoreFromStorage(sessionId);
}

const EMPTY_ARR: Surface[] = [];

export function useSurfaces(sessionId: string | null | undefined): Surface[] {
  const sid = sessionId ?? '';
  /* P3+: 异步 lazy 恢复 (SQLite via IPC). 第一次给某 sessionId 调时 fire-and-forget,
   * 拿到数据后内部 emit() 触发 React 重渲. restoredSessions 防重复. */
  if (sid && !restoredSessions.has(sid)) {
    void restoreFromStorage(sid);
  }
  useEffect(() => {
    if (sid) normalizeSessionSurfaces(sid);
  }, [sid]);
  const getSnapshot = (): Surface[] => {
    if (!sid) return EMPTY_ARR;
    return viewOf(sid);
  };
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_ARR);
}

export function useActiveSurfaceId(sessionId: string | null | undefined): string | undefined {
  const sid = sessionId ?? '';
  if (sid && !restoredSessions.has(sid)) {
    void restoreFromStorage(sid);
  }
  const getSnapshot = (): string | undefined => sid ? activeBySession.get(sid) : undefined;
  return useSyncExternalStore(subscribe, getSnapshot, () => undefined);
}

/** 同时订阅好几个会话的 surface (拖成独立窗口的标签: 切到别的会话时窗口照样开着, 要一直拿得到它那个会话的数据)。
 *  各会话的数组本身是缓存的, 都没变就返回上一次的同一个数组, useSyncExternalStore 不会空转。 */
export function useSurfacesFor(sessionIds: string[]): Surface[][] {
  for (const sid of sessionIds) {
    if (sid && !restoredSessions.has(sid)) void restoreFromStorage(sid);
  }
  const last = useRef<Surface[][]>(EMPTY_LISTS);
  const getSnapshot = (): Surface[][] => {
    const arrs = sessionIds.map((sid) => (sid ? viewOf(sid) : EMPTY_ARR));
    const prev = last.current;
    if (prev.length === arrs.length && prev.every((a, i) => a === arrs[i])) return prev;
    last.current = arrs;
    return arrs;
  };
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_LISTS);
}
const EMPTY_LISTS: Surface[][] = [];

/** 调试 */
/** 读某会话的合并视图; 没缓存就现算一次。
 *  必须现算的原因: 一条**刚新建、自己什么都没开过**的会话在 surfacesBySession 里根本没有 key,
 *  rebuildCache 的循环遍历不到它 —— 而这正是最常见的场景: 切到新会话, 应该照样看得见
 *  已经在跑的服务/浏览器。 */
function viewOf(sessionId: string): Surface[] {
  let arr = cachedArrayBySession.get(sessionId);
  if (!arr) {
    rebuildOne(sessionId);
    arr = cachedArrayBySession.get(sessionId);
  }
  return arr ?? EMPTY_ARR;
}

/** 测试用: 直接读某会话的合并视图, 不需要 React 环境 */
/** 测试用: 直接读当前激活项, 不经 React */
/** 非 React 上下文读某个会话当前的产出列表 (serviceAutoShow 判断"面板里是不是已经开着别的")。 */
export function getSurfaces(sessionId: string): Surface[] {
  const map = surfacesBySession.get(sessionId);
  return map ? Array.from(map.values()) : [];
}

export function __peekActiveId(sessionId: string): string | undefined {
  return activeBySession.get(sessionId);
}

export function __peekSurfaces(sessionId: string): Surface[] {
  return viewOf(sessionId);
}

export function _resetSurfaceStoreForTest(): void {
  surfacesBySession.clear();
  cachedArrayBySession.clear();
  activeBySession.clear();
  restoredSessions.clear();
  surfaceIdAliasBySession.clear();
  persistTimers.forEach(t => clearTimeout(t));
  persistTimers = new Map();
  listeners.clear();
}
