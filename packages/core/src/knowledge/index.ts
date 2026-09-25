/**
 * Knowledge Base — 知识卡片系统
 *
 * 设计: docs/NEOX_KNOWLEDGE_BASE_DESIGN.md
 * 零向量零 RAG chunk — Markdown 知识卡 + 三层暴露 (L0 索引常驻 / L1 检索工具 / L2 glob 触发)。
 *
 * 用法:
 *   await knowledgeRegistry.initialize(workDir);
 *   knowledgeRegistry.watch(workDir);                    // 热重载
 *   const index = knowledgeRegistry.getIndexForPrompt(); // L0 注入
 */

export type {
  KnowledgeCard,
  KnowledgeCardMeta,
  KnowledgeOrigin,
  KnowledgeTrust,
  KnowledgeSearchHit,
} from './types.js';
export { loadCardFile, loadCardsFromDir, parseCardFrontmatter, MAX_CARD_BODY_CHARS } from './loader.js';
export {
  loadDocumentManifest,
  saveDocumentManifest,
  statDocuments,
  manifestPathFor,
  type KnowledgeDocCollection,
  type KnowledgeDocumentEntry,
  type KnowledgeDocumentStatus,
} from './documents.js';
export { extractDocumentText, MAX_DOC_TEXT_CHARS } from './docText.js';
export { KnowledgeRegistry, knowledgeRegistry } from './registry.js';
export { KnowledgeSearchEngine, tokenize, buildSnippetFromText } from './searchEngine.js';
export { KnowledgeFtsIndex, ftsIndexPathFor } from './ftsIndex.js';
