import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconFile,
  IconFolder,
  IconLayers,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSpark,
  IconTrash,
  IconUpload,
} from '../shell/shellIcons';
import { confirmAsync } from '../../components/confirmEvents';
import { parseDocument, isParseableDocument } from '../../services/documentParseClient';
import { useI18n } from '../../hooks/useI18n';
import { friendlyOpError } from '../../components/notifyEvents';
import { isKnowledgeCurationEnabled } from './curationAvailability';
import { NeoxIllus } from '../../media/illus';
import { KB_OPEN_CARD_KEY } from './kbOpenCard';
import { ToolPageHeader, ToolStats, ToolButton } from '../../components/ToolPage';
import kbArt from '../../media/clay/tool-kb.webp';
import './kb-page.css';

/* ============================================================
 * 知识库页面 — 三个 tab:
 *   知识条目: .neox/knowledge/**.md (agent 沉淀 / ingest / 整理产出), 可看正文、
 *             draft 转正 (verified 才排进索引前列)、删除
 *   资料文件: 用户导入的原文件**路径引用** (不拷贝内容, 空间 ≈ 0)
 *   整  理: 手动/自动 curator (每 7 天) + 运行记录 (点记录跳会话看 token)
 *
 *   真源全部在磁盘 (卡片文件 / documents.json manifest / config), 本页只是视图。
 * ============================================================ */

type CollectionId = 'default' | 'project' | 'scratch';
type KbTab = 'cards' | 'docs' | 'curation';

interface KnowledgeDoc {
  id: string;
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
  collection: CollectionId;
  importedAt: number;
  missing: boolean;
  modified: boolean;
}

interface KnowledgeCardItem {
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

interface CurationRun {
  sessionId: string;
  model?: string;
  trigger: 'manual' | 'auto';
  startedAt: number;
}

interface KnowledgeBasePageProps {
  /** 触发一次知识库整理 (Shell 编排: 新会话 + curator skill), 不传则不显示整理入口 */
  onRunCuration?: (trigger?: 'manual') => void;
  /** 打开某次整理的会话 (看过程/token 用量) */
  onOpenSession?: (sessionId: string) => void;
  /** 把某个资料文件消化成知识条目 (Shell 编排: 新会话 + ingest skill) */
  onDigestDocument?: (path: string, name: string) => void;
  /** 「返回任务」 */
  onClose?: () => void;
  /** 「记一条」: 回到对话, 输入框预填「记到知识库：」 */
  onNewNote?: () => void;
}

const LEGACY_STORAGE_KEY = 'neox-local-knowledge-documents-v1';

const ACCEPTED_EXTENSIONS = ['pdf', 'md', 'markdown', 'txt', 'doc', 'docx', 'html', 'htm', 'csv', 'json'];
const ACCEPT_ATTR = ACCEPTED_EXTENSIONS.map((ext) => `.${ext}`).join(',');
const COLLECTION_IDS: CollectionId[] = ['default', 'project', 'scratch'];

function getCollections(isZh: boolean): Array<{ id: CollectionId; name: string; description: string }> {
  return isZh
    ? [
        { id: 'default', name: '默认知识库', description: '常用资料' },
        { id: 'project', name: '项目知识库', description: '当前工作区' },
        { id: 'scratch', name: '临时资料', description: '临时导入' },
      ]
    : [
        { id: 'default', name: 'Default', description: 'General materials' },
        { id: 'project', name: 'Project', description: 'Current workspace' },
        { id: 'scratch', name: 'Scratch', description: 'Temporary imports' },
      ];
}

function getTabs(isZh: boolean): Array<{ id: KbTab; label: string }> {
  const tabs = isZh
    ? [
        { id: 'cards' as KbTab, label: '知识条目' },
        { id: 'docs' as KbTab, label: '资料文件' },
        { id: 'curation' as KbTab, label: '整理' },
      ]
    : [
        { id: 'cards' as KbTab, label: 'Entries' },
        { id: 'docs' as KbTab, label: 'Documents' },
        { id: 'curation' as KbTab, label: 'Curation' },
      ];
  return isKnowledgeCurationEnabled() ? tabs : tabs.filter((t) => t.id !== 'curation');
}

/** 卡片 id 是 `<目录>/<名字>`, 目录就是分类; 顶层卡片没有目录 */
function cardDir(id: string): string {
  const i = id.indexOf('/');
  return i > 0 ? id.slice(0, i) : '';
}

const DIR_LABEL: Record<string, { zh: string; en: string }> = {
  conventions: { zh: '约定', en: 'Conventions' },
  infra: { zh: '基础设施', en: 'Infra' },
  research: { zh: '调研', en: 'Research' },
  decisions: { zh: '决定', en: 'Decisions' },
  howto: { zh: '做法', en: 'How-to' },
  people: { zh: '人', en: 'People' },
  '': { zh: '未分类', en: 'Other' },
};

function dirLabel(dir: string, isZh: boolean): string {
  const hit = DIR_LABEL[dir];
  return hit ? (isZh ? hit.zh : hit.en) : dir;
}

function getExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx < 0 || idx === name.length - 1) return 'file';
  return name.slice(idx + 1).toLowerCase();
}

function isSupportedName(name: string): boolean {
  return ACCEPTED_EXTENSIONS.includes(getExtension(name));
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 KB';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(ts: number): string {
  if (!ts) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts));
}

/** 旧 localStorage 条目里带绝对路径的, 迁进 manifest; 迁移成功后清 key */
async function migrateLegacyLocalStorage(): Promise<boolean> {
  try {
    const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    const docs = (Array.isArray(parsed) ? parsed : [])
      .filter((d: any) => d && typeof d.sourcePath === 'string' && d.sourcePath.startsWith('/'))
      .map((d: any) => ({
        path: d.sourcePath as string,
        collection: (COLLECTION_IDS.includes(d.collectionId) ? d.collectionId : 'default') as CollectionId,
      }));
    if (docs.length > 0) {
      const result = await window.neox.knowledgeAddDocs(docs);
      if (!result?.ok) return false;
    }
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    return docs.length > 0;
  } catch {
    return false;
  }
}

const KnowledgeBasePage: React.FC<KnowledgeBasePageProps> = ({ onRunCuration, onOpenSession, onDigestDocument, onClose, onNewNote }) => {
  const { isZh } = useI18n();
  const COLLECTIONS = useMemo(() => getCollections(isZh), [isZh]);
  const TABS = useMemo(() => getTabs(isZh), [isZh]);
  const [tab, setTab] = useState<KbTab>('cards');
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ---------- 知识条目 ---------- */
  const [cards, setCards] = useState<KnowledgeCardItem[]>([]);
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);
  const [expandedBody, setExpandedBody] = useState<string>('');
  /* 全部 / 待确认 两个视角 + 左侧按目录筛 (conventions / infra / research …) */
  const [cardFilter, setCardFilter] = useState<'all' | 'draft'>('all');
  const [dirFilter, setDirFilter] = useState<string | null>(null);
  /* 万级列表分页 — 一次渲染全部会卡, 200 条一页增量显示 */
  const PAGE_SIZE = 200;
  const [visibleCards, setVisibleCards] = useState(PAGE_SIZE);
  const [visibleDocs, setVisibleDocs] = useState(PAGE_SIZE);

  /* ---------- 资料文件 ---------- */
  const [documents, setDocuments] = useState<KnowledgeDoc[]>([]);
  const [activeCollection, setActiveCollection] = useState<CollectionId>('default');
  const [dropActive, setDropActive] = useState(false);
  const pickerRef = useRef<HTMLInputElement>(null);

  /* ---------- 整理 ---------- */
  const [autoCurate, setAutoCurate] = useState(false);
  const [curationRuns, setCurationRuns] = useState<CurationRun[]>([]);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 5000);
  }, []);

  const reloadCards = useCallback(async () => {
    try {
      const result = await window.neox.knowledgeListCards?.();
      if (result?.ok) setCards(result.cards as KnowledgeCardItem[]);
      else if (result?.error) showNotice(isZh ? `知识卡加载失败: ${result.error}` : `Failed to load cards: ${result.error}`);
    } catch (err: any) {
      showNotice(isZh ? `知识卡加载失败: ${friendlyOpError(err)}` : `Failed to load cards: ${friendlyOpError(err)}`);
    }
  }, [showNotice]);

  const reloadDocs = useCallback(async () => {
    try {
      const result = await window.neox.knowledgeListDocs();
      if (result?.ok) setDocuments(result.documents as KnowledgeDoc[]);
      else if (result?.error) showNotice(isZh ? `加载失败: ${result.error}` : `Load failed: ${result.error}`);
    } catch (err: any) {
      showNotice(isZh ? `加载失败: ${friendlyOpError(err)}` : `Load failed: ${friendlyOpError(err)}`);
    }
  }, [showNotice]);

  const reloadCuration = useCallback(async () => {
    try {
      const config = await window.neox.knowledgeCurationConfigGet?.();
      if (config?.ok) setAutoCurate(config.autoCurate);
      const log = await window.neox.knowledgeCurationLogGet?.();
      if (log?.ok) setCurationRuns(log.runs);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void (async () => {
      await migrateLegacyLocalStorage();
      await Promise.all([reloadCards(), reloadDocs(), reloadCuration()]);
    })();
    return () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    };
  }, [reloadCards, reloadDocs, reloadCuration]);

  /* 切 tab 时刷新对应数据 (agent 可能刚写了新条目) */
  useEffect(() => {
    if (tab === 'cards') void reloadCards();
    if (tab === 'docs') void reloadDocs();
    if (tab === 'curation') void reloadCuration();
  }, [tab, reloadCards, reloadDocs, reloadCuration]);

  /* 搜索/切 tab 重置分页 */
  useEffect(() => {
    setVisibleCards(PAGE_SIZE);
    setVisibleDocs(PAGE_SIZE);
  }, [query, tab]);

  /* ---------- 知识条目动作 ---------- */

  const toggleExpandCard = useCallback(async (id: string) => {
    if (expandedCardId === id) {
      setExpandedCardId(null);
      return;
    }
    setExpandedCardId(id);
    setExpandedBody(isZh ? '加载中…' : 'Loading…');
    try {
      const result = await window.neox.knowledgeReadCard(id);
      setExpandedBody(result?.ok
        ? (result.body || (isZh ? '(空)' : '(empty)'))
        : (isZh ? `读取失败: ${result?.error}` : `Read failed: ${result?.error}`));
    } catch (err: any) {
      setExpandedBody(isZh ? `读取失败: ${friendlyOpError(err)}` : `Read failed: ${friendlyOpError(err)}`);
    }
  }, [expandedCardId, isZh]);

  /* 侧栏工具托盘的知识库小面板点了某张卡 → 进来就展开它并滚过去。
   * 页面没开时 id 先放 localStorage (开页后读), 已经开着时走事件。 */
  /* 初始化只读不删 —— StrictMode 下初始化函数会跑两次, 第一次删了第二次就读不到; 删放到用掉之后 */
  const [pendingCardId, setPendingCardId] = useState<string | null>(() => {
    try { return localStorage.getItem(KB_OPEN_CARD_KEY); } catch { return null; }
  });
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (id) setPendingCardId(id);
    };
    window.addEventListener('neox:kb-open-card', onOpen);
    return () => window.removeEventListener('neox:kb-open-card', onOpen);
  }, []);
  useEffect(() => {
    if (!pendingCardId) return;
    const idx = cards.findIndex((c) => c.id === pendingCardId);
    if (idx < 0) return;
    setTab('cards');
    setQuery('');
    setVisibleCards((n) => Math.max(n, idx + 1));
    if (expandedCardId !== pendingCardId) void toggleExpandCard(pendingCardId);
    const id = pendingCardId;
    setPendingCardId(null);
    try { localStorage.removeItem(KB_OPEN_CARD_KEY); } catch { /* ignore */ }
    window.setTimeout(() => {
      document.querySelector(`[data-kb-card-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 120);
  }, [pendingCardId, cards, expandedCardId, toggleExpandCard]);

  /* 行内编辑态 (description + keywords) */
  const [editingCard, setEditingCard] = useState<{ id: string; description: string; keywords: string } | null>(null);

  const toggleAlways = useCallback(async (card: KnowledgeCardItem) => {
    try {
      const result = await window.neox.knowledgeSetCardAlways(card.id, !card.always);
      if (result?.ok) {
        showNotice(card.always
          ? (isZh ? '已取消常驻' : 'Removed from always-on')
          : (isZh ? '已设为常驻 — 全文进入每次会话的 system prompt (合规/规范类适用)' : 'Pinned as always-on — the full text will be injected into every session prompt (best for policy/spec docs)'));
        await reloadCards();
      } else showNotice(isZh ? `操作失败: ${result?.error}` : `Operation failed: ${result?.error}`);
    } catch (err: any) {
      showNotice(isZh ? `操作失败: ${friendlyOpError(err)}` : `Operation failed: ${friendlyOpError(err)}`);
    }
  }, [reloadCards, showNotice, isZh]);

  const saveCardMeta = useCallback(async () => {
    if (!editingCard) return;
    try {
      const result = await window.neox.knowledgeUpdateCardMeta(editingCard.id, {
        description: editingCard.description,
        keywords: editingCard.keywords.split(/[,，]/).map((k) => k.trim()).filter(Boolean),
      });
      if (result?.ok) {
        showNotice(isZh ? '已保存 — 描述/关键词直接影响 agent 检索命中率' : 'Saved — description/keywords directly affect retrieval hit rate');
        setEditingCard(null);
        await reloadCards();
      } else showNotice(isZh ? `保存失败: ${result?.error}` : `Save failed: ${result?.error}`);
    } catch (err: any) {
      showNotice(isZh ? `保存失败: ${friendlyOpError(err)}` : `Save failed: ${friendlyOpError(err)}`);
    }
  }, [editingCard, reloadCards, showNotice, isZh]);

  const verifyCard = useCallback(async (id: string) => {
    try {
      const result = await window.neox.knowledgeSetCardTrust(id, 'verified');
      if (result?.ok) {
        showNotice(isZh ? '已确认 — 该条目将排进索引前列' : 'Verified — this entry will be ranked higher in retrieval');
        await reloadCards();
      } else showNotice(isZh ? `操作失败: ${result?.error}` : `Operation failed: ${result?.error}`);
    } catch (err: any) {
      showNotice(isZh ? `操作失败: ${friendlyOpError(err)}` : `Operation failed: ${friendlyOpError(err)}`);
    }
  }, [reloadCards, showNotice, isZh]);

  const deleteCard = useCallback(async (id: string, title: string) => {
    const ok = await confirmAsync({
      title: isZh ? '删除知识条目' : 'Delete knowledge entry',
      message: isZh
        ? `确定删除「${title}」吗？会删除对应文件, 不可恢复。`
        : `Delete "${title}"? The underlying file will be removed and cannot be recovered.`,
      variant: 'danger',
      confirmLabel: isZh ? '删除' : 'Delete',
    });
    if (!ok) return;
    try {
      const result = await window.neox.knowledgeDeleteCard(id);
      if (result?.ok) {
        showNotice(isZh ? `已删除「${title}」` : `Deleted "${title}"`);
        if (expandedCardId === id) setExpandedCardId(null);
        await reloadCards();
      } else showNotice(isZh ? `删除失败: ${result?.error}` : `Delete failed: ${result?.error}`);
    } catch (err: any) {
      showNotice(isZh ? `删除失败: ${friendlyOpError(err)}` : `Delete failed: ${friendlyOpError(err)}`);
    }
  }, [expandedCardId, reloadCards, showNotice, isZh]);


  const verifyAllDrafts = useCallback(async () => {
    const ids = cards.filter((c) => c.trust === 'draft').map((c) => c.id);
    if (ids.length === 0) return;
    let done = 0;
    for (const id of ids) {
      try {
        const result = await window.neox.knowledgeSetCardTrust(id, 'verified');
        if (result?.ok) done++;
      } catch { /* 单条失败继续 */ }
    }
    showNotice(isZh ? `已确认 ${done}/${ids.length} 条` : `Verified ${done}/${ids.length} entries`);
    await reloadCards();
  }, [cards, reloadCards, showNotice, isZh]);

  /* ---------- 资料文件动作 ---------- */

  const importFiles = useCallback(async (files: FileList | File[]) => {
    const incoming = Array.from(files).filter((file) => isSupportedName(file.name));
    if (incoming.length === 0) return;
    const docs: Array<{ path: string; collection: CollectionId; fileId?: string }> = [];
    let unresolved = 0;
    const parseable = incoming.filter((f) => {
      try { return isParseableDocument(f); } catch { return false; }
    });
    if (parseable.length > 0) {
      showNotice(isZh
        ? `正在解析 ${parseable.length} 个文档以建立内容索引…`
        : `Parsing ${parseable.length} document${parseable.length === 1 ? '' : 's'} to build the content index…`);
    }
    for (const file of incoming) {
      const abs = window.neox.getPathForFile(file);
      if (!abs) {
        unresolved++;
        continue;
      }
      /* PDF/Word/Excel → 复用 Composer 附件解析管线, markdown 缓存 (~/.neox/documents/<fileId>.md)。
       * 效果: docx/xlsx 内容进检索 + 全模型可 read_document。解析失败不阻塞登记 (退化为路径引用)。 */
      let fileId: string | undefined;
      if (parseable.includes(file)) {
        try {
          fileId = (await parseDocument(file)).fileId;
        } catch { /* 解析失败 — 纯路径引用照样可用 */ }
      }
      docs.push({ path: abs, collection: activeCollection, ...(fileId ? { fileId } : {}) });
    }
    if (docs.length === 0) {
      showNotice(unresolved > 0
        ? (isZh ? '拿不到文件路径 — 请从访达/资源管理器拖入本地文件' : 'Could not resolve file paths — drag local files from Finder / File Explorer')
        : (isZh ? '没有可导入的文件' : 'No files to import'));
      return;
    }
    try {
      const result = await window.neox.knowledgeAddDocs(docs);
      if (result?.ok) {
        setDocuments(result.documents as KnowledgeDoc[]);
        const parts: string[] = [];
        if (result.added) parts.push(isZh
          ? `登记 ${result.added} 个文档 (引用原路径, 不占空间)`
          : `Registered ${result.added} document${result.added === 1 ? '' : 's'} (path references only, no copies)`);
        if (result.skipped) parts.push(isZh
          ? `跳过 ${result.skipped} 个 (重复或不可读)`
          : `skipped ${result.skipped} (duplicate or unreadable)`);
        if (unresolved) parts.push(isZh
          ? `${unresolved} 个拿不到路径`
          : `${unresolved} without a resolvable path`);
        if (parts.length > 0) showNotice(parts.join(' · '));
      } else if (result?.error) showNotice(isZh ? `导入失败: ${result.error}` : `Import failed: ${result.error}`);
    } catch (err: any) {
      showNotice(isZh ? `导入失败: ${friendlyOpError(err)}` : `Import failed: ${friendlyOpError(err)}`);
    }
  }, [activeCollection, showNotice, isZh]);

  const removeDocument = useCallback(async (id: string) => {
    try {
      const result = await window.neox.knowledgeRemoveDoc(id);
      if (result?.ok) setDocuments(result.documents as KnowledgeDoc[]);
    } catch (err: any) {
      showNotice(isZh ? `删除失败: ${friendlyOpError(err)}` : `Remove failed: ${friendlyOpError(err)}`);
    }
  }, [showNotice, isZh]);

  /** 「有更新」文档同步: 重新解析 (docx/xlsx/pdf) + 更新 manifest mtime → 内容索引自动重建 */
  const refreshDocument = useCallback(async (doc: KnowledgeDoc) => {
    showNotice(isZh ? `正在同步「${doc.name}」…` : `Syncing "${doc.name}"…`);
    let newFileId: string | undefined;
    try {
      const read = await window.neox.readFileDataUrl?.(doc.path);
      if (read?.success && read.dataUrl) {
        const blob = await (await fetch(read.dataUrl)).blob();
        const file = new File([blob], doc.name);
        if (isParseableDocument(file)) {
          newFileId = (await parseDocument(file)).fileId;
        }
      }
    } catch { /* 解析失败 — 至少同步 mtime, pdf/文本类照样重抽 */ }
    try {
      const result = await window.neox.knowledgeRefreshDoc(doc.id, newFileId);
      if (result?.ok) {
        setDocuments(result.documents as KnowledgeDoc[]);
        showNotice(isZh
          ? `「${doc.name}」已同步最新内容${newFileId ? ' (已重新解析)' : ''}`
          : `"${doc.name}" synced to the latest content${newFileId ? ' (re-parsed)' : ''}`);
      } else showNotice(isZh ? `同步失败: ${result?.error}` : `Sync failed: ${result?.error}`);
    } catch (err: any) {
      showNotice(isZh ? `同步失败: ${friendlyOpError(err)}` : `Sync failed: ${friendlyOpError(err)}`);
    }
  }, [showNotice, isZh]);

  const openFilePicker = () => {
    const input = pickerRef.current;
    if (!input) return;
    input.removeAttribute('webkitdirectory');
    input.removeAttribute('directory');
    input.value = '';
    input.click();
  };

  const openFolderPicker = () => {
    const input = pickerRef.current;
    if (!input) return;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
    input.value = '';
    input.click();
  };

  /* ---------- 整理动作 ---------- */

  const toggleAutoCurate = useCallback(async () => {
    const next = !autoCurate;
    setAutoCurate(next);
    try {
      await window.neox.knowledgeCurationConfigSet({ autoCurate: next });
      showNotice(next
        ? (isZh ? '自动整理已开启 — 每 7 天自动跑一次 (用当前所选模型)' : 'Auto-curation on — runs every 7 days with the currently selected model')
        : (isZh ? '自动整理已关闭' : 'Auto-curation off'));
    } catch (err: any) {
      setAutoCurate(!next);
      showNotice(isZh ? `设置失败: ${friendlyOpError(err)}` : `Failed to save setting: ${friendlyOpError(err)}`);
    }
  }, [autoCurate, showNotice, isZh]);

  /* ---------- 派生 ---------- */

  const totalDocSize = useMemo(() => documents.reduce((sum, doc) => sum + doc.size, 0), [documents]);
  const q = query.trim().toLowerCase();

  /* 目录导航只数当前视角 (全部 / 待确认) 下的卡 */
  const viewCards = useMemo(
    () => (cardFilter === 'draft' ? cards.filter((c) => c.trust === 'draft') : cards),
    [cards, cardFilter],
  );
  const dirs = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of viewCards) m.set(cardDir(c.id), (m.get(cardDir(c.id)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : a[0].localeCompare(b[0])));
  }, [viewCards]);

  const filteredCards = useMemo(() => {
    let list = dirFilter === null ? viewCards : viewCards.filter((c) => cardDir(c.id) === dirFilter);
    if (q) {
      list = list.filter((c) =>
        c.title.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.displayPath.toLowerCase().includes(q));
    }
    return list;
  }, [viewCards, dirFilter, q]);

  const activeMeta = COLLECTIONS.find((item) => item.id === activeCollection) ?? COLLECTIONS[0];
  const currentDocuments = useMemo(
    () => documents.filter((doc) => doc.collection === activeCollection),
    [activeCollection, documents],
  );
  const filteredDocuments = useMemo(() => {
    if (!q) return currentDocuments;
    return currentDocuments.filter((doc) =>
      doc.name.toLowerCase().includes(q) ||
      getExtension(doc.name).includes(q) ||
      doc.path.toLowerCase().includes(q));
  }, [currentDocuments, q]);

  const draftCount = useMemo(() => cards.filter((c) => c.trust === 'draft').length, [cards]);

  /* 「已确认」是常态不挂标签, 只标例外: 待确认 / 常驻 / 个人 */
  const cardBadges = (card: KnowledgeCardItem) => (
    <span className="neox-knowledge__card-badges">
      {card.trust === 'draft' && <span className="neox-knowledge__badge is-draft">{isZh ? '待确认' : 'Draft'}</span>}
      {card.always && <span className="neox-knowledge__badge is-always">{isZh ? '常驻' : 'Always-on'}</span>}
      {card.origin !== 'workspace' && <span className="neox-knowledge__badge">{isZh ? '个人' : 'Personal'}</span>}
    </span>
  );

  /* ============================== render ============================== */

  return (
    <div className="neox-knowledge tp-page kb-page" aria-label={isZh ? '知识库' : 'Knowledge base'}>
      <input
        ref={pickerRef}
        className="neox-knowledge__hidden-input"
        type="file"
        multiple
        accept={ACCEPT_ATTR}
        onChange={(event) => {
          if (event.currentTarget.files) void importFiles(event.currentTarget.files);
          event.currentTarget.removeAttribute('webkitdirectory');
          event.currentTarget.removeAttribute('directory');
        }}
      />

      <ToolPageHeader
        icon={kbArt}
        title={isZh ? '知识库' : 'Knowledge'}
        desc={isZh
          ? '项目里攒下的结论和约定。Agent 做事前会先查这里，你确认过的才当真'
          : 'Conclusions and conventions this project has collected. The agent checks here first; only what you verify counts'}
        onBack={onClose}
        zh={isZh}
        actions={(
          <>
            {onNewNote && <ToolButton onClick={onNewNote}>{isZh ? '＋ 记一条' : '＋ New note'}</ToolButton>}
            <ToolButton onClick={() => { setTab('docs'); openFilePicker(); }}>{isZh ? '导入资料' : 'Import'}</ToolButton>
          </>
        )}
      />
      <ToolStats
        items={[
          { value: cards.length, label: isZh ? '条知识' : 'entries' },
          ...(draftCount > 0 ? [{ value: draftCount, label: isZh ? '条等你确认' : 'to review', tone: 'warn' as const }] : []),
          { value: documents.length, label: isZh ? '份资料文件' : 'documents' },
          { value: formatBytes(totalDocSize), label: isZh ? '占用' : 'size' },
        ]}
      />

      {draftCount > 0 && (
        <div className="kb-review-bar">
          <span className="kb-review-bar__dot" aria-hidden="true" />
          <span className="kb-review-bar__text">
            {isZh
              ? <>Agent 新整理了 <b>{draftCount} 条</b>，确认后才会被当成事实用</>
              : <>The agent drafted <b>{draftCount}</b> new {draftCount === 1 ? 'entry' : 'entries'}; they count as facts only after you verify</>}
          </span>
          <button type="button" className="kb-review-bar__link" onClick={() => { setTab('cards'); setCardFilter('draft'); setDirFilter(null); }}>
            {isZh ? '逐条看' : 'Review'}
          </button>
          <ToolButton primary onClick={() => { void verifyAllDrafts(); }}>{isZh ? '全部确认' : 'Verify all'}</ToolButton>
        </div>
      )}

      <div className="kb-toolbar">
        <div className="kb-seg" role="tablist" aria-label={isZh ? '知识库视图' : 'Knowledge base views'}>
          <button type="button" role="tab" aria-selected={tab === 'cards' && cardFilter === 'all'}
            className={`kb-seg__item${tab === 'cards' && cardFilter === 'all' ? ' is-active' : ''}`}
            onClick={() => { setTab('cards'); setCardFilter('all'); setDirFilter(null); }}>
            {isZh ? '全部' : 'All'} {cards.length}
          </button>
          {draftCount > 0 && (
            <button type="button" role="tab" aria-selected={tab === 'cards' && cardFilter === 'draft'}
              className={`kb-seg__item${tab === 'cards' && cardFilter === 'draft' ? ' is-active' : ''}`}
              onClick={() => { setTab('cards'); setCardFilter('draft'); setDirFilter(null); }}>
              {isZh ? '待确认' : 'To review'} {draftCount}
            </button>
          )}
          <button type="button" role="tab" aria-selected={tab === 'docs'}
            className={`kb-seg__item${tab === 'docs' ? ' is-active' : ''}`}
            onClick={() => setTab('docs')}>
            {isZh ? '资料文件' : 'Documents'} {documents.length}
          </button>
          {TABS.some((t) => t.id === 'curation') && (
            <button type="button" role="tab" aria-selected={tab === 'curation'}
              className={`kb-seg__item${tab === 'curation' ? ' is-active' : ''}`}
              onClick={() => setTab('curation')}>
              {isZh ? '整理' : 'Curation'}
            </button>
          )}
        </div>
        <label className="neox-knowledge__search">
          <IconSearch size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={tab === 'cards'
              ? (isZh ? '搜索知识条目' : 'Search entries')
              : tab === 'docs'
                ? (isZh ? '搜索文档、类型或路径' : 'Search documents, types, or paths')
                : (isZh ? '搜索' : 'Search')}
          />
        </label>
      </div>

      {notice && <div className="neox-knowledge__notice" role="status">{notice}</div>}

      {/* ==================== 知识条目 ==================== */}
      {tab === 'cards' && (
        <div className="kb-cards-layout">
          {/* 按全部卡片判断要不要目录栏 —— 切到「待确认」时栏不该突然消失, 版面跳 */}
          {new Set(cards.map((c) => cardDir(c.id))).size > 1 && (
            <nav className="kb-dirs" aria-label={isZh ? '按目录' : 'By folder'}>
              <button type="button" className={`kb-dirs__item${dirFilter === null ? ' is-active' : ''}`} onClick={() => setDirFilter(null)}>
                <span>{isZh ? '全部' : 'All'}</span><em>{viewCards.length}</em>
              </button>
              {dirs.map(([dir, n]) => (
                <button key={dir || '_'} type="button" className={`kb-dirs__item${dirFilter === dir ? ' is-active' : ''}`} onClick={() => setDirFilter(dir)}>
                  <span>{dirLabel(dir, isZh)}</span><em>{n}</em>
                </button>
              ))}
            </nav>
          )}
          <section className="kb-cards-main" aria-label={isZh ? '知识条目' : 'Knowledge entries'}>
            {filteredCards.length === 0 ? (
              <div className="neox-knowledge__empty">
                {/* 只有"真的一条都没有"才配插画; 搜索没命中是**临时**状态,
                    那时候放一张大图等于告诉用户"这里是空的", 而其实只是关键词不对。 */}
                {q ? <IconFile size={22} /> : <img className="nx-illus" src={NeoxIllus.knowledge} alt="" aria-hidden draggable={false} />}
                <strong>{q ? (isZh ? '没有匹配条目' : 'No matching entries') : (isZh ? '暂无知识条目' : 'No entries yet')}</strong>
                <span>{q
                  ? (isZh ? '换个关键词试试' : 'Try a different keyword')
                  : (isZh
                      ? '对话中让 Neox 沉淀知识、导入资料后整理, 条目会出现在这里'
                      : 'Ask Neox to capture knowledge in chat, or import documents and curate — entries will show up here')}</span>
              </div>
            ) : (
              <div className="neox-knowledge__cards-grid">
                {filteredCards.slice(0, visibleCards).map((card) => (
                  <article
                    key={card.id}
                    data-kb-card-id={card.id}
                    className={`neox-knowledge__card kb-card${card.trust === 'draft' ? ' is-draft' : ''}${expandedCardId === card.id ? ' is-expanded' : ''}`}
                  >
                    <div className="kb-card__head">
                      <button
                        type="button"
                        className="kb-card__title"
                        onClick={() => void toggleExpandCard(card.id)}
                        title={isZh ? '点击展开/收起正文' : 'Click to expand/collapse the body'}
                      >
                        {card.title}
                      </button>
                      {cardBadges(card)}
                      {/* 编辑 / 常驻 / 删除: 悬停才出, 文字不用图标 */}
                      <div className="kb-card__hover">
                        <button
                          type="button"
                          onClick={() => setEditingCard(
                            editingCard?.id === card.id
                              ? null
                              : { id: card.id, description: card.description, keywords: (card.keywords ?? []).join(', ') },
                          )}
                          title={isZh ? '编辑描述/关键词 (直接影响检索命中率)' : 'Edit description/keywords (directly affects retrieval hit rate)'}
                        >
                          {isZh ? '编辑' : 'Edit'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void toggleAlways(card)}
                          title={card.always
                            ? (isZh ? '取消常驻 (退回按需检索)' : 'Remove always-on (back to on-demand retrieval)')
                            : (isZh ? '设为常驻 — 全文进每次会话 (合规/规范类适用)' : 'Pin as always-on — full text goes into every session (best for policy/spec docs)')}
                        >
                          {card.always ? (isZh ? '取消常驻' : 'Unpin') : (isZh ? '常驻' : 'Pin')}
                        </button>
                        <button type="button" className="is-danger" onClick={() => void deleteCard(card.id, card.title)}>
                          {isZh ? '删除' : 'Delete'}
                        </button>
                      </div>
                    </div>
                    {editingCard?.id === card.id ? (
                      <div className="neox-knowledge__card-edit">
                        <label>
                          <span>{isZh ? '描述' : 'Description'}</span>
                          <input
                            value={editingCard.description}
                            onChange={(e) => setEditingCard({ ...editingCard, description: e.currentTarget.value })}
                            placeholder={isZh ? '写成触发条件: 什么时候需要看这条' : 'Write as a trigger: when should this entry be consulted'}
                          />
                        </label>
                        <label>
                          <span>{isZh ? '关键词' : 'Keywords'}</span>
                          <input
                            value={editingCard.keywords}
                            onChange={(e) => setEditingCard({ ...editingCard, keywords: e.currentTarget.value })}
                            placeholder={isZh ? '逗号分隔: 同义词、口语叫法、黑话' : 'Comma-separated: synonyms, informal names, jargon'}
                          />
                        </label>
                        <div className="neox-knowledge__card-edit-actions">
                          <button type="button" className="neox-knowledge__button neox-knowledge__button--small neox-knowledge__button--primary" onClick={() => void saveCardMeta()}>{isZh ? '保存' : 'Save'}</button>
                          <button type="button" className="neox-knowledge__button neox-knowledge__button--small" onClick={() => setEditingCard(null)}>{isZh ? '取消' : 'Cancel'}</button>
                        </div>
                      </div>
                    ) : (
                      <div className="neox-knowledge__card-desc" title={card.description}>{card.description}</div>
                    )}
                    <div className="kb-card__foot">
                      <span className="kb-card__meta" title={card.displayPath}>
                        <span>{dirLabel(cardDir(card.id), isZh)}</span>
                        {card.updated && <span>{card.updated}</span>}
                      </span>
                      {card.trust === 'draft' && (
                        <span className="kb-card__review">
                          <button type="button" className="kb-card__reject" onClick={() => void deleteCard(card.id, card.title)}>
                            {isZh ? '不对' : 'Wrong'}
                          </button>
                          <ToolButton
                            onClick={() => void verifyCard(card.id)}
                            title={isZh ? '确认内容无误 — 排进索引前列' : 'Verify the content — ranked higher in retrieval'}
                          >
                            {isZh ? '确认' : 'Verify'}
                          </ToolButton>
                        </span>
                      )}
                    </div>
                    {expandedCardId === card.id && (
                      <div className="neox-knowledge__card-body">
                        {card.source && <div className="neox-knowledge__card-body-path">{isZh ? '来源' : 'Source'}: {card.source}</div>}
                        <pre>{expandedBody}</pre>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}
            {filteredCards.length > visibleCards && (
              <button
                type="button"
                className="neox-knowledge__button neox-knowledge__load-more"
                onClick={() => setVisibleCards((v) => v + PAGE_SIZE)}
              >
                {isZh
                  ? `显示更多 (还有 ${filteredCards.length - visibleCards} 条)`
                  : `Show more (${filteredCards.length - visibleCards} left)`}
              </button>
            )}
          </section>
        </div>
      )}

      {/* ==================== 资料文件 ==================== */}
      {tab === 'docs' && (
        <div className="neox-knowledge__body">
          <aside className="neox-knowledge__collections" aria-label={isZh ? '知识库集合' : 'Knowledge base collections'}>
            <div className="neox-knowledge__panel-title">
              <IconLayers size={15} />
              <span>{isZh ? '集合' : 'Collections'}</span>
            </div>
            <div className="neox-knowledge__collection-list">
              {COLLECTIONS.map((collection) => {
                const count = documents.filter((doc) => doc.collection === collection.id).length;
                const active = collection.id === activeCollection;
                return (
                  <button
                    key={collection.id}
                    type="button"
                    className={`neox-knowledge__collection${active ? ' is-active' : ''}`}
                    onClick={() => setActiveCollection(collection.id)}
                  >
                    <span className="neox-knowledge__collection-main">
                      <span>{collection.name}</span>
                      <small>{collection.description}</small>
                    </span>
                    <span className="neox-knowledge__count">{count}</span>
                  </button>
                );
              })}
            </div>
            <div className="neox-knowledge__aside-actions">
              <button type="button" className="neox-knowledge__button" onClick={openFolderPicker}>
                <IconFolder size={14} />
                {isZh ? '导入文件夹' : 'Import folder'}
              </button>
              <button type="button" className="neox-knowledge__button neox-knowledge__button--primary" onClick={openFilePicker}>
                <IconUpload size={14} />
                {isZh ? '导入文档' : 'Import documents'}
              </button>
            </div>
          </aside>

          <section className="neox-knowledge__panel" aria-label={isZh ? `${activeMeta.name} 文档` : `${activeMeta.name} documents`}>
            <div
              className={`neox-knowledge__dropzone${dropActive ? ' is-active' : ''}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDropActive(true);
              }}
              onDragLeave={() => setDropActive(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDropActive(false);
                void importFiles(event.dataTransfer.files);
              }}
            >
              <div className="neox-knowledge__drop-icon">
                <IconPlus size={15} />
              </div>
              <div>
                <strong>{isZh ? `拖入文档到「${activeMeta.name}」` : `Drop documents into "${activeMeta.name}"`}</strong>
                <span>{isZh
                  ? 'PDF / MD / Word / TXT / HTML / CSV / JSON · 只登记路径引用, 不拷贝文件'
                  : 'PDF / MD / Word / TXT / HTML / CSV / JSON · registers path references only, no copies'}</span>
              </div>
            </div>

            <div className="neox-knowledge__list-head">
              <span>{q
                ? (isZh ? `搜索结果 ${filteredDocuments.length}` : `${filteredDocuments.length} results`)
                : (isZh ? `${activeMeta.name} · ${currentDocuments.length} 文档` : `${activeMeta.name} · ${currentDocuments.length} documents`)}</span>
              <span>{isZh ? '状态' : 'Status'}</span>
            </div>

            <div className="neox-knowledge__doc-list">
              {filteredDocuments.length === 0 ? (
                <div className="neox-knowledge__empty">
                  <IconFile size={22} />
                  <strong>{q ? (isZh ? '没有匹配文档' : 'No matching documents') : (isZh ? '暂无文档' : 'No documents yet')}</strong>
                  <span>{q
                    ? (isZh ? '换个关键词试试' : 'Try a different keyword')
                    : (isZh ? '拖入或导入文档 — agent 可直接读取登记的原文件' : 'Drop or import documents — the agent reads the registered originals directly')}</span>
                </div>
              ) : filteredDocuments.slice(0, visibleDocs).map((doc) => {
                const status = doc.missing
                  ? { label: isZh ? '已失效' : 'Missing', className: 'neox-knowledge__status is-missing' }
                  : doc.modified
                    ? { label: isZh ? '有更新' : 'Updated', className: 'neox-knowledge__status is-modified' }
                    : { label: isZh ? '已登记' : 'Registered', className: 'neox-knowledge__status' };
                return (
                  <article key={doc.id} className={`neox-knowledge__doc${doc.missing ? ' is-missing' : ''}`}>
                    <div className="neox-knowledge__doc-icon">
                      <IconFile size={16} />
                    </div>
                    <div className="neox-knowledge__doc-main">
                      <div className="neox-knowledge__doc-title">
                        <strong>{doc.name}</strong>
                        <span>{getExtension(doc.name).toUpperCase()}</span>
                      </div>
                      <div className="neox-knowledge__doc-meta">
                        <span>{formatBytes(doc.size)}</span>
                        <span>{formatDate(doc.importedAt)}</span>
                        <span className="neox-knowledge__doc-path" title={doc.path}>{doc.path}</span>
                      </div>
                    </div>
                    <span className={status.className}>{status.label}</span>
                    {doc.modified && !doc.missing && (
                      <button
                        type="button"
                        className="neox-knowledge__card-action"
                        onClick={() => void refreshDocument(doc)}
                        title={isZh ? '同步最新内容 (重新解析并更新检索索引)' : 'Sync latest content (re-parse and refresh the index)'}
                        aria-label={isZh ? `同步 ${doc.name}` : `Sync ${doc.name}`}
                      >
                        <IconRefresh size={14} />
                      </button>
                    )}
                    {onDigestDocument && !doc.missing && (
                      <button
                        type="button"
                        className="neox-knowledge__card-action is-digest"
                        onClick={() => onDigestDocument(doc.path, doc.name)}
                        title={isZh
                          ? '消化成知识条目 — agent 读全原文提炼要点 (新会话中运行, 消耗计入该会话)'
                          : 'Digest into knowledge entries — the agent reads the full document and distills key points (runs in a new session; usage billed to it)'}
                        aria-label={isZh ? `消化 ${doc.name}` : `Digest ${doc.name}`}
                      >
                        <IconSpark size={14} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="neox-knowledge__icon-button"
                      onClick={() => void removeDocument(doc.id)}
                      aria-label={isZh ? `移除 ${doc.name} (不会删除原文件)` : `Remove ${doc.name} (original file is kept)`}
                      title={isZh ? '移除登记 (不会删除原文件)' : 'Remove registration (original file is kept)'}
                    >
                      <IconTrash size={15} />
                    </button>
                  </article>
                );
              })}
            </div>
            {filteredDocuments.length > visibleDocs && (
              <button
                type="button"
                className="neox-knowledge__button neox-knowledge__load-more"
                onClick={() => setVisibleDocs((v) => v + PAGE_SIZE)}
              >
                {isZh
                  ? `显示更多 (还有 ${filteredDocuments.length - visibleDocs} 个)`
                  : `Show more (${filteredDocuments.length - visibleDocs} left)`}
              </button>
            )}
          </section>
        </div>
      )}

      {/* ==================== 整理 ==================== */}
      {tab === 'curation' && (
        <div className="neox-knowledge__body neox-knowledge__body--single">
          <section className="neox-knowledge__panel" aria-label={isZh ? '知识库整理' : 'Knowledge base curation'}>
            <div className="neox-knowledge__curation-hero">
              <div className="neox-knowledge__curation-hero-text">
                <strong>{isZh ? '整理知识库' : 'Curate knowledge base'}</strong>
                <span>{isZh
                  ? '去重合并 · 矛盾检查 · 优化检索描述 · 标记过期 — 在独立会话中运行, 全程可见'
                  : 'Dedupe & merge · consistency checks · better retrieval descriptions · flag stale entries — runs in its own session, fully visible'}</span>
              </div>
              {onRunCuration && (() => {
                const curationOpen = isKnowledgeCurationEnabled();
                return (
                  <button
                    type="button"
                    className="neox-knowledge__button neox-knowledge__button--primary"
                    disabled={!curationOpen}
                    title={curationOpen ? undefined : (isZh
                      ? '暂不支持: 整理会直接改写你的知识卡片, 而「待确认/可撤销」这一步还没做完。做好之前先不开放。'
                      : 'Not available yet: curation rewrites your cards directly, and the review/undo step is not finished.')}
                    onClick={() => { if (curationOpen) onRunCuration('manual'); }}
                  >
                    <IconSpark size={14} />
                    {curationOpen
                      ? (isZh ? '立即整理' : 'Curate now')
                      : (isZh ? '暂不支持' : 'Not available yet')}
                  </button>
                );
              })()}
            </div>

            {(() => {
              const curationOpen = isKnowledgeCurationEnabled();
              const gateReason = isZh
                ? '暂不支持: 整理会直接改写你的知识卡片, 而「待确认/可撤销」这一步还没做完。做好之前先不开放。'
                : 'Not available yet: curation rewrites your cards directly, and the review/undo step is not finished.';
              return (
                <label
                  className={`neox-knowledge__curation-toggle${curationOpen ? '' : ' is-unavailable'}`}
                  title={curationOpen ? undefined : gateReason}
                >
                  <input
                    type="checkbox"
                    checked={autoCurate && curationOpen}
                    disabled={!curationOpen}
                    onChange={() => { if (curationOpen) void toggleAutoCurate(); }}
                  />
                  <span>
                    {isZh ? '每 7 天自动整理' : 'Auto-curate every 7 days'}
                    {!curationOpen && (
                      <em className="neox-knowledge__curation-gate">
                        {isZh ? '暂不支持' : 'Not available yet'}
                      </em>
                    )}
                  </span>
                  <small>{curationOpen
                    ? (isZh
                      ? '用当前所选模型 (BYOK/订阅均可), 消耗计入整理会话'
                      : 'Uses the currently selected model (BYOK or subscription); usage billed to the curation session')
                    : gateReason}</small>
                </label>
              );
            })()}

            <div className="neox-knowledge__list-head">
              <span>{isZh ? '整理记录' : 'Curation history'}</span>
              <span>{isZh ? '会话' : 'Session'}</span>
            </div>
            <div className="neox-knowledge__doc-list">
              {curationRuns.length === 0 ? (
                <div className="neox-knowledge__empty">
                  <IconSpark size={22} />
                  <strong>{isZh ? '还没有整理记录' : 'No curation runs yet'}</strong>
                  <span>
                    {isKnowledgeCurationEnabled()
                      ? (isZh ? '点「立即整理」跑第一次' : 'Click "Curate now" to run the first one')
                      : (isZh
                        ? '整理暂未开放 —— 开放后每次整理都会记在这里'
                        : 'Curation is not available yet — runs will be listed here once it opens')}
                  </span>
                </div>
              ) : curationRuns.map((run) => (
                <article key={`${run.sessionId}-${run.startedAt}`} className="neox-knowledge__doc">
                  <div className="neox-knowledge__doc-icon">
                    <IconSpark size={16} />
                  </div>
                  <div className="neox-knowledge__doc-main">
                    <div className="neox-knowledge__doc-title">
                      <strong>{formatDate(run.startedAt)}</strong>
                      <span>{run.trigger === 'auto' ? (isZh ? '自动' : 'Auto') : (isZh ? '手动' : 'Manual')}</span>
                    </div>
                    {run.model && (
                      <div className="neox-knowledge__doc-meta">
                        <span>{run.model}</span>
                      </div>
                    )}
                  </div>
                  {onOpenSession && (
                    <button
                      type="button"
                      className="neox-knowledge__button neox-knowledge__button--small"
                      onClick={() => onOpenSession(run.sessionId)}
                      title={isZh ? '打开该整理会话查看过程与 token 用量' : 'Open this curation session to see the process and token usage'}
                    >
                      {isZh ? '查看会话' : 'View session'}
                    </button>
                  )}
                </article>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
};

export default KnowledgeBasePage;
