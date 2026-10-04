/**
 * Surface — Neox 右栏"工作面"统一抽象
 *
 * agent 通过 open_surface 工具把可视化产出物(markdown / mermaid / image / html / 浏览器 / ...)
 * 推到 renderer 右栏画布. viewer registry 按 kind 路由到对应组件渲染.
 *
 * 跟 IDE 文件 tab 互补 — IDE tab 是 editor (可编辑), surface 是 viewer (聚焦展示).
 */

export type SurfaceKind =
  | 'doc'      // markdown 文档
  | 'diagram'  // mermaid 图
  | 'image'    // 静态图片
  | 'html'     // 静态 HTML (iframe sandbox)
  | 'svg'      // 矢量图
  | 'web'      // 浏览器 (Electron webview)
  | 'pdf'
  | 'code'     // 源代码文件 (Monaco read-only, 跟扩展名自动定语言, 含 json/yaml/toml/xml)
  | 'diff'     // 文件 diff (unified diff string)
  /* terminal / chart 已下线: 终端走 services / execute_shell; 图用 diagram(Mermaid). */
  | 'plan'     // 长任务作战图 (markdown + 软标记)
  | 'todo'     // 短期一茬清单 (结构化勾选)
  | 'services' // 服务治理总控页 (master-detail, 内嵌多个 service 的 log tabs)
  | 'sheet'    // 表格 (Univer 渲染 .xlsx / .csv / inline IWorkbookData, S1 Phase 1 只读)
  | 'docx'     // Word 文档 (.docx — mammoth 转 HTML 渲染, 只读)
  | 'pptx';    // PowerPoint (.pptx / .ppt — 后端 soffice 转 PDF, 前端复用 PdfSurfaceViewer)

/** 数据来源 — file 路径(watch 实时刷新) / inline 内嵌 / url(给 web/pdf 用) */
export type SurfaceSource =
  | { type: 'file'; path: string }
  | { type: 'inline'; content: string }
  | { type: 'url'; url: string };

export interface Surface {
  id: string;
  kind: SurfaceKind;
  source: SurfaceSource;
  /** 显示在 tab 头的名字, 不传走自动推断(file 的 basename / url 的 host) */
  title?: string;
  /** 钉住后新 surface 不会替换它, 用户手动关才消失. 默认 false */
  pinned?: boolean;
  /** 附加元数据 — kind-specific(比如 web 的 dev-server pid / image 的 alt) */
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/** Web surface 内部的浏览器标签页. 一个 web surface 可以有多个 tab (Chrome 风).
 *  agent 操作时用 tab.id 当 surfaceId — BrowserView 的 window.name 烙的是 tab.id.
 *  ResolvePage / listSurfaces 都通过 tab.id 找 BrowserView. */
export interface BrowserTab {
  id: string;
  url: string;
  title?: string;
  /** 当前 loading 状态 — UI 显示用 */
  loading?: boolean;
  /** 收藏 / 钉住等 UI 状态 */
  pinned?: boolean;
}

/** Web surface 的 metadata 形状 — tabs 列表 + 当前 active tab id. */
export interface WebSurfaceMetadata {
  tabs: BrowserTab[];
  activeTabId: string;
}

/** open_surface 工具返回的 marker(renderer 在 tool_result 拦截解析) */
export const SURFACE_MARKER = '__neox_surface_event__';

export interface SurfaceMarkerPayload {
  [SURFACE_MARKER]: true;
  action: 'open' | 'update' | 'close' | 'plan_op' | 'todo_replace';
  surface?: Surface;     // open / update 携带完整 spec
  surfaceId?: string;    // update / close / plan_op / todo_replace 用 id 索引
  patch?: Partial<Surface>; // update 用
  planOp?: PlanOp;       // plan_op 用
  todoItems?: TodoItem[]; // todo_replace 用 (全量替换)
  /** todo_replace 的 upsert 意图 — surfaceId 不存在时按这个规格现场建一个, 而不是静默丢弃.
   *  没有它的话 update_todos 对着不存在的 id 会"工具成功 + 界面无事发生", 模型照样报喜. */
  ensureSurface?: { kind: SurfaceKind; title?: string; pinned?: boolean };
}

/** Plan 增量 op — renderer 收到后 apply 到 surface.source.content */
export type PlanOp =
  | { kind: 'content'; content: string }
  | { kind: 'append'; text: string }
  | { kind: 'replace_section'; heading: string; content: string }
  | { kind: 'set_section_status'; heading: string; status: PlanSectionStatus }
  | { kind: 'add_note'; text: string };

/* ──────────────── Plan / Todo content types ────────────────
 * Plan 的 source.content 是 markdown 字符串(viewer 识别软标记).
 * Todo 的 source.content 是 JSON.stringify(TodoState).
 * 这两个 type 主要给 update_plan / update_todos 工具复用.
 */

/** Plan section 状态(可选, agent 用 HTML 注释 `<!-- status: done -->` 标在章节标题后) */
export type PlanSectionStatus = 'pending' | 'in_progress' | 'done';

/** Plan 内容: 自由 markdown, 不强结构 */
export interface PlanState {
  content: string;
}

/** Plan 章节状态注释标记 — viewer 用 regex 解析 */
export const PLAN_STATUS_MARKER = /<!--\s*status:\s*(pending|in_progress|done)\s*-->/i;

/** Todo item 状态 */
export type TodoStatus = 'pending' | 'in_progress' | 'done' | 'skipped';

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
}

export interface TodoState {
  items: TodoItem[];
}
