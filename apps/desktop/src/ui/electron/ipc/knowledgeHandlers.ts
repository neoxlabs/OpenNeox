/**
 * Knowledge IPC — 知识库页面 ↔ documents.json manifest
 *
 * 页面导入的文档**只登记原文件路径引用, 不拷贝内容** (设计 NEOX_KNOWLEDGE_BASE_DESIGN.md):
 *   default / scratch 集合 → 用户级 ~/.neox[/users/<uid>]/knowledge/documents.json
 *   project 集合          → {workspace}/.neox/knowledge/documents.json
 *
 * agent 侧 KnowledgeRegistry 加载同一份 manifest → 文档进 L0 索引, readfile/pdf/word
 * 直接读原路径 — 页面导入完 agent 立即可用, 没有第二套存储。
 */

import { ipcMain } from './ipcMainBridged.js';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig, saveConfig } from '@neoxlabs/platform/utils/config.js';
import {
  knowledgeRegistry,
  loadDocumentManifest,
  saveDocumentManifest,
  statDocuments,
  type KnowledgeDocCollection,
  type KnowledgeDocumentEntry,
  type KnowledgeDocumentStatus,
} from '@neoxlabs/core/knowledge/index.js';
import type { ProjectManager } from '../context/ProjectManager.js';
import { makeWorkspaceResolver } from './scopeResolvers.js';

interface RegisterKnowledgeIpcHandlersOptions {
  projectManager: ProjectManager;
}

interface AddDocInput {
  path: string;
  collection: KnowledgeDocCollection;
  /** 解析缓存 id (sha256) — renderer 导入时经 documentParseClient 解析产出, 可缺 */
  fileId?: string;
}

function isUserCollection(collection: KnowledgeDocCollection): boolean {
  return collection === 'default' || collection === 'scratch';
}

export function registerKnowledgeIpcHandlers(options: RegisterKnowledgeIpcHandlersOptions): void {
  const workspaceOf = makeWorkspaceResolver(options.projectManager);

  const manifestDirFor = (collection: KnowledgeDocCollection, workspacePath?: string): string | null => {
    if (isUserCollection(collection)) return knowledgeRegistry.getUserKnowledgeDir();
    return workspacePath ? knowledgeRegistry.getWorkspaceKnowledgeDir(workspacePath) : null;
  };

  const listAll = (workspacePath?: string): KnowledgeDocumentStatus[] => {
    const entries = [
      ...loadDocumentManifest(knowledgeRegistry.getUserKnowledgeDir()),
      ...(workspacePath
        ? loadDocumentManifest(knowledgeRegistry.getWorkspaceKnowledgeDir(workspacePath))
        : []),
    ];
    return statDocuments(entries);
  };

  /** 页面加载文档列表 (含 missing/modified 实时状态) */
  ipcMain.handle('knowledge:list-docs', async (event) => {
    try {
      return { ok: true, documents: listAll(workspaceOf(event)) };
    } catch (error: any) {
      return { ok: false, error: error?.message ?? String(error), documents: [] };
    }
  });

  /** 登记文档 (绝对路径引用)。按 (collection, path) 去重, 返回最新全量列表。 */
  ipcMain.handle('knowledge:add-docs', async (event, docs: AddDocInput[]) => {
    try {
      const workspacePath = workspaceOf(event);
      const valid = (Array.isArray(docs) ? docs : []).filter(
        (d) => d && typeof d.path === 'string' && path.isAbsolute(d.path),
      );
      let added = 0;
      let skipped = 0;

      /* 按目标 manifest 分组写, 避免同一文件反复读写 */
      const byDir = new Map<string, AddDocInput[]>();
      for (const doc of valid) {
        const dir = manifestDirFor(doc.collection, workspacePath);
        if (!dir) {
          skipped++;
          continue;
        }
        const list = byDir.get(dir) ?? [];
        list.push(doc);
        byDir.set(dir, list);
      }

      for (const [dir, incoming] of byDir) {
        const existing = loadDocumentManifest(dir);
        const seen = new Set(existing.map((e) => `${e.collection}:${e.path}`));
        const additions: KnowledgeDocumentEntry[] = [];
        for (const doc of incoming) {
          if (seen.has(`${doc.collection}:${doc.path}`)) {
            skipped++;
            continue;
          }
          let stat: fs.Stats;
          try {
            stat = fs.statSync(doc.path);
          } catch {
            skipped++; /* 拿到路径但文件读不到 (权限/已删) — 不登记坏引用 */
            continue;
          }
          if (!stat.isFile()) {
            skipped++;
            continue;
          }
          seen.add(`${doc.collection}:${doc.path}`);
          additions.push({
            id: randomUUID(),
            name: path.basename(doc.path),
            path: doc.path,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            collection: doc.collection,
            importedAt: Date.now(),
            ...(typeof doc.fileId === 'string' && /^[a-f0-9]{64}$/.test(doc.fileId)
              ? { fileId: doc.fileId }
              : {}),
          });
          added++;
        }
        if (additions.length > 0) {
          saveDocumentManifest(dir, [...additions, ...existing]);
        }
      }

      /* registry 热重载: manifest 在 knowledge 目录内, fs.watch 会触发 refresh;
       * 这里再主动 refresh 一次兜底 (目录首次创建时 watcher 可能还没挂上)。 */
      await knowledgeRegistry.refresh(workspacePath).catch(() => {});

      return { ok: true, added, skipped, documents: listAll(workspacePath) };
    } catch (error: any) {
      return { ok: false, error: error?.message ?? String(error), documents: [] };
    }
  });

  /* ==================== 知识条目 (卡片) — 列表 / 读取 / 转正 / 删除 ==================== */

  ipcMain.handle('knowledge:list-cards', async (event) => {
    try {
      const workspacePath = workspaceOf(event);
      /* refresh 而非 initialize — agent/整理会话刚写的条目要立即可见 */
      await knowledgeRegistry.refresh(workspacePath);
      const cards = knowledgeRegistry.getAll().map((c) => ({
        id: c.id,
        title: c.meta.title,
        description: c.meta.description,
        trust: c.meta.trust ?? 'verified',
        always: c.meta.always === true,
        updated: c.meta.updated,
        source: c.meta.source,
        paths: c.meta.paths,
        keywords: c.meta.keywords,
        origin: c.origin,
        displayPath: c.displayPath,
        bodyChars: c.body.length,
      }));
      return { ok: true, cards };
    } catch (error: any) {
      return { ok: false, error: error?.message ?? String(error), cards: [] };
    }
  });

  ipcMain.handle('knowledge:read-card', async (event, id: string) => {
    try {
      await knowledgeRegistry.initialize(workspaceOf(event));
      const card = knowledgeRegistry.getCard(String(id));
      if (!card) return { ok: false, error: 'card not found' };
      return { ok: true, body: card.body, displayPath: card.displayPath };
    } catch (error: any) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  });

  /** frontmatter 补丁 — value=null 删除该键, 其余设置/替换。真源是文件。 */
  const patchCardFrontmatter = async (
    event: Electron.IpcMainInvokeEvent,
    id: string,
    patch: Record<string, string | null>,
  ): Promise<{ ok: boolean; error?: string }> => {
    const workspacePath = workspaceOf(event);
    await knowledgeRegistry.initialize(workspacePath);
    const card = knowledgeRegistry.getCard(String(id));
    if (!card) return { ok: false, error: 'card not found' };
    let raw = fs.readFileSync(card.filePath, 'utf-8');
    const m = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    let fm = m ? m[1] : '';
    for (const [key, value] of Object.entries(patch)) {
      const lineRe = new RegExp(`^${key}:.*$`, 'm');
      if (value === null) {
        fm = fm.replace(new RegExp(`^${key}:.*\\n?`, 'm'), '').replace(/\n$/, '');
      } else if (lineRe.test(fm)) {
        fm = fm.replace(lineRe, `${key}: ${value}`);
      } else {
        fm = fm ? `${fm}\n${key}: ${value}` : `${key}: ${value}`;
      }
    }
    raw = m ? raw.replace(m[0], `---\n${fm}\n---`) : `---\n${fm}\n---\n\n${raw}`;
    fs.writeFileSync(card.filePath, raw, 'utf-8');
    await knowledgeRegistry.refresh(workspacePath);
    return { ok: true };
  };

  /** draft ↔ verified */
  ipcMain.handle('knowledge:set-card-trust', async (event, id: string, trust: 'verified' | 'draft') => {
    try {
      if (trust !== 'verified' && trust !== 'draft') return { ok: false, error: 'invalid trust' };
      return await patchCardFrontmatter(event, id, { trust });
    } catch (error: any) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  });

  /** 常驻开关 — 只允许用户从 UI 设置 (agent 无此工具) */
  ipcMain.handle('knowledge:set-card-always', async (event, id: string, always: boolean) => {
    try {
      return await patchCardFrontmatter(event, id, { always: always ? 'true' : null });
    } catch (error: any) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  });

  /** 行内编辑 description / keywords — 检索命中率的运营入口 */
  ipcMain.handle('knowledge:update-card-meta', async (event, id: string, updates: { description?: string; keywords?: string[] }) => {
    try {
      const patch: Record<string, string | null> = {};
      if (typeof updates?.description === 'string' && updates.description.trim()) {
        patch.description = updates.description.trim().replace(/\n/g, ' ');
      }
      if (Array.isArray(updates?.keywords)) {
        const kws = updates.keywords.map((k) => String(k).trim()).filter(Boolean);
        patch.keywords = kws.length > 0 ? `[${kws.join(', ')}]` : null;
      }
      if (Object.keys(patch).length === 0) return { ok: false, error: 'nothing to update' };
      return await patchCardFrontmatter(event, id, patch);
    } catch (error: any) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  });

  ipcMain.handle('knowledge:delete-card', async (event, id: string) => {
    try {
      const workspacePath = workspaceOf(event);
      await knowledgeRegistry.initialize(workspacePath);
      const card = knowledgeRegistry.getCard(String(id));
      if (!card) return { ok: false, error: 'card not found' };
      fs.rmSync(card.filePath);
      await knowledgeRegistry.refresh(workspacePath);
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  });

  /* ==================== 整理 (curation) — 配置 + 运行日志 ==================== */

  /** 自动整理配置存核心 config (跨进程三方合并锁已固化, CLI/桌面都能读) */
  ipcMain.handle('knowledge:curation-config-get', async () => {
    try {
      const config = loadConfig() as any;
      return {
        ok: true,
        autoCurate: config.knowledge?.autoCurate === true,
        lastCurateAt: typeof config.knowledge?.lastCurateAt === 'number' ? config.knowledge.lastCurateAt : 0,
      };
    } catch (error: any) {
      return { ok: false, error: error?.message ?? String(error), autoCurate: false, lastCurateAt: 0 };
    }
  });

  ipcMain.handle('knowledge:curation-config-set', async (_event, updates: { autoCurate?: boolean; lastCurateAt?: number }) => {
    try {
      const config = loadConfig() as any;
      const knowledge = { ...(config.knowledge ?? {}) };
      if (typeof updates?.autoCurate === 'boolean') knowledge.autoCurate = updates.autoCurate;
      if (typeof updates?.lastCurateAt === 'number') knowledge.lastCurateAt = updates.lastCurateAt;
      saveConfig({ ...config, knowledge });
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  });

  /** 运行日志: {workspace}/.neox/knowledge/_meta/curation-log.json (loader 跳过 _ 前缀目录, 不会被当条目) */
  const curationLogPath = (workspacePath: string) =>
    path.join(knowledgeRegistry.getWorkspaceKnowledgeDir(workspacePath), '_meta', 'curation-log.json');

  const readCurationLog = (workspacePath: string): any[] => {
    try {
      const parsed = JSON.parse(fs.readFileSync(curationLogPath(workspacePath), 'utf-8'));
      const raw = Array.isArray(parsed?.runs) ? parsed.runs : [];
      const MIN_TS = 1577836800000;
      const maxTs = Date.now() + 24 * 3600 * 1000;
      return raw.filter(
        (r: any) =>
          r &&
          typeof r.sessionId === 'string' &&
          r.sessionId &&
          Number.isFinite(r.startedAt) &&
          r.startedAt > MIN_TS &&
          r.startedAt < maxTs,
      ).map((r: any) => ({
        sessionId: r.sessionId,
        model: typeof r.model === 'string' ? r.model : undefined,
        trigger: r.trigger === 'auto' ? 'auto' : 'manual',
        startedAt: r.startedAt,
      }));
    } catch {
      return [];
    }
  };

  ipcMain.handle('knowledge:curation-log-get', async (event) => {
    const workspacePath = workspaceOf(event);
    if (!workspacePath) return { ok: true, runs: [] };
    return { ok: true, runs: readCurationLog(workspacePath).slice(0, 20) };
  });

  ipcMain.handle('knowledge:curation-log-append', async (event, entry: { sessionId: string; model?: string; trigger: 'manual' | 'auto' }) => {
    try {
      const workspacePath = workspaceOf(event);
      if (!workspacePath || !entry?.sessionId) return { ok: false, error: 'no workspace or sessionId' };
      const runs = readCurationLog(workspacePath);
      runs.unshift({
        sessionId: String(entry.sessionId),
        model: typeof entry.model === 'string' ? entry.model : undefined,
        trigger: entry.trigger === 'auto' ? 'auto' : 'manual',
        startedAt: Date.now(),
      });
      const p = curationLogPath(workspacePath);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ version: 1, runs: runs.slice(0, 50) }, null, 2), 'utf-8');
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  });

  /** 「有更新」文档同步: 重 stat 原文件更新 mtime/size (docText 按新 mtime 自动重抽);
   *  docx 等靠解析缓存的格式可带新 fileId (renderer 重跑 parseDocument 后传入)。 */
  ipcMain.handle('knowledge:refresh-doc', async (event, id: string, newFileId?: string) => {
    try {
      const workspacePath = workspaceOf(event);
      const dirs = [
        knowledgeRegistry.getUserKnowledgeDir(),
        ...(workspacePath ? [knowledgeRegistry.getWorkspaceKnowledgeDir(workspacePath)] : []),
      ];
      for (const dir of dirs) {
        const entries = loadDocumentManifest(dir);
        const entry = entries.find((e) => e.id === id);
        if (!entry) continue;
        const stat = fs.statSync(entry.path); /* missing 时抛错 → 走 catch 报给页面 */
        entry.size = stat.size;
        entry.mtimeMs = stat.mtimeMs;
        if (typeof newFileId === 'string' && /^[a-f0-9]{64}$/.test(newFileId)) {
          entry.fileId = newFileId;
        }
        saveDocumentManifest(dir, entries);
        break;
      }
      await knowledgeRegistry.refresh(workspacePath).catch(() => {});
      return { ok: true, documents: listAll(workspacePath) };
    } catch (error: any) {
      return { ok: false, error: error?.message ?? String(error), documents: [] };
    }
  });

  /** 删除登记 (只删引用, 永远不动原文件) */
  ipcMain.handle('knowledge:remove-doc', async (event, id: string) => {
    try {
      const workspacePath = workspaceOf(event);
      const dirs = [
        knowledgeRegistry.getUserKnowledgeDir(),
        ...(workspacePath ? [knowledgeRegistry.getWorkspaceKnowledgeDir(workspacePath)] : []),
      ];
      for (const dir of dirs) {
        const entries = loadDocumentManifest(dir);
        const next = entries.filter((e) => e.id !== id);
        if (next.length !== entries.length) {
          saveDocumentManifest(dir, next);
          break;
        }
      }
      await knowledgeRegistry.refresh(workspacePath).catch(() => {});
      return { ok: true, documents: listAll(workspacePath) };
    } catch (error: any) {
      return { ok: false, error: error?.message ?? String(error), documents: [] };
    }
  });
}
