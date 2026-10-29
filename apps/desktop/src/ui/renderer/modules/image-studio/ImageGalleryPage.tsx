
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { confirmAsync } from '../../components/confirmEvents';
import { directCutoutImage } from '../../services/imageDirectClient';
import { listImageTemplates, type ImageTemplate } from '../../state/imageTemplates';
import { runImageTemplate } from '../../services/imageTemplateRunner';
import { PLATFORM_PRESETS, type PlatformPreset } from '../../state/imagePlatformPresets';
import { trackImage } from '../../services/imageTelemetry';
import { imageDisplayName, IMAGE_TITLE_CLAMP } from './imageDisplayName';
import { defaultIsZh } from '../../hooks/useI18n';
import { revealInFileManagerLabel, fileManagerShortName } from '../../utils/fileManagerLabels';
import { NeoxIllus } from '../../media/illus';

interface GalleryItem { path: string; fileUrl: string; filename: string; mtime: number; }
interface ProjectRow { id: string; name: string; coverPath: string | null; createdAt: number; count: number; }
/** 项目筛选态: 全部 / 未分类 / 某项目 id. */
type ProjectFilter = 'all' | 'unassigned' | string;

const FAV_KEY = 'neox:image-favorites';
function loadFavs(): Set<string> {
  try { return new Set(JSON.parse(window.localStorage?.getItem(FAV_KEY) || '[]')); } catch { return new Set(); }
}
function saveFavs(s: Set<string>): void {
  try { window.localStorage?.setItem(FAV_KEY, JSON.stringify(Array.from(s))); } catch { /* ignore */ }
}

interface Props { open: boolean; onClose: () => void; zh?: boolean; }

export const ImageGalleryPage: React.FC<Props> = ({ open, onClose, zh = defaultIsZh() }) => {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'all' | 'fav'>('all');
  const [favs, setFavs] = useState<Set<string>>(() => loadFavs());
  const [hoverPath, setHoverPath] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('click', close); window.removeEventListener('resize', close); };
  }, [ctxMenu]);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [revealNote, setRevealNote] = useState<string | null>(null);
  const [detailItem, setDetailItem] = useState<GalleryItem | null>(null);   // 详细信息弹窗
  const [detailDim, setDetailDim] = useState<string>('');
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [projectMap, setProjectMap] = useState<Record<string, string>>({});
  const [projectFilter, setProjectFilter] = useState<ProjectFilter>('all');
  const [moveMenuPath, setMoveMenuPath] = useState<string | null>(null);
  const [newProjName, setNewProjName] = useState<string | null>(null); // null=非创建态; string=正在输入
  /* 项目改名 (双击项目行触发; IPC 早就有, 这里补 UI). */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingVal, setRenamingVal] = useState('');
  /* 选择模式 + 批量操作 (电商刚需: 整批去背景/白底/归项目/尺寸导出). */
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState('');
  const [batchMenu, setBatchMenu] = useState<null | 'cap' | 'move' | 'export'>(null);

  const reloadProjects = useCallback(async () => {
    const api = (window as any).neox;
    try {
      const [ps, map] = await Promise.all([api?.imageProjectList?.(), api?.imageProjectMap?.()]);
      setProjects(Array.isArray(ps) ? ps : []);
      setProjectMap(map && typeof map === 'object' ? map : {});
    } catch { /* noop */ }
  }, []);

  const reload = useCallback(async () => {
    const api = (window as any).neox;
    if (!api?.imageGalleryList) return;
    setLoading(true);
    try {
      const rows = await api.imageGalleryList({ limit: 500 });
      setItems(Array.isArray(rows) ? rows : []);
    } catch { setItems([]); } finally { setLoading(false); }
    void reloadProjects();
  }, [reloadProjects]);

  /* Electron 禁 window.prompt → 用行内输入建项目. commit(name) 真建. */
  const commitNewProject = useCallback(async (name: string) => {
    const nm = name.trim();
    setNewProjName(null);
    if (!nm) return;
    const api = (window as any).neox;
    const res = await api?.imageProjectCreate?.(nm);
    if (res?.ok) { await reloadProjects(); if (res.id) setProjectFilter(res.id); }
  }, [reloadProjects]);

  const assignAsset = useCallback(async (assetPath: string, projectId: string | null) => {
    const api = (window as any).neox;
    await api?.imageAssetAssign?.(assetPath, projectId);
    setMoveMenuPath(null);
    await reloadProjects();
  }, [reloadProjects]);

  const deleteProject = useCallback(async (id: string) => {
    const ok = await confirmAsync({
      title: zh ? '删除项目' : 'Delete project',
      message: zh ? '删除项目? (只解散分组, 不删图片)' : 'Delete project? (images are kept)',
      variant: 'danger',
      confirmLabel: zh ? '删除' : 'Delete',
    });
    if (!ok) return;
    const api = (window as any).neox;
    await api?.imageProjectDelete?.(id);
    if (projectFilter === id) setProjectFilter('all');
    await reloadProjects();
  }, [zh, projectFilter, reloadProjects]);

  useEffect(() => { if (open) void reload(); }, [open, reload]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (detailItem) setDetailItem(null); else onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose, detailItem]);

  const toggleFav = useCallback((path: string) => {
    setFavs(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      saveFavs(next);
      return next;
    });
  }, []);

  const handleDelete = useCallback(async (item: GalleryItem) => {
    /* 用通用确认弹窗 (非原生 window.confirm). */
    const ok = await confirmAsync({
      title: zh ? '删除这张图?' : 'Delete this image?',
      message: item.filename,
      variant: 'danger',
      confirmLabel: zh ? '删除' : 'Delete',
      cancelLabel: zh ? '取消' : 'Cancel',
    });
    if (!ok) return;
    const api = (window as any).neox;
    const res = await api?.imageDeleteFile?.(item.path);
    if (res?.ok) setItems(prev => prev.filter(x => x.path !== item.path));
  }, [zh]);

  const commitRename = useCallback(async () => {
    const nm = renamingVal.trim(); const id = renamingId;
    setRenamingId(null);
    if (!nm || !id) return;
    const api = (window as any).neox;
    await api?.imageProjectRename?.(id, nm);
    await reloadProjects();
  }, [renamingId, renamingVal, reloadProjects]);

  /* 项目自动封面 = 项目内最新一张素材 (items 本身按时间倒序). */
  const coverByProject = useMemo(() => {
    const m: Record<string, string> = {};
    for (const it of items) { const pid = projectMap[it.path]; if (pid && !m[pid]) m[pid] = it.fileUrl; }
    return m;
  }, [items, projectMap]);

  const exitSelect = useCallback(() => { setSelectMode(false); setSelected(new Set()); setBatchMenu(null); }, []);
  const toggleSelected = useCallback((path: string) => {
    setSelected(prev => { const next = new Set(prev); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  }, []);
  const flashNote = useCallback((msg: string, ms = 3000) => {
    setRevealNote(msg);
    window.setTimeout(() => setRevealNote(null), ms);
  }, []);

  /* 高清放大的目标尺寸 (跟编辑器同口径: 最长边 3072, 16 整除). */
  const upscaleSizeOf = useCallback(async (path: string): Promise<string | undefined> => {
    const it = items.find(x => x.path === path);
    if (!it) return undefined;
    const d = await new Promise<{ w: number; h: number } | null>((res) => {
      const img = new Image();
      img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => res(null);
      img.src = it.fileUrl;
    });
    if (!d?.w || !d?.h) return '2048x2048';
    const long = 3072;
    let ow: number, oh: number;
    if (d.w >= d.h) { ow = long; oh = Math.round((long * d.h) / d.w); }
    else { oh = long; ow = Math.round((long * d.w) / d.h); }
    return `${Math.max(512, Math.round(ow / 16) * 16)}x${Math.max(512, Math.round(oh / 16) * 16)}`;
  }, [items]);

  /* 批量套能力: 走统一模板引擎逐张跑 (串行防打爆上游), 单张失败不中断, 最后一次性汇报. */
  const runBatchCapability = useCallback(async (cap: ImageTemplate | 'cutout') => {
    setBatchMenu(null);
    const paths = Array.from(selected);
    if (paths.length === 0 || batchBusy) return;
    const label = cap === 'cutout' ? (zh ? '去背景' : 'Cutout') : cap.name;
    let okCount = 0; let mode: string | undefined;
    for (let i = 0; i < paths.length; i++) {
      setBatchBusy(`${label} ${i + 1}/${paths.length}`);
      try {
        const res = cap === 'cutout'
          ? await directCutoutImage(paths[i]!)
          : await runImageTemplate({ template: cap, input: paths[i]!, size: cap.upscale ? await upscaleSizeOf(paths[i]!) : undefined });
        if (res.ok) { okCount++; mode = mode ?? res.mode; }
      } catch { /* 单张失败继续下一张 */ }
    }
    setBatchBusy('');
    trackImage('batch_capability', { capId: cap === 'cutout' ? 'cutout' : cap.id, total: paths.length, ok: okCount }, mode);
    flashNote(zh ? `${label} 批量完成: ${okCount}/${paths.length} 张成功` : `${label}: ${okCount}/${paths.length} done`);
    exitSelect();
    await reload();
  }, [selected, batchBusy, zh, upscaleSizeOf, flashNote, exitSelect, reload]);

  const runBatchMove = useCallback(async (projectId: string | null) => {
    setBatchMenu(null);
    const api = (window as any).neox;
    for (const p of selected) { try { await api?.imageAssetAssign?.(p, projectId); } catch { /* 继续 */ } }
    await reloadProjects();
    exitSelect();
  }, [selected, reloadProjects, exitSelect]);

  const runBatchExport = useCallback(async (presets: PlatformPreset[]) => {
    setBatchMenu(null);
    const api = (window as any).neox;
    if (!api?.imageExportSizes) { flashNote(zh ? '尺寸导出需重启应用后生效' : 'Size export needs an app restart'); return; }
    const paths = Array.from(selected);
    if (paths.length === 0 || batchBusy) return;
    let ok = 0; let firstFile: string | undefined;
    for (let i = 0; i < paths.length; i++) {
      setBatchBusy(`${zh ? '导出' : 'Export'} ${i + 1}/${paths.length}`);
      try {
        const r = await api.imageExportSizes({ source: paths[i], presets: presets.map(({ id, label, w, h, fit }) => ({ id, label, w, h, fit })), reveal: false });
        if (r?.ok) { ok++; firstFile = firstFile ?? r.files?.[0]; }
      } catch { /* 继续 */ }
    }
    setBatchBusy('');
    if (firstFile) void api?.imageRevealFile?.(firstFile);
    flashNote(zh ? `已导出 ${ok}/${paths.length} 张的平台尺寸` : `Exported ${ok}/${paths.length}`);
    exitSelect();
  }, [selected, batchBusy, zh, flashNote, exitSelect]);

  const runBatchDelete = useCallback(async () => {
    const paths = Array.from(selected);
    if (paths.length === 0) return;
    const ok = await confirmAsync({
      title: zh ? `删除 ${paths.length} 张图?` : `Delete ${paths.length} images?`,
      message: zh ? '删除后不可恢复' : 'This cannot be undone',
      variant: 'danger',
      confirmLabel: zh ? '删除' : 'Delete',
      cancelLabel: zh ? '取消' : 'Cancel',
    });
    if (!ok) return;
    const api = (window as any).neox;
    for (const p of paths) { try { await api?.imageDeleteFile?.(p); } catch { /* 继续 */ } }
    setItems(prev => prev.filter(x => !selected.has(x.path)));
    exitSelect();
  }, [selected, zh, exitSelect]);

  const filtered = useMemo(() => {
    let list = items;
    if (tab === 'fav') list = list.filter(i => favs.has(i.path));
    if (projectFilter === 'unassigned') list = list.filter(i => !projectMap[i.path]);
    else if (projectFilter !== 'all') list = list.filter(i => projectMap[i.path] === projectFilter);
    const q = query.trim().toLowerCase();
    if (q) list = list.filter(i => i.filename.toLowerCase().includes(q));
    return list;
  }, [items, tab, favs, query, projectFilter, projectMap]);
  const unassignedCount = useMemo(() => items.filter(i => !projectMap[i.path]).length, [items, projectMap]);

  /* 只填满内容区 (右侧), 不 portal 到 body —— 顶部标题栏 + 左侧侧栏(大框架)必须保留.
   * 常挂载 + opacity/transform 过渡: 打开/关闭都有淡入淡出 + 轻微上移动画, 不再瞬间硬切. */
  return (
    <div style={{
      position: 'absolute', inset: 0, background: 'var(--neox-bg-canvas, #fff)',
      display: 'flex', flexDirection: 'column', zIndex: 5,
      opacity: open ? 1 : 0,
      transform: open ? 'translateY(0)' : 'translateY(8px)',
      pointerEvents: open ? 'auto' : 'none',
      transition: 'opacity 0.2s ease, transform 0.2s ease',
    }}>
      {/* header — 位置/大小对齐创作页 header (padding 24px 40px, fontSize 22, 无 border), 切换不位移 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 40px 12px' }}>
        {/* 返回 = 左侧箭头 (统一图片各页; 右侧关闭已去) */}
        <button type="button" onClick={onClose} title={zh ? '返回' : 'Back'}
          style={{ width: 30, height: 30, borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--neox-fg-secondary, #6b7280)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginLeft: -6 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
        </button>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, letterSpacing: '-0.01em' }}>{zh ? '图库' : 'Gallery'}</h1>
        <span style={{ fontSize: 12, color: 'var(--neox-fg-secondary, #9ca3af)' }}>{filtered.length}</span>
        <div style={{ display: 'inline-flex', borderRadius: 8, background: 'var(--neox-bg-subtle, rgba(0,0,0,0.04))', padding: 2, gap: 2, marginLeft: 6 }}>
          {(['all', 'fav'] as const).map(t => (
            <button key={t} type="button" onClick={() => setTab(t)}
              style={{ fontSize: 12, padding: '4px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
                background: tab === t ? 'var(--neox-bg-card,#fff)' : 'transparent',
                color: tab === t ? 'var(--neox-fg-primary)' : 'var(--neox-fg-secondary,#6b7280)',
                fontWeight: tab === t ? 600 : 500, boxShadow: tab === t ? '0 1px 2px rgba(0,0,0,0.08)' : 'none' }}>
              {t === 'all' ? (zh ? '全部' : 'All') : (zh ? '收藏' : 'Favorites')}
            </button>
          ))}
        </div>
        <input
          value={query} onChange={e => setQuery(e.target.value)}
          placeholder={zh ? '搜索文件名…' : 'Search filename…'}
          style={{ marginLeft: 'auto', fontSize: 13, padding: '6px 12px', borderRadius: 8, width: 240,
            border: '1px solid var(--neox-line, rgba(0,0,0,0.12))', background: 'var(--neox-bg-card,#fff)', color: 'var(--neox-fg-primary)' }}
        />
        <button type="button" onClick={() => (selectMode ? exitSelect() : setSelectMode(true))} style={{ ...headBtn, ...(selectMode ? { background: 'var(--neox-bg-subtle, rgba(0,0,0,0.05))', color: 'var(--neox-fg-primary)' } : {}) }}>
          {selectMode ? (zh ? '完成' : 'Done') : (zh ? '选择' : 'Select')}
        </button>
        <button type="button" onClick={() => void reload()} style={headBtn}>{zh ? '刷新' : 'Refresh'}</button>
      </div>

      {/* 主体: 左项目栏 + 右网格 */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      {/* 项目栏 —— 项目=通用容器(一个商品/一次活动). 素材可归属, 按项目筛. */}
      <div style={{ width: 190, flexShrink: 0, overflowY: 'auto', padding: '4px 14px 16px 40px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {([['all', zh ? '全部' : 'All', items.length], ['unassigned', zh ? '未分类' : 'Unsorted', unassignedCount]] as const).map(([key, label, cnt]) => (
          <button key={key} type="button" onClick={() => setProjectFilter(key)} style={railItem(projectFilter === key)}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
            <span style={{ fontSize: 11, opacity: 0.6 }}>{cnt}</span>
          </button>
        ))}
        <div style={{ height: 1, background: 'var(--neox-line, rgba(0,0,0,0.06))', margin: '6px 4px' }} />
        {projects.map(p => (
          <div key={p.id} className="neox-proj-row" style={{ position: 'relative', display: 'flex' }}>
            {renamingId === p.id ? (
              <input autoFocus value={renamingVal} onChange={e => setRenamingVal(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void commitRename(); else if (e.key === 'Escape') setRenamingId(null); }}
                onBlur={() => void commitRename()}
                style={{ flex: 1, fontSize: 12.5, padding: '5px 9px', borderRadius: 8, border: '1px solid var(--neox-primary-400, #60a5fa)', outline: 'none', background: 'var(--neox-bg-card,#fff)', color: 'var(--neox-fg-primary)' }} />
            ) : (
              <>
                <button type="button" onClick={() => setProjectFilter(p.id)}
                  onDoubleClick={() => { setRenamingId(p.id); setRenamingVal(p.name); }}
                  title={zh ? '双击改名' : 'Double-click to rename'}
                  style={{ ...railItem(projectFilter === p.id), flex: 1 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
                    {/* 自动封面 = 项目内最新一张; 没素材时回退文件夹 icon */}
                    {coverByProject[p.id] ? (
                      <img src={coverByProject[p.id]} alt="" style={{ width: 16, height: 16, borderRadius: 4, objectFit: 'cover', flexShrink: 0 }} />
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.7 }}><path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
                    )}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                  </span>
                  <span style={{ fontSize: 11, opacity: 0.6 }}>{p.count}</span>
                </button>
                <button type="button" title={zh ? '删除项目' : 'Delete'} onClick={() => void deleteProject(p.id)}
                  className="neox-proj-del"
                  style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', width: 18, height: 18, border: 'none', background: 'transparent', color: 'var(--neox-fg-secondary, #9ca3af)', cursor: 'pointer', borderRadius: 4, fontSize: 13, lineHeight: 1 }}>×</button>
              </>
            )}
          </div>
        ))}
        {newProjName === null ? (
          <button type="button" onClick={() => setNewProjName('')} style={{ ...railItem(false), color: 'var(--neox-primary-600, #2563eb)', marginTop: 4 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
              {zh ? '新建项目' : 'New project'}
            </span>
          </button>
        ) : (
          <input autoFocus value={newProjName} onChange={e => setNewProjName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void commitNewProject(newProjName); else if (e.key === 'Escape') setNewProjName(null); }}
            onBlur={() => void commitNewProject(newProjName)}
            placeholder={zh ? '项目名 · 回车建' : 'Name · Enter'}
            style={{ marginTop: 4, fontSize: 12.5, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--neox-primary-400, #60a5fa)', outline: 'none', background: 'var(--neox-bg-card,#fff)', color: 'var(--neox-fg-primary)' }} />
        )}
      </div>

      {/* grid */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 40px 40px' }}>
        {loading && <div className="neox-text-shimmer" style={{ textAlign: 'center', color: 'var(--neox-fg-secondary)', fontSize: 13, padding: 40 }}>{zh ? '加载中…' : 'Loading…'}</div>}
        {!loading && filtered.length === 0 && (
          <div className="nx-illus-empty">
            <img className="nx-illus" src={NeoxIllus.image} alt="" aria-hidden draggable={false} />
            <div>{tab === 'fav' ? (zh ? '还没有收藏' : 'No favorites yet') : (zh ? '还没有生成图' : 'No images yet')}</div>
          </div>
        )}
        {!loading && filtered.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
            {filtered.map(item => {
              const fav = favs.has(item.path);
              const hover = hoverPath === item.path && !selectMode;
              const isSel = selected.has(item.path);
              return (
                <div key={item.path}
                  onMouseEnter={() => setHoverPath(item.path)} onMouseLeave={() => setHoverPath(h => h === item.path ? null : h)}
                  style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ position: 'relative', borderRadius: 10, overflow: 'hidden', background: 'rgba(0,0,0,0.04)', aspectRatio: '1/1', cursor: selectMode ? 'pointer' : 'zoom-in', outline: isSel ? '3px solid var(--neox-primary-500, #3b82f6)' : 'none', outlineOffset: -3 }}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); if (!selectMode) setCtxMenu({ path: item.path, x: e.clientX, y: e.clientY }); }}
                    onClick={() => {
                      if (selectMode) { toggleSelected(item.path); return; }
                      window.dispatchEvent(new CustomEvent('neox:image-lightbox', { detail: { url: item.fileUrl, path: item.path, filename: item.filename, mtime: item.mtime } }));
                    }}>
                    <img src={item.fileUrl} alt={item.filename} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                    {/* 选择模式: 左上角勾选圈 */}
                    {selectMode && (
                      <span style={{ position: 'absolute', left: 8, top: 8, width: 22, height: 22, borderRadius: '50%', background: isSel ? 'var(--neox-primary-500, #3b82f6)' : 'rgba(255,255,255,0.85)', border: isSel ? 'none' : '1.5px solid rgba(0,0,0,0.25)', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                        {isSel && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}
                      </span>
                    )}
                    {/* 收藏星标 (常显 if fav, hover 显 toggle) */}
                    {!selectMode && (fav || hover) && (
                      <button type="button" title={zh ? '收藏' : 'Favorite'} onClick={(e) => { e.stopPropagation(); toggleFav(item.path); }}
                        style={{ position: 'absolute', left: 8, top: 8, width: 26, height: 26, borderRadius: 7, border: 'none', cursor: 'pointer',
                          background: 'rgba(0,0,0,0.5)', color: fav ? '#fbbf24' : '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill={fav ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m12 2 3 6.5 7 .7-5.2 4.7 1.5 6.9L12 17.8 5.7 20.8l1.5-6.9L2 9.2l7-.7Z" /></svg>
                      </button>
                    )}
                    {hover && (
                      <div style={{ position: 'absolute', right: 8, top: 8, display: 'flex', gap: 5 }}>
                        <button type="button" title={zh ? '移到项目' : 'Move to project'} onClick={(e) => { e.stopPropagation(); setMoveMenuPath(p => p === item.path ? null : item.path); }} style={ovBtn}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
                        </button>
                        <button type="button" title={zh ? '详细信息' : 'Details'} onClick={(e) => { e.stopPropagation(); setDetailDim(''); setDetailItem(item); }} style={ovBtn}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
                        </button>
                        <button type="button" title={`${zh ? '导出' : 'Export'} (${revealInFileManagerLabel(zh)})`} onClick={async (e) => { e.stopPropagation(); const r = await revealImageFile(item.path); if (!r.ok) { setRevealNote(zh ? '打不开，已复制路径' : "Couldn't open — path copied"); void navigator.clipboard?.writeText(item.path); window.setTimeout(() => setRevealNote(null), 2200); } }} style={ovBtn}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12" /><path d="m7 11 5 5 5-5" /><path d="M5 21h14" /></svg>
                        </button>
                        <button type="button" title={zh ? '删除' : 'Delete'} onClick={(e) => { e.stopPropagation(); void handleDelete(item); }} style={{ ...ovBtn, color: '#fca5a5' }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M6 6v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6" /></svg>
                        </button>
                      </div>
                    )}
                    {/* 移到项目 菜单 */}
                    {moveMenuPath === item.path && (
                      <div onClick={(e) => e.stopPropagation()}
                        style={{ position: 'absolute', right: 8, top: 40, zIndex: 20, minWidth: 150, maxHeight: 220, overflowY: 'auto', background: 'var(--neox-bg-card, #fff)', border: '1px solid var(--neox-line, rgba(0,0,0,0.12))', borderRadius: 10, boxShadow: '0 8px 28px rgba(0,0,0,0.18)', padding: 4 }}>
                        <div style={{ fontSize: 10.5, color: 'var(--neox-fg-secondary, #9ca3af)', padding: '4px 8px' }}>{zh ? '移到项目' : 'Move to'}</div>
                        {projectMap[item.path] && (
                          <button type="button" onClick={() => void assignAsset(item.path, null)} style={moveItem}>{zh ? '↩ 移出项目' : '↩ Unsort'}</button>
                        )}
                        {projects.length === 0 && <div style={{ fontSize: 11.5, color: 'var(--neox-fg-secondary)', padding: '4px 8px' }}>{zh ? '还没有项目' : 'No projects'}</div>}
                        {projects.map(p => (
                          <button key={p.id} type="button" onClick={() => void assignAsset(item.path, p.id)}
                            style={{ ...moveItem, fontWeight: projectMap[item.path] === p.id ? 700 : 500 }}>
                            {projectMap[item.path] === p.id ? '✓ ' : ''}{p.name}
                          </button>
                        ))}
                        <button type="button" onClick={() => { setMoveMenuPath(null); setNewProjName(''); }} style={{ ...moveItem, color: 'var(--neox-primary-600, #2563eb)' }}>＋ {zh ? '新建项目' : 'New project'}</button>
                      </div>
                    )}
                  </div>
                  <span style={{ fontSize: 10.5, color: 'var(--neox-fg-secondary, #9ca3af)', textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {new Date(item.mtime).toLocaleString(zh ? 'zh-CN' : undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      </div>

      {/* 批量/导出结果 toast (详情弹窗外的全局提示) */}
      {revealNote && !detailItem && (
        <div style={{ position: 'absolute', left: '50%', bottom: selectMode ? 76 : 24, transform: 'translateX(-50%)', zIndex: 31, padding: '6px 14px', borderRadius: 999, background: 'rgba(17,24,39,0.86)', color: '#fff', fontSize: 12, fontWeight: 500, boxShadow: '0 4px 14px rgba(0,0,0,0.2)', whiteSpace: 'nowrap' }}>
          {revealNote}
        </div>
      )}

      {/* 批量操作条 —— 选择模式浮在底部 (Photos 式), 一条 pill 收所有批量动作. */}
      {selectMode && (
        <div style={{ position: 'absolute', left: '50%', bottom: 22, transform: 'translateX(-50%)', zIndex: 30, display: 'flex', alignItems: 'center', gap: 6, background: 'var(--neox-bg-card,#fff)', border: '1px solid var(--neox-line, rgba(0,0,0,0.12))', borderRadius: 999, boxShadow: '0 12px 40px rgba(0,0,0,0.18)', padding: '7px 8px 7px 16px' }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--neox-fg-primary)', whiteSpace: 'nowrap' }}>
            {batchBusy
              ? <span className="neox-text-shimmer">{batchBusy}</span>
              : (selected.size > 0 ? (zh ? `已选 ${selected.size} 张` : `${selected.size} selected`) : (zh ? '点图选择' : 'Tap to select'))}
          </span>
          {!batchBusy && (
            <>
              {/* 批量能力 */}
              <div style={{ position: 'relative' }}>
                <button type="button" disabled={selected.size === 0} onClick={() => setBatchMenu(m => m === 'cap' ? null : 'cap')} style={batchBtn(selected.size > 0)}>{zh ? '一键能力 ▾' : 'Apply ▾'}</button>
                {batchMenu === 'cap' && (
                  <div style={batchMenuBox}>
                    <button type="button" onClick={() => void runBatchCapability('cutout')} style={moveItem}>{zh ? '去背景' : 'Remove BG'}</button>
                    {/* 需要参考图的模板 (换装) 没法批量喂图, 不进批量菜单. */}
                    {listImageTemplates({ mode: 'edit' }).filter(c => !c.needsReference).map(c => (
                      <button key={c.id} type="button" onClick={() => void runBatchCapability(c)} style={moveItem}>{c.name}</button>
                    ))}
                  </div>
                )}
              </div>
              {/* 批量归项目 */}
              <div style={{ position: 'relative' }}>
                <button type="button" disabled={selected.size === 0} onClick={() => setBatchMenu(m => m === 'move' ? null : 'move')} style={batchBtn(selected.size > 0)}>{zh ? '归项目 ▾' : 'Move ▾'}</button>
                {batchMenu === 'move' && (
                  <div style={batchMenuBox}>
                    <button type="button" onClick={() => void runBatchMove(null)} style={moveItem}>{zh ? '↩ 移出项目' : '↩ Unsort'}</button>
                    {projects.map(p => (
                      <button key={p.id} type="button" onClick={() => void runBatchMove(p.id)} style={moveItem}>{p.name}</button>
                    ))}
                    {projects.length === 0 && <div style={{ fontSize: 11.5, color: 'var(--neox-fg-secondary)', padding: '4px 8px' }}>{zh ? '还没有项目' : 'No projects'}</div>}
                  </div>
                )}
              </div>
              {/* 批量尺寸导出 */}
              <div style={{ position: 'relative' }}>
                <button type="button" disabled={selected.size === 0} onClick={() => setBatchMenu(m => m === 'export' ? null : 'export')} style={batchBtn(selected.size > 0)}>{zh ? '尺寸导出 ▾' : 'Sizes ▾'}</button>
                {batchMenu === 'export' && (
                  <div style={batchMenuBox}>
                    {PLATFORM_PRESETS.map(p => (
                      <button key={p.id} type="button" onClick={() => void runBatchExport([p])} style={moveItem}>{zh ? p.label : p.labelEn}</button>
                    ))}
                    <button type="button" onClick={() => void runBatchExport(PLATFORM_PRESETS)} style={{ ...moveItem, fontWeight: 600 }}>{zh ? '全部平台' : 'All platforms'}</button>
                  </div>
                )}
              </div>
              <button type="button" disabled={selected.size === 0} onClick={() => void runBatchDelete()} style={{ ...batchBtn(selected.size > 0), color: selected.size > 0 ? '#dc2626' : undefined }}>{zh ? '删除' : 'Delete'}</button>
              <button type="button" onClick={exitSelect} style={batchBtn(true)}>{zh ? '取消' : 'Cancel'}</button>
            </>
          )}
        </div>
      )}

      {/* 详细信息弹窗 (玻璃卡: 左图右详情, 复用用户偏好范式) — portal 到 body 盖全屏 */}
      {detailItem && createPortal(
        <div onClick={() => setDetailItem(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 2147483000, background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ display: 'flex', maxWidth: '92vw', maxHeight: '84vh', background: 'var(--neox-bg-card, #fff)', borderRadius: 16, overflow: 'hidden', boxShadow: '0 30px 80px rgba(0,0,0,0.4)' }}>
            {/* 左: 图 (贴合尺寸零黑边) */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--neox-bg-subtle, #f4f4f5)', flexShrink: 0 }}>
              <img src={detailItem.fileUrl} alt={detailItem.filename}
                onLoad={(e) => setDetailDim(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)}
                style={{ maxHeight: '84vh', maxWidth: '56vw', width: 'auto', height: 'auto', objectFit: 'contain', display: 'block' }} />
            </div>
            {/* 右: 详情卡 */}
            <div style={{ width: 320, flexShrink: 0, padding: 22, display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}>
              <div>
                {/* 同 ImageEditorView: 标题两行封顶, 完整文件名进悬浮提示 (下面「路径」栏仍是全的)。 */}
                <div title={imageDisplayName(detailItem.filename).full}
                  style={{ fontSize: 16, fontWeight: 700, color: 'var(--neox-fg-primary)', lineHeight: 1.35, ...IMAGE_TITLE_CLAMP }}>{imageDisplayName(detailItem.filename).title}</div>
                <div style={{ fontSize: 12, color: 'var(--neox-fg-secondary, #9ca3af)', marginTop: 3 }}>{new Date(detailItem.mtime).toLocaleString(zh ? 'zh-CN' : undefined)}</div>
              </div>
              <div className="neox-text-shimmer" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', rowGap: 12, columnGap: 14 }}>
                {[[zh ? '尺寸' : 'Size', detailDim || (zh ? '加载中…' : '…')], [zh ? '格式' : 'Format', (detailItem.filename.split('.').pop() || '').toUpperCase()], [zh ? '归属项目' : 'Project', (projects.find(p => p.id === projectMap[detailItem.path])?.name) || (zh ? '未分类' : 'Unsorted')]].map(([k, v]) => (
                  <div key={k}>
                    <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--neox-fg-secondary, #9ca3af)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 3 }}>{k}</div>
                    <div style={{ fontSize: 13, color: 'var(--neox-fg-primary)', fontWeight: 500 }}>{v}</div>
                  </div>
                ))}
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
                  <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--neox-fg-secondary, #9ca3af)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{zh ? '路径' : 'Path'}</span>
                  <span style={{ fontSize: 10.5, color: 'var(--neox-fg-hint, #b0b0b8)' }}>{zh ? `点击在${fileManagerShortName(zh)}打开 ↗` : 'Click to open ↗'}</span>
                </div>
                <div
                  role="button"
                  tabIndex={0}
                  title={detailItem.path}
                  onClick={async () => { const r = await revealImageFile(detailItem.path); if (!r.ok) { setRevealNote(zh ? '打不开，已复制路径' : "Couldn't open — path copied"); void navigator.clipboard?.writeText(detailItem.path); window.setTimeout(() => setRevealNote(null), 2200); } }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--neox-primary-500, #6b7cff)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'transparent'; }}
                  style={{ fontSize: 11.5, lineHeight: 1.55, color: 'var(--neox-fg-primary)', background: 'var(--neox-bg-subtle, rgba(0,0,0,0.04))', border: '1px solid transparent', borderRadius: 9, padding: '9px 11px', wordBreak: 'break-all', fontFamily: 'var(--neox-font-mono)', cursor: 'pointer', transition: 'border-color 0.14s ease' }}
                >{prettyImagePath(detailItem.path)}</div>
                {revealNote && <div style={{ fontSize: 11, color: 'var(--neox-warn, #d97706)', marginTop: 5 }}>{revealNote}</div>}
              </div>
              <div style={{ marginTop: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" onClick={() => { void navigator.clipboard?.writeText(detailItem.path); setCopiedPath(detailItem.path); window.setTimeout(() => setCopiedPath(p => p === detailItem.path ? null : p), 1400); }}
                  style={detailBtn}>{copiedPath === detailItem.path ? (zh ? '✓ 已复制' : '✓ Copied') : (zh ? '复制路径' : 'Copy path')}</button>
                <button type="button" onClick={async () => { const r = await revealImageFile(detailItem.path); if (!r.ok) { setRevealNote(zh ? '打不开，已复制路径' : "Couldn't open — path copied"); void navigator.clipboard?.writeText(detailItem.path); window.setTimeout(() => setRevealNote(null), 2200); } }} style={detailBtn}>{revealInFileManagerLabel(zh)}</button>
                <button type="button" onClick={() => { const it = detailItem; setDetailItem(null); void handleDelete(it); }} style={{ ...detailBtn, color: '#dc2626', borderColor: 'rgba(220,38,38,0.3)' }}>{zh ? '删除' : 'Delete'}</button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* 右键菜单 — 进入这张图所属的会话 (回溯), 顺带常用操作. */}
      {ctxMenu && createPortal(
        <div onClick={(e) => e.stopPropagation()}
          style={{ position: 'fixed', left: Math.min(ctxMenu.x, window.innerWidth - 180), top: Math.min(ctxMenu.y, window.innerHeight - 170), zIndex: 2147483001, minWidth: 168, background: 'var(--neox-bg-card, #fff)', border: '1px solid var(--neox-line, rgba(0,0,0,0.12))', borderRadius: 10, boxShadow: '0 10px 32px rgba(0,0,0,0.2)', padding: 5 }}>
          <button type="button" onClick={() => { window.dispatchEvent(new CustomEvent('neox:image-goto-session', { detail: { path: ctxMenu.path } })); setCtxMenu(null); onClose(); }} style={ctxItem}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
            {zh ? '进入所属会话' : 'Go to session'}
          </button>
          <button type="button" onClick={() => { const it = items.find(i => i.path === ctxMenu.path); if (it) { setDetailDim(''); setDetailItem(it); } setCtxMenu(null); }} style={ctxItem}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
            {zh ? '详细信息' : 'Details'}
          </button>
          <button type="button" onClick={async () => { const path = ctxMenu.path; setCtxMenu(null); const r = await revealImageFile(path); if (!r.ok) { void navigator.clipboard?.writeText(path); setRevealNote(zh ? '打不开，已复制路径' : "Couldn't open — path copied"); window.setTimeout(() => setRevealNote(null), 2200); } }} style={ctxItem} title={revealInFileManagerLabel(zh)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12" /><path d="m7 11 5 5 5-5" /><path d="M5 21h14" /></svg>
            {revealInFileManagerLabel(zh)}
          </button>
          <button type="button" onClick={() => { const it = items.find(i => i.path === ctxMenu.path); setCtxMenu(null); if (it) void handleDelete(it); }} style={{ ...ctxItem, color: '#dc2626' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M6 6v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6" /></svg>
            {zh ? '删除' : 'Delete'}
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
};

const ctxItem: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', borderRadius: 7,
  border: 'none', background: 'transparent', color: 'var(--neox-fg-primary)', fontSize: 12.5, cursor: 'pointer', textAlign: 'left',
};

const detailBtn: React.CSSProperties = {
  fontSize: 12.5, fontWeight: 500, padding: '8px 14px', borderRadius: 9, cursor: 'pointer',
  border: '1px solid var(--neox-line, rgba(0,0,0,0.14))', background: 'var(--neox-bg-card, #fff)', color: 'var(--neox-fg-primary)',
};

/* 在 Finder/Explorer 高亮图片文件. 图片产物在 <userData>/neox-artifacts 里, 通用
 * fsRevealInFinder 会因 workspace 根校验被拒 → 优先走 artifacts 根专用的 imageRevealFile. */
async function revealImageFile(p: string): Promise<{ ok: boolean; error?: string }> {
  const api = (window as any).neox;
  try {
    if (api?.imageRevealFile) return await api.imageRevealFile(p);
    if (api?.fsRevealInFinder) { const r = await api.fsRevealInFinder(p); return r ?? { ok: true }; }
    return { ok: false, error: 'no binding' };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/* 路径显示优化: 把冗长的 userData 前缀折成 ~/…/neox-artifacts/… , 只留有信息量的尾部. */
function prettyImagePath(p: string): string {
  const m = p.match(/neox-artifacts[/\\].*$/);
  return m ? '…/' + m[0].replace(/\\/g, '/') : p;
}

const railItem = (active: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
  fontSize: 12.5, fontWeight: active ? 600 : 500, padding: '6px 10px', borderRadius: 8,
  border: 'none', cursor: 'pointer', textAlign: 'left', width: '100%',
  background: active ? 'var(--neox-bg-subtle, rgba(0,0,0,0.05))' : 'transparent',
  color: active ? 'var(--neox-fg-primary)' : 'var(--neox-fg-secondary, #6b7280)',
});
const moveItem: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', fontSize: 12.5, padding: '6px 8px',
  borderRadius: 6, border: 'none', background: 'transparent', color: 'var(--neox-fg-primary)', cursor: 'pointer',
};
const batchBtn = (enabled: boolean): React.CSSProperties => ({
  fontSize: 12.5, fontWeight: 500, padding: '6px 11px', borderRadius: 999, border: 'none',
  cursor: enabled ? 'pointer' : 'default', background: 'transparent', whiteSpace: 'nowrap',
  color: enabled ? 'var(--neox-fg-primary)' : 'var(--neox-fg-hint, #c4c4c8)',
});
const batchMenuBox: React.CSSProperties = {
  position: 'absolute', bottom: 'calc(100% + 10px)', left: '50%', transform: 'translateX(-50%)',
  minWidth: 160, maxHeight: 260, overflowY: 'auto', background: 'var(--neox-bg-card, #fff)',
  border: '1px solid var(--neox-line, rgba(0,0,0,0.12))', borderRadius: 10,
  boxShadow: '0 10px 32px rgba(0,0,0,0.2)', padding: 4,
};

const headBtn: React.CSSProperties = {
  fontSize: 12, padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
  border: '1px solid var(--neox-line, rgba(0,0,0,0.12))', background: 'transparent', color: 'var(--neox-fg-secondary, #6b7280)',
};
const ovBtn: React.CSSProperties = {
  width: 26, height: 26, borderRadius: 7, border: 'none', cursor: 'pointer',
  background: 'rgba(0,0,0,0.55)', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)',
};

export default ImageGalleryPage;
