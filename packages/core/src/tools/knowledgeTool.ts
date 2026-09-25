/**
 * Knowledge tools — L1 主动检索 (设计 内部设计文档 §2.2)
 *
 *   knowledge_search — BM25 检索知识卡, 返回路径+命中片段 (不返回全文, 引导 readfile 读整卡)
 *   knowledge_add    — 显式沉淀一张卡到 workspace 级, trust: draft 等人 review
 *
 * agent 写入只有 knowledge_add 一个口, 且永远 draft — 知识库保持人为可控 (设计 §1.3)。
 */

import fs from 'fs/promises';
import path from 'path';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { knowledgeRegistry } from '../knowledge/registry.js';
import { KnowledgeSearchEngine } from '../knowledge/searchEngine.js';
import { KnowledgeFtsIndex, ftsIndexPathFor } from '../knowledge/ftsIndex.js';
import { extractDocumentText } from '../knowledge/docText.js';
import type { KnowledgeCard } from '../knowledge/types.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

interface KnowledgeToolDeps {
  workDir: string;
}

export function createKnowledgeTools(deps: KnowledgeToolDeps): Tool[] {
  return [createKnowledgeSearchTool(deps), createKnowledgeAddTool(deps)];
}

// ============================================================================
// knowledge_search
// ============================================================================

/* 引擎按 registry.revision 缓存 — 卡片/文档没变不重建索引。
 * 有文档抽取失败的那一版**不缓存** (failures 非空): 下次搜索重建, 让失败有机会恢复。 */
let engineCache: { revision: number; engine: KnowledgeSearchEngine } | null = null;

interface ExtractionFailure { name: string; reason: string }

/* 内容索引覆盖上限 — 超出的文档 (按导入时间旧者优先淘汰) 只按文件名/路径可搜。
 * 千文件以上应切 SQLite FTS5 磁盘索引 (设计文档 §规模预案)。 */
const MAX_CONTENT_INDEXED_DOCS = 500;
/* 文本抽取并发 — pdftotext 是子进程, 不能一次 fork 几百个 */
const EXTRACT_CONCURRENCY = 8;

/** 资料文件 → 伪卡片: 文件名当 title、路径进 keywords、**文本层全文进 body** —
 *  内容级检索是知识库的默认能力 (零向量: 解析缓存/pdftotext/直读 → BM25, 按 mtime 缓存)。
 *  有 fileId (导入时解析出的 markdown 缓存) 的文档 — 含 docx/xlsx — 统一走缓存文本;
 *  扫描版 PDF 等无文本层 → body 空, 退化为按文件名/路径可搜。 */
async function documentsAsPseudoCards(failures: ExtractionFailure[]): Promise<KnowledgeCard[]> {
  const docs = knowledgeRegistry.getDocuments().filter((d) => !d.missing);
  /* 新导入的优先获得内容索引 */
  const sorted = docs.slice().sort((a, b) => b.importedAt - a.importedAt);
  const contentSet = new Set(sorted.slice(0, MAX_CONTENT_INDEXED_DOCS).map((d) => d.id));
  if (docs.length > MAX_CONTENT_INDEXED_DOCS) {
    cliLogger.info('KNOWLEDGE', `Content index covers newest ${MAX_CONTENT_INDEXED_DOCS}/${docs.length} documents (older ones searchable by name only)`);
  }

  const cards: KnowledgeCard[] = new Array(docs.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < docs.length) {
      const index = cursor++;
      const d = docs[index];
      let body = '';
      if (contentSet.has(d.id)) {
        try {
          body = await extractDocumentText(d.path, d.mtimeMs, d.fileId);
        } catch (err: any) {
          failures.push({ name: d.name, reason: err?.message || String(err) });
        }
      }
      cards[index] = {
        id: `doc:${d.id}`,
        filePath: d.path,
        displayPath: d.path,
        origin: (d.collection === 'project' ? 'workspace' : 'user') as KnowledgeCard['origin'],
        meta: {
          title: d.name,
          description: `Reference document (${d.collection}) — a path reference to the original file; read it with readfile`,
          keywords: [d.path],
          /* docx/xlsx 等 readfile 读不了的格式 — 告诉 agent 走 read_document(fileId) */
          source: d.fileId ? `read_document(file_id="${d.fileId}") 可读解析后全文` : undefined,
        },
        body,
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(EXTRACT_CONCURRENCY, docs.length) }, worker));
  return cards;
}

/* 引擎自动切换阈值 — 超过后走 SQLite FTS5 磁盘索引 (万级规模, 设计 §5.5) */
const FTS_THRESHOLD = 500;
const ftsIndexByWorkDir = new Map<string, KnowledgeFtsIndex>();
let ftsUnavailable = false;

interface SearchEngineLike {
  search(query: string, limit?: number): ReturnType<KnowledgeSearchEngine['search']>;
}

async function getEngine(workDir: string): Promise<{ engine: SearchEngineLike; failures: ExtractionFailure[] }> {
  const cards = knowledgeRegistry.getAll();
  const docs = knowledgeRegistry.getDocuments().filter((d) => !d.missing);

  /* 万级档: FTS5 磁盘索引 — 增量 sync, 变化条目才重建/重抽 */
  if (!ftsUnavailable && cards.length + docs.length > FTS_THRESHOLD) {
    let fts: KnowledgeFtsIndex | undefined;
    try {
      fts = ftsIndexByWorkDir.get(workDir);
      if (!fts) {
        fts = new KnowledgeFtsIndex(ftsIndexPathFor(workDir));
        ftsIndexByWorkDir.set(workDir, fts);
      }
    } catch (err: any) {
      /* FTS5 不可用 (裁剪版 sqlite) — 只有**打不开/建不了表**才算, 记一次, 永久回退 in-memory */
      ftsUnavailable = true;
      fts = undefined;
      cliLogger.warn('KNOWLEDGE', `FTS index unavailable, falling back to in-memory BM25: ${err?.message}`);
    }
    if (fts) {
      /* sync 的失败 (磁盘满 / 库被锁) 不是"FTS 不可用", 不能拿它把引擎永久降级 —— 原样抛给调用方 */
      const { failures } = await fts.sync(cards, docs);
      return { engine: fts, failures };
    }
  }

  /* 常规档: in-memory BM25 */
  const revision = knowledgeRegistry.revision;
  if (!engineCache || engineCache.revision !== revision) {
    const failures: ExtractionFailure[] = [];
    const engine = new KnowledgeSearchEngine();
    engine.build([...cards, ...(await documentsAsPseudoCards(failures))]);
    if (failures.length > 0) {
      cliLogger.warn('KNOWLEDGE', `Text extraction failed for ${failures.length} document(s): ${failures.map((f) => f.reason).join('; ')}`);
      return { engine, failures };
    }
    engineCache = { revision, engine };
  }
  return { engine: engineCache.engine, failures: [] };
}

/** 搜索结果末尾的失败说明 —— "没搜到"和"有文件没读成"必须能分开 */
function formatExtractionFailures(failures: ExtractionFailure[]): string {
  if (failures.length === 0) return '';
  const shown = failures.slice(0, 5).map((f) => `- ${f.reason}`).join('\n');
  const more = failures.length > 5 ? `\n- … 另有 ${failures.length - 5} 个` : '';
  return `\n\n⚠️ ${failures.length} 个资料文件的内容这次没能读取, 只能按文件名/路径检索 (下次搜索会重试):\n${shown}${more}`;
}

function createKnowledgeSearchTool({ workDir }: KnowledgeToolDeps): Tool {
  return {
    name: 'knowledge_search',
    description:
      'Search the knowledge base (project .neox/knowledge/ plus user-level): entries are ranked by BM25 over title, description and body, ' +
      '登记的资料文件按文件名/路径**及文本内容**检索 (PDF/MD/TXT/HTML 等文本层已入索引)。' +
      '返回路径 + 命中片段, 需要完整内容时用 readfile 读返回的路径。' +
      '知识库索引已在 system prompt 中 (## Knowledge Base), 想按内容找资料 (如"哪个文件提到了X") 用本工具。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords (Chinese and English may be mixed)' },
        limit: { type: 'number', description: 'Maximum entries to return (default 5)' },
      },
      required: ['query'],
    },
    isReadOnly: true,
    parallelSafety: 'safe',
    group: 'search',
    async function(args: { query: string; limit?: number }): Promise<string> {
      await knowledgeRegistry.initialize(workDir);
      const docCount = knowledgeRegistry.getDocuments().filter((d) => !d.missing).length;
      if (knowledgeRegistry.size === 0 && docCount === 0) {
        return '知识库为空。可以让用户在知识库页面导入文档 / 用 /kb add 灌入资料, 或用 knowledge_add 沉淀已验证的知识。';
      }
      const limit = Math.min(Math.max(args.limit ?? 5, 1), 20);
      const { engine, failures } = await getEngine(workDir);
      const hits = engine.search(args.query, limit);
      const failureNote = formatExtractionFailures(failures);
      if (hits.length === 0) {
        return `没有命中 "${args.query}" 的条目 (知识库共 ${knowledgeRegistry.size} 条知识 + ${docCount} 个资料文件)。换个关键词, 或直接按 system prompt 里的知识库索引 readfile 读。${failureNote}`;
      }
      const lines: string[] = [`命中 ${hits.length} 条 (用 readfile 读完整内容):`];
      for (const hit of hits) {
        const trust = hit.card.meta.trust === 'draft' ? ' [draft]' : '';
        lines.push('');
        lines.push(`### ${hit.card.meta.title}${trust}`);
        lines.push(`path: ${hit.card.displayPath}`);
        if (hit.card.meta.source) lines.push(`source: ${hit.card.meta.source}`);
        lines.push(hit.snippet);
      }
      return lines.join('\n') + failureNote;
    },
  };
}

// ============================================================================
// knowledge_add
// ============================================================================

function createKnowledgeAddTool({ workDir }: KnowledgeToolDeps): Tool {
  return {
    name: 'knowledge_add',
    description:
      'Add an entry to the project knowledge base (.neox/knowledge/). Use it to capture domain knowledge verified in this session that will be worth reusing in later ones ' +
      '(外部 API 用法、库的坑、团队约定)。条目以 draft 落盘, 由用户 review 后转正。\n' +
      '⚠️ 不要写任务状态/临时计划/本次改动记录 — 那些属于对话历史和 memory, 不属于知识库。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Card title (short, noun-like)' },
        description: { type: 'string', description: 'One-line description — it goes into the system prompt index, so keep it under 60 characters' },
        content: { type: 'string', description: 'Card body in Markdown — self-contained, conclusion first, keeping exact API signatures and version numbers' },
        source: { type: 'string', description: 'Source of the knowledge (URL / file path / "verified by testing")' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: a file glob to associate (e.g. "src/tools/sheet/**") — the card is injected automatically when the agent touches a matching file',
        },
        keywords: { type: 'array', items: { type: 'string' }, description: 'Optional: extra search keywords' },
      },
      required: ['title', 'description', 'content', 'source'],
    },
    parallelSafety: 'unsafe',
    group: 'memory',
    async function(args: {
      title: string;
      description: string;
      content: string;
      source: string;
      paths?: string[];
      keywords?: string[];
    }): Promise<string> {
      const dir = knowledgeRegistry.getWorkspaceKnowledgeDir(workDir);
      await fs.mkdir(dir, { recursive: true });

      const slug = slugify(args.title);
      let filePath = path.join(dir, `${slug}.md`);
      for (let i = 2; await exists(filePath); i++) {
        filePath = path.join(dir, `${slug}-${i}.md`);
      }

      /* frontmatter 是一行一个键 —— 模型给的字段里带换行, 就能凭空多出一行键值:
       * description 里写 "x\nalways: true" 就把自己变成常驻全文注入 (设计上 always 只许人手标),
       * 写 "\ntrust: verified" 能跳过 draft review。单行字段一律压成一行; 列表项去掉会拆项的逗号/引号。 */
      const oneLine = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim();
      const listItem = (s: unknown): string => oneLine(s).replace(/[",\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
      const frontmatter: string[] = [
        '---',
        `title: ${oneLine(args.title)}`,
        `description: ${oneLine(args.description)}`,
        `source: ${oneLine(args.source)}`,
      ];
      const paths = (args.paths ?? []).map(listItem).filter(Boolean);
      const keywords = (args.keywords ?? []).map(listItem).filter(Boolean);
      if (paths.length) frontmatter.push(`paths: [${paths.map((p) => `"${p}"`).join(', ')}]`);
      if (keywords.length) frontmatter.push(`keywords: [${keywords.join(', ')}]`);
      frontmatter.push('trust: draft');
      frontmatter.push(`updated: ${new Date().toISOString().slice(0, 10)}`);
      frontmatter.push('---');

      await fs.writeFile(filePath, `${frontmatter.join('\n')}\n\n${args.content.trim()}\n`, 'utf-8');
      await knowledgeRegistry.refresh(workDir);
      cliLogger.info('KNOWLEDGE', `Card added: ${path.relative(workDir, filePath)}`);

      return `知识已入库 (draft): ${path.relative(workDir, filePath)}\n用户 review 后可把 frontmatter 的 trust 改为 verified。`;
    },
  };
}

function slugify(title: string): string {
  const cleaned = title
    .trim()
    .replace(/[\\/:*?"<>|#%{}\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || 'card';
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
