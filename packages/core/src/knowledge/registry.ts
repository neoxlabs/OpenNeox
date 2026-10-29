
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { loadCardsFromDir } from './loader.js';
import { loadDocumentManifest, statDocuments, type KnowledgeDocumentStatus } from './documents.js';
import type { KnowledgeCard } from './types.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

/* L0 索引字符预算 — 对齐 projectMemoryV2 的分层上限风格 (设计 §2.1) */
const MAX_INDEX_CHARS = 2000;
/* 资料文件段独立预算 — 文件名+路径一行很短, 800 字符 ≈ 10-15 个文档 */
const MAX_DOCS_INDEX_CHARS = 800;
/* always 常驻卡预算 — 合规/政策类用 token 换确定性, 但仍要有闸:
 * 单卡截断 + 总量超限的卡降级为索引行 (提示用户拆卡或收敛) */
const MAX_ALWAYS_CARD_CHARS = 4000;
const MAX_ALWAYS_TOTAL_CHARS = 12000;

export class KnowledgeRegistry {
  /** id → card (workspace 覆盖 user) */
  private cards = new Map<string, KnowledgeCard>();
  /** 知识库页面登记的资料文件 (路径引用, 含实时失效状态) */
  private documents: KnowledgeDocumentStatus[] = [];
  private initialized = false;
  private initializedWorkDir: string | undefined;
  /** 每次 (re)load 自增 — 供 searchEngine 等下游缓存判断内容是否已变 */
  private _revision = 0;
  private watchers: fs.FSWatcher[] = [];
  private watchWorkDir: string | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // ==========================================================================
  // 目录
  // ==========================================================================

  getUserKnowledgeDir(): string {
    return path.join(os.homedir(), NEOX_HOME_DIRNAME, 'knowledge');
  }

  /** 一次性迁移: 把 ~/.neox/users/<uid>/knowledge/ 的卡片/文件并入全局
   *  ~/.neox/knowledge/ (同名不覆盖, 全局优先)。幂等: 并空后删掉源目录。 */
  private migratePerUserKnowledgeToGlobal(): void {
    const usersRoot = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'users');
    let buckets: string[] = [];
    try { buckets = fs.readdirSync(usersRoot); } catch { return; }
    const globalDir = this.getUserKnowledgeDir();
    for (const bucket of buckets) {
      const src = path.join(usersRoot, bucket, 'knowledge');
      let entries: string[] = [];
      try { entries = fs.readdirSync(src); } catch { continue; }
      try { fs.mkdirSync(globalDir, { recursive: true }); } catch { /* noop */ }
      let remaining = 0;
      for (const name of entries) {
        const from = path.join(src, name);
        const to = path.join(globalDir, name);
        try {
          if (fs.existsSync(to)) { remaining++; continue; } // 同名不覆盖, 留在原桶
          fs.renameSync(from, to);
        } catch {
          try { fs.cpSync(from, to, { recursive: true }); fs.rmSync(from, { recursive: true, force: true }); }
          catch { remaining++; }
        }
      }
      if (remaining === 0) {
        try { fs.rmSync(src, { recursive: true, force: true }); } catch { /* noop */ }
      }
      if (entries.length > 0) {
        cliLogger.info('KNOWLEDGE', `并桶迁移 users/${bucket}/knowledge → 全局 (${entries.length - remaining}/${entries.length} 项)`);
      }
    }
  }

  getWorkspaceKnowledgeDir(workDir: string): string {
    return path.join(workDir, '.neox', 'knowledge');
  }

  // ==========================================================================
  // 加载
  // ==========================================================================

  async initialize(workDir?: string): Promise<void> {
    if (this.initialized && this.initializedWorkDir === workDir) return;
    this.cards.clear();

    this.migratePerUserKnowledgeToGlobal();

    /* 先 user 后 workspace — 后注册的同 id 覆盖 */
    for (const card of loadCardsFromDir(this.getUserKnowledgeDir(), 'user', workDir)) {
      this.cards.set(card.id, card);
    }
    if (workDir) {
      for (const card of loadCardsFromDir(this.getWorkspaceKnowledgeDir(workDir), 'workspace', workDir)) {
        this.cards.set(card.id, card);
      }
    }

    /* 资料文件 manifest (知识库页面登记的原文件引用) — user 级 + workspace 级 */
    const entries = [
      ...loadDocumentManifest(this.getUserKnowledgeDir()),
      ...(workDir ? loadDocumentManifest(this.getWorkspaceKnowledgeDir(workDir)) : []),
    ];
    this.documents = statDocuments(entries);

    this.initialized = true;
    this.initializedWorkDir = workDir;
    this._revision++;
    if (this.cards.size > 0 || this.documents.length > 0) {
      cliLogger.info('KNOWLEDGE', `Loaded ${this.cards.size} knowledge cards, ${this.documents.length} documents`);
    }
  }

  get revision(): number {
    return this._revision;
  }

  async refresh(workDir?: string): Promise<void> {
    this.initialized = false;
    await this.initialize(workDir ?? this.initializedWorkDir);
  }

  // ==========================================================================
  // 热重载 (仿 skills registry watch)
  // ==========================================================================

  watch(workDir?: string): void {
    this.watchWorkDir = workDir ?? this.initializedWorkDir;
    const dirs = [
      this.getUserKnowledgeDir(),
      ...(this.watchWorkDir ? [this.getWorkspaceKnowledgeDir(this.watchWorkDir)] : []),
    ];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const watcher = fs.watch(dir, { recursive: true }, () => this.scheduleRefresh());
        this.watchers.push(watcher);
      } catch (err: any) {
        cliLogger.debug('KNOWLEDGE', `fs.watch not supported: ${err?.message}`);
      }
    }
  }

  stopWatch(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private scheduleRefresh(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(async () => {
      try {
        await this.refresh(this.watchWorkDir);
      } catch (err: any) {
        cliLogger.debug('KNOWLEDGE', `Knowledge refresh failed: ${err?.message}`);
      }
    }, 500);
  }

  // ==========================================================================
  // 查询
  // ==========================================================================

  get size(): number {
    return this.cards.size;
  }

  getAll(): KnowledgeCard[] {
    return Array.from(this.cards.values());
  }

  getCard(id: string): KnowledgeCard | undefined {
    return this.cards.get(id);
  }

  getDocuments(): KnowledgeDocumentStatus[] {
    return this.documents.slice();
  }

  // ==========================================================================
  // L0 索引
  // ==========================================================================

  /**
   * 生成注入 system prompt 的知识库索引。空库返回 ''。
   * 排序: verified 优先 > workspace 优先 > id 字典序 (稳定输出, cache 友好)。
   */
  getIndexForPrompt(language: 'zh' | 'en' = 'zh'): string {
    const availableDocs = this.documents.filter((d) => !d.missing);
    if (this.cards.size === 0 && availableDocs.length === 0) return '';

    const sorted = this.getAll().sort((a, b) => {
      const trustA = a.meta.trust === 'draft' ? 1 : 0;
      const trustB = b.meta.trust === 'draft' ? 1 : 0;
      if (trustA !== trustB) return trustA - trustB;
      const originA = a.origin === 'workspace' ? 0 : 1;
      const originB = b.origin === 'workspace' ? 0 : 1;
      if (originA !== originB) return originA - originB;
      return a.id.localeCompare(b.id);
    });

    const header =
      language === 'en'
        ? '## Knowledge Base\nThis index IS the complete listing of the knowledge base — answer "what\'s in my knowledge base" directly from it, no tool calls needed. For entry details, read the path with readfile; use knowledge_search only for content lookup.\nIf this session verified reusable domain knowledge (external API behavior, library pitfalls, team conventions), suggest saving it with knowledge_add — ask the user first.'
        : '## Knowledge Base\n以下就是知识库的完整清单 — 回答"知识库里有什么"直接依据本索引, 不需要调用任何工具。需要某条内容的细节时用 readfile 读对应路径; knowledge_search 只用于按关键词查正文。\n若本次会话验证了有复用价值的领域知识 (外部 API 行为、库的坑、团队约定), 主动建议用 knowledge_add 沉淀 — 先征得用户同意。';

    /* always 卡全文注入 (下方专段), 不进索引列表 — 避免双份 */
    const alwaysCards = sorted.filter((c) => c.meta.always);
    const listCards = sorted.filter((c) => !c.meta.always);

    const lines: string[] = [header];
    let used = header.length;
    let listed = 0;

    for (const card of listCards) {
      const draftMark = card.meta.trust === 'draft' ? (language === 'en' ? ' (draft)' : ' (草稿)') : '';
      const line = `- [${card.meta.title}](${card.displayPath}) — ${card.meta.description}${draftMark}`;
      if (used + line.length + 1 > MAX_INDEX_CHARS) break;
      lines.push(line);
      used += line.length + 1;
      listed++;
    }

    const remaining = listCards.length - listed;
    if (remaining > 0) {
      lines.push(
        language === 'en'
          ? `… ${remaining} more entries not listed — use knowledge_search to find them.`
          : `… 还有 ${remaining} 条知识未列出, 用 knowledge_search 检索。`,
      );
    }

    /* 常驻知识段 — always: true 的卡全文注入, 不走任何触发 (合规/政策类)。
     * 单卡超限截断并给全文路径; 总预算满后降级为索引行。 */
    if (alwaysCards.length > 0) {
      lines.push(
        language === 'en'
          ? '### Always-on knowledge (full content, always in effect)'
          : '### 常驻知识 (全文, 始终生效)',
      );
      let alwaysUsed = 0;
      for (const card of alwaysCards) {
        let body = card.body;
        if (body.length > MAX_ALWAYS_CARD_CHARS) {
          body =
            body.slice(0, MAX_ALWAYS_CARD_CHARS) +
            (language === 'en'
              ? `\n…(truncated — full content: ${card.displayPath})`
              : `\n…(已截断 — 全文: ${card.displayPath})`);
        }
        if (alwaysUsed + body.length > MAX_ALWAYS_TOTAL_CHARS) {
          /* 预算满 — 降级为索引行, 至少保住可发现性 */
          lines.push(`- [${card.meta.title}](${card.displayPath}) — ${card.meta.description}`);
          continue;
        }
        lines.push(`#### ${card.meta.title} (${card.displayPath})`);
        lines.push(body);
        alwaysUsed += body.length;
      }
    }

    /* 资料文件段 — 知识库页面登记的原文件 (路径引用)。agent 用 readfile/pdf/word
     * 工具直接读原路径; 消化成卡片是可选升级。missing 的不列 (免得 agent 撞 404)。 */
    if (availableDocs.length > 0) {
      const docsHeader =
        language === 'en'
          ? '### Documents (user-registered source files — read the original path directly with readfile/pdf/word tools)'
          : '### 资料文件 (用户登记的原文件 — 用 readfile/pdf/word 工具直接读原路径)';
      lines.push(docsHeader);
      let docsUsed = docsHeader.length;
      let docsListed = 0;
      /* 稳定排序: project 集合优先 (跟当前工作区最相关), 再按名字 */
      const docsSorted = availableDocs.slice().sort((a, b) => {
        const pa = a.collection === 'project' ? 0 : 1;
        const pb = b.collection === 'project' ? 0 : 1;
        if (pa !== pb) return pa - pb;
        return a.name.localeCompare(b.name);
      });
      for (const doc of docsSorted) {
        const modMark = doc.modified ? (language === 'en' ? ' (updated since import)' : ' (导入后有更新)') : '';
        const line = `- ${doc.name} — ${doc.path}${modMark}`;
        if (docsUsed + line.length + 1 > MAX_DOCS_INDEX_CHARS) break;
        lines.push(line);
        docsUsed += line.length + 1;
        docsListed++;
      }
      const docsRemaining = docsSorted.length - docsListed;
      if (docsRemaining > 0) {
        lines.push(
          language === 'en'
            ? `… ${docsRemaining} more documents registered — find them by filename or content with knowledge_search.`
            : `… 还有 ${docsRemaining} 个已登记文档, 用 knowledge_search 按文件名或内容检索。`,
        );
      }
    }

    if (lines.length <= 1) return '';
    return lines.join('\n');
  }
}

// 单例
export const knowledgeRegistry = new KnowledgeRegistry();

