/**
 * Knowledge Base — 类型定义
 *
 * 设计: docs/NEOX_KNOWLEDGE_BASE_DESIGN.md
 *
 * 知识卡 = 一个 Markdown 文件 (frontmatter + 正文), 一张卡一个自包含主题。
 * 与 memory 域的分工: memory = agent 自动长出来的经验; knowledge = 人显式灌入的资料
 * (API 手册 / 团队规范 / 外部文档消化产物)。
 */

/** 卡片来源层级 — workspace 优先级最高 (同 id 覆盖 user/shared) */
export type KnowledgeOrigin = 'workspace' | 'user' | 'shared';

/** 可信度 — ingest/agent 写入默认 draft, 人 review 后改 verified */
export type KnowledgeTrust = 'verified' | 'draft';

export interface KnowledgeCardMeta {
  /** 卡片标题 — 进 L0 索引。缺失时按文件名兜底 */
  title: string;
  /** 一句话描述 — 进 L0 索引。缺失时取正文首个非空行兜底 */
  description: string;
  /** Source reference such as a URL or file path; ingestion requires it. */
  source?: string;
  /** L2 条件触发: agent 碰到匹配这些 glob 的文件时自动注入本卡 */
  paths?: string[];
  /** 补充检索关键词 */
  keywords?: string[];
  /** 可信度, 默认 verified (手写卡视为已 review) */
  trust?: KnowledgeTrust;
  /** 常驻注入: true = 全文进 system prompt, 不走任何触发 (合规/政策/规范类 —
   *  "错过就出事"的知识不该赌检索命中率)。人在 frontmatter 手标, agent 不可自设。 */
  always?: boolean;
  /** 最后更新日期 (YYYY-MM-DD) */
  updated?: string;
}

export interface KnowledgeCard {
  /** 卡片 id = 相对 knowledge 根目录的路径去掉 .md (如 "sheet/univer-api") */
  id: string;
  /** 绝对文件路径 */
  filePath: string;
  /** 给 LLM 看的可读路径 — workspace 卡为 workDir 相对路径, user/shared 卡为绝对路径 */
  displayPath: string;
  origin: KnowledgeOrigin;
  meta: KnowledgeCardMeta;
  /** 正文 (不含 frontmatter), 已 trim */
  body: string;
}

export interface KnowledgeSearchHit {
  card: KnowledgeCard;
  score: number;
  /** 正文首个命中处 ±N 行片段 (无正文命中时为 description) */
  snippet: string;
}
