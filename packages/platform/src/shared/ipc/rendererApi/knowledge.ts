/**
 * 知识库 IPC 类型 — 知识库页面 documents.json manifest (路径引用, 不拷贝内容)
 */

export type KnowledgeDocCollection = 'default' | 'project' | 'scratch';

export interface KnowledgeDocumentStatusDTO {
  id: string;
  name: string;
  /** 原文件绝对路径 (唯一内容真源) */
  path: string;
  size: number;
  mtimeMs: number;
  collection: KnowledgeDocCollection;
  importedAt: number;
  /** 解析缓存 id (sha256) — docx/xlsx/pdf 导入时解析产出, 可缺 */
  fileId?: string;
  /** 原文件已不存在 (被移动/删除) */
  missing: boolean;
  /** 原文件比登记时新 */
  modified: boolean;
}

export interface KnowledgeDocsResult {
  ok: boolean;
  error?: string;
  documents: KnowledgeDocumentStatusDTO[];
}

export interface KnowledgeCardDTO {
  id: string;
  title: string;
  description: string;
  trust: 'verified' | 'draft';
  always: boolean;
  updated?: string;
  source?: string;
  paths?: string[];
  keywords?: string[];
  origin: 'workspace' | 'user' | 'shared';
  displayPath: string;
  bodyChars: number;
}

export interface KnowledgeCurationRun {
  sessionId: string;
  model?: string;
  trigger: 'manual' | 'auto';
  startedAt: number;
}

export interface RendererAPIKnowledge {
  // ==================== 知识库 (文档路径引用 manifest) ====================
  knowledgeListDocs: () => Promise<KnowledgeDocsResult>;
  knowledgeAddDocs: (
    docs: Array<{ path: string; collection: KnowledgeDocCollection; fileId?: string }>,
  ) => Promise<KnowledgeDocsResult & { added?: number; skipped?: number }>;
  knowledgeRemoveDoc: (id: string) => Promise<KnowledgeDocsResult>;
  // ==================== 知识条目 (卡片) ====================
  knowledgeListCards: () => Promise<{ ok: boolean; error?: string; cards: KnowledgeCardDTO[] }>;
  knowledgeReadCard: (id: string) => Promise<{ ok: boolean; error?: string; body?: string; displayPath?: string }>;
  knowledgeSetCardTrust: (id: string, trust: 'verified' | 'draft') => Promise<{ ok: boolean; error?: string }>;
  knowledgeDeleteCard: (id: string) => Promise<{ ok: boolean; error?: string }>;
  knowledgeSetCardAlways: (id: string, always: boolean) => Promise<{ ok: boolean; error?: string }>;
  knowledgeUpdateCardMeta: (id: string, updates: { description?: string; keywords?: string[] }) => Promise<{ ok: boolean; error?: string }>;
  knowledgeRefreshDoc: (id: string, newFileId?: string) => Promise<KnowledgeDocsResult>;
  // ==================== 知识库整理 (curator) ====================
  knowledgeCurationConfigGet: () => Promise<{ ok: boolean; autoCurate: boolean; lastCurateAt: number; error?: string }>;
  knowledgeCurationConfigSet: (updates: { autoCurate?: boolean; lastCurateAt?: number }) => Promise<{ ok: boolean; error?: string }>;
  knowledgeCurationLogGet: () => Promise<{ ok: boolean; runs: KnowledgeCurationRun[] }>;
  knowledgeCurationLogAppend: (entry: { sessionId: string; model?: string; trigger: 'manual' | 'auto' }) => Promise<{ ok: boolean; error?: string }>;
}
