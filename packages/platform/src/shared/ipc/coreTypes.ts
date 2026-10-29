import type { ModelRouteConfig } from './modelRouting.js';
import type { DoubaoThinkingMode } from './models.js';

export interface AgentSettings {
  sandboxEnabled: boolean;
  approvalMode: 'auto' | 'manual' | 'dangerous';
  webSearchEnabled: boolean;
  webSearchEngine: 'auto' | 'bocha' | 'serper' | 'custom';
  webSearchUrl: string;
  webSearchApiKey: string;
  javaDebugEnabled: boolean;
  javaDebugHome?: string;
  javaDebugJarPath?: string;
}

export interface ModelConfig {
  reasoning_summary: 'auto' | 'concise' | 'detailed' | 'none';
  verbosity: 'low' | 'medium' | 'high';
  web_search: 'disabled' | 'cached' | 'live';
  hide_agent_reasoning: boolean;
  context_window: number;
  auto_compact_limit: number;
  service_tier: 'auto' | 'fast' | 'flex';
}

export type Environment = 'dev' | 'prod';

export interface AppInfo {
  name: string;
  version: string;
  environment: Environment;
  platform: string;
  arch: string;
}

export interface WorkspaceState {
  /** Primary root —— runner 的 workspacePath, 持久化/会话分组的主键。单根时即唯一根。 */
  path: string;
  name: string;
  lastOpened: number;
  status: 'idle' | 'syncing';
  /**
   * 多根工作区: 本工作区包含的所有项目根目录 (有序, 含 primary `path`)。
   * 缺省 / 单根时视为 `[path]` —— 完全向后兼容, 老数据无 roots 字段时按单根渲染。
   * primary root 恒为 `path` (= roots[0] 约定)。用 `workspaceRoots()` 归一化读取。
   */
  roots?: string[];
}

/**
 * 归一化读取工作区的所有根目录: 保证返回非空有序数组, primary `path` 恒为第一个且去重。
 * 老数据 (无 roots) → `[path]`。renderer / main / runner 共用此函数, 别各写各的。
 */
export function workspaceRoots(ws: Pick<WorkspaceState, 'path' | 'roots'> | null | undefined): string[] {
  if (!ws) return [];
  const raw = Array.isArray(ws.roots) && ws.roots.length > 0 ? ws.roots : [ws.path];
  const seen = new Set<string>();
  const out: string[] = [];
  // primary 恒为第一个
  for (const p of [ws.path, ...raw]) {
    if (p && !seen.has(p)) { seen.add(p); out.push(p); }
  }
  return out;
}

/** primary root —— runner 的 workspacePath / 持久化主键。 */
export function primaryRoot(ws: Pick<WorkspaceState, 'path' | 'roots'> | null | undefined): string | null {
  return ws?.path ?? null;
}

export type InteractionMode = 'agent' | 'ask';

export interface Attachment {
  id: string;
  type: 'image' | 'url' | 'file';
  data: string;
  name?: string;
  path?: string;
  size?: number;
  /** 文件行范围 (e.g. 10-50) */
  lineRange?: { start: number; end: number };
  /** 代码内容预览 (用于 file 类型) */
  preview?: string;
  /** 文件语言 (用于语法高亮) */
  language?: string;

  /* v2 (F7+N4 Files API 范式) — 文档类附件用 fileId 引用, 不全文塞 data:
   *   · 客户端解析完拿到 fileId (sha256), 写本地缓存
   *     ~/.neox/documents/<fileId>.md
   *   · attachment.data 留空 (避免多轮对话重发全文给 LLM, 浪费 token)
   *   · agent 调 read_document(fileId) 工具按需读
   *   · 旧路径 (纯文本 readAsText) 仍走 data 字段, 兼容 */
  /** sha256(file content) — 文档类专用, agent read_document(fileId) 用 */
  fileId?: string;
  /** 解析结果前 200 字符 — 给 UI 卡片 preview 用 (不送 LLM) */
  summary?: string;
  /** markdown 总字符数 — agent 看到 metadata 判断要不要 read */
  chars?: number;
  /** 页数 (PDF/PPT) */
  pages?: number;
  /** 解析渠道 — 'mammoth' / 'xlsx' / 'pdf-parse' / 'local-xxx' 等 */
  channel?: string;
  /** 状态: 'parsing' 时 UI disable send 按钮, 'parsed' / 'failed' 完成态 */
  status?: 'parsing' | 'parsed' | 'failed';
}

export interface ChatMetadata {
  mode?: InteractionMode;
  attachments?: Attachment[];
  thinkingMode?: DoubaoThinkingMode;
  isAutoRouted?: boolean;
  routeConfig?: ModelRouteConfig;
  effortLevel?: string;
}
