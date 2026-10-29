
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { directEditImage, directCutoutImage, emitDirectImageTurn, type DirectGenerateResult } from '../../services/imageDirectClient';
import { listImageTemplates, saveImageTemplate, deleteImageTemplate, type ImageTemplate } from '../../state/imageTemplates';
import { runImageTemplate } from '../../services/imageTemplateRunner';
import { PLATFORM_PRESETS, type PlatformPreset } from '../../state/imagePlatformPresets';
import { trackImage } from '../../services/imageTelemetry';
import { ImageParamsButton } from './ImageParamsBar';
import { imageDisplayName, IMAGE_TITLE_CLAMP } from './imageDisplayName';
import { getImageParamValues, buildRequestParams } from '../../state/imageGenParams';
import { useNeoxRuntime } from '../../app/NeoxRuntimeContext';
import { isDefaultSessionName } from '../../hooks/useAgentModeVariant';
import { ProviderBrandIcon, inferProviderBrand } from '../agent-timeline/ProviderBrandIcon';
import { defaultIsZh } from '../../hooks/useI18n';
import { revealInFileManagerLabel } from '../../utils/fileManagerLabels';
import { absoluteToAssetUrl } from '../../../shared/assetUrlPath';

interface ImgModel { id: string; name?: string; provider?: string; providerId?: string; protocol?: string }

/* 图像模型识别 (跟 composer 同口径, 宽松匹配). */
const IMG_MODEL_RE = /image|flux|seedream|dall-?e|nano.?banana|kolors|imagen|recraft|ideogram|grok.?imagine/i;
const isImgModel = (m: { id?: string; name?: string }) => IMG_MODEL_RE.test(`${m.id ?? ''} ${m.name ?? ''}`);

/* 透明棋盘格 (让抠图后的透明区可见) — data URI, 无外部依赖. */
const CHECKER = 'repeating-conic-gradient(rgba(0,0,0,0.06) 0% 25%, transparent 0% 50%) 50% / 20px 20px';

/* 读图片自然尺寸. */
function loadDims(url: string): Promise<{ w: number; h: number } | null> {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => res(null);
    img.src = url;
  });
}
/* 高清放大: 保原比例, 最长边提到 ~3072 (gpt-image-2 上限内), 16 整除. */
async function computeUpscaleSize(fileUrl: string): Promise<string> {
  const d = await loadDims(fileUrl);
  if (!d || !d.w || !d.h) return '2048x2048';
  const long = 3072;
  let ow: number, oh: number;
  if (d.w >= d.h) { ow = long; oh = Math.round((long * d.h) / d.w); }
  else { oh = long; ow = Math.round((long * d.w) / d.h); }
  ow = Math.max(512, Math.round(ow / 16) * 16);
  oh = Math.max(512, Math.round(oh / 16) * 16);
  return `${ow}x${oh}`;
}
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

interface GalleryItem { path: string; fileUrl: string; filename: string; mtime: number; }

interface Props {
  open: boolean;
  /** 打开时定位到这张 (绝对路径). */
  initialPath?: string;
  onClose: () => void;
  zh?: boolean;
}

export const ImageEditorView: React.FC<Props> = ({ open, initialPath, onClose, zh = defaultIsZh() }) => {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [curPath, setCurPath] = useState<string | undefined>(initialPath);
  const [prompt, setPrompt] = useState('');
  const [editing, setEditing] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [notice, setNotice] = useState('');
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  /* 一键能力 = 统一模板引擎的 edit 类模板 (系统 + 用户自建). capsVersion 让"存/删"立即生效. */
  const [capsVersion, setCapsVersion] = useState(0);
  const caps = useMemo<ImageTemplate[]>(() => (open ? listImageTemplates({ mode: 'edit' }) : []), [open, capsVersion]);
  /* + 自定义能力: 名称 + 一句改图提示词 (+ 可选参考图) → saveUserCapability, 加能力=加数据. */
  const [capFormOpen, setCapFormOpen] = useState(false);
  const capFormRef = useRef<HTMLDivElement | null>(null);
  const [capName, setCapName] = useState('');
  const [capPrompt, setCapPrompt] = useState('');
  const [capNeedsRef, setCapNeedsRef] = useState(false);
  useEffect(() => {
    if (!capFormOpen) return;
    const onDown = (e: MouseEvent) => { if (!capFormRef.current?.contains(e.target as Node)) setCapFormOpen(false); };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [capFormOpen]);
  const submitUserCap = useCallback(() => {
    const name = capName.trim(); const p = capPrompt.trim();
    if (!name || !p) return;
    saveImageTemplate({
      id: `user-${Date.now()}`, name, emoji: '✨', mode: 'edit', category: '我的',
      iconPath: 'M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2.1 2.1 M16.3 16.3l2.1 2.1 M18.4 5.6l-2.1 2.1 M7.7 16.3l-2.1 2.1',
      desc: p.length > 60 ? p.slice(0, 60) + '…' : p,
      prompt: p, needsReference: capNeedsRef || undefined,
    });
    setCapName(''); setCapPrompt(''); setCapNeedsRef(false); setCapFormOpen(false);
    setCapsVersion(v => v + 1);
  }, [capName, capPrompt, capNeedsRef]);
  const refInputRef = useRef<HTMLInputElement | null>(null);
  const pendingCapRef = useRef<ImageTemplate | null>(null);
  /* 描述编辑可选带一张参考图 (输入框左侧 + 号上传), 走 img2img references. */
  const [editRef, setEditRef] = useState<string | null>(null);
  const editRefInputRef = useRef<HTMLInputElement | null>(null);
  /* 大图预览弹窗 (毛玻璃遮罩 + 贴合图尺寸卡片) + 悬浮放大按钮定位.
   *   按钮要贴在图片右上角 → 不能靠嵌套 max-height 百分比 (间接父级高度 indefinite 会失效),
   *   改成 JS 算 contain-fit: 自然尺寸 × 舞台可用区 → 给包裹层精确像素, 按钮 absolute 就位. */
  const [zoomOpen, setZoomOpen] = useState(false);
  const [curDims, setCurDims] = useState<{ w: number; h: number } | null>(null);
  const [stageHover, setStageHover] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState<{ w: number; h: number } | null>(null);
  /* 图像模型下拉 (跟 composer 共用 localStorage key, 编辑器里也能切模型对比 gpt-image-2/seedream/gemini). */
  const runtime = useNeoxRuntime();
  const imgModels = useMemo(() => ((runtime as { availableModels?: ImgModel[] }).availableModels ?? []).filter(isImgModel), [runtime]);
  const [modelId, setModelId] = useState<string | null>(() => { try { return window.localStorage.getItem('neox:image-model-id'); } catch { return null; } });
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  /* 展开中的服务商组 (点行尾箭头切换, 内联手风琴 — 不用悬停 fly-out: 悬停触发会在用户
   *   移动鼠标去点击的路上就弹服务商, 体感"点了却出服务商", 用户报 bug). */
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const modelDdRef = useRef<HTMLDivElement | null>(null);
  const model = useMemo(() => imgModels.find(m => m.id === modelId) ?? imgModels[0] ?? null, [imgModels, modelId]);
  /* 两级: 一级=模型短名(带 logo), 二级=服务商. 同一模型多渠道时二级有多项. */
  const modelGroups = useMemo(() => {
    const map = new Map<string, ImgModel[]>();
    for (const m of imgModels) {
      const k = shortModel(m.name || m.id);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(m);
    }
    return Array.from(map, ([name, models]) => ({ name, models }));
  }, [imgModels]);
  const pickModel = useCallback((id: string) => {
    setModelId(id);
    try { window.localStorage.setItem('neox:image-model-id', id); } catch { /* ignore */ }
    setModelMenuOpen(false); setOpenGroup(null);
  }, []);
  /* 点菜单外部才关 (原 onMouseLeave 一出界就消失, 不好点). */
  useEffect(() => {
    if (!modelMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!modelDdRef.current?.contains(e.target as Node)) { setModelMenuOpen(false); setOpenGroup(null); }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [modelMenuOpen]);

  const reload = useCallback(async (selectPath?: string) => {
    const api = (window as any).neox;
    if (!api?.imageGalleryList) return;
    try {
      const rows = await api.imageGalleryList({ limit: 300 });
      const list: GalleryItem[] = Array.isArray(rows) ? rows : [];
      setItems(list);
      if (selectPath) setCurPath(selectPath);
      else if (!list.some(i => i.path === curPath)) setCurPath(list[0]?.path);
    } catch { /* noop */ }
  }, [curPath]);

  useEffect(() => { if (open) { setCurPath(initialPath); void reload(initialPath); } }, [open, initialPath]);
  /* notice (如"模特换装✓") 自动消失, 别一直挂着. */
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(''), 3200);
    return () => window.clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (zoomOpen) { setZoomOpen(false); return; }   // 预览弹窗开着 → Esc 只关弹窗
      if (!editing) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, editing, onClose, zoomOpen]);

  const cur = items.find(i => i.path === curPath) || (curPath ? { path: curPath, fileUrl: pathToAsset(curPath), filename: curPath.split('/').pop() || '', mtime: 0 } : undefined);

  /* 当前图自然尺寸 (悬浮按钮定位 + 预览详情卡的分辨率). */
  useEffect(() => {
    setCurDims(null);
    const url = cur?.fileUrl;
    if (!url) return;
    let alive = true;
    void loadDims(url).then(d => { if (alive) setCurDims(d); });
    return () => { alive = false; };
  }, [cur?.fileUrl]);

  /* 舞台可用区 (减去 28px 内边距), resize 跟手. */
  useEffect(() => {
    if (!open) return;
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStageSize({ w: el.clientWidth - 56, h: el.clientHeight - 56 });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  /* contain-fit: 不放大过自然尺寸 (跟原 maxWidth/maxHeight 行为一致). */
  const fitted = useMemo(() => {
    if (!curDims?.w || !curDims?.h || !stageSize || stageSize.w <= 0 || stageSize.h <= 0) return null;
    const s = Math.min(stageSize.w / curDims.w, stageSize.h / curDims.h, 1);
    return { w: Math.round(curDims.w * s), h: Math.round(curDims.h * s) };
  }, [curDims, stageSize]);

  const emitEditTurn = useCallback(async (label: string, chipLabel: string, res: DirectGenerateResult, sourceUrl?: string, extraRefs?: string[]) => {
    if (!res?.ok) return;
    let s = runtime.activeSession as { id?: string; name?: string; kind?: string } | null;
    if (s?.kind !== 'image') {
      try { s = (await runtime.createNewSession({ kind: 'image' })) as typeof s; } catch { s = null; }
    }
    const targetSid = s?.id || 'image-studio';
    if (s?.id && isDefaultSessionName(s.name)) {
      const t = label.replace(/\s+/g, ' ').trim();
      if (t) void runtime.renameSession(s.id, t.length > 20 ? t.slice(0, 20) + '…' : t).catch(() => { /* 不阻塞 */ });
    }
    const refs = [sourceUrl, ...(extraRefs || [])].filter((x): x is string => !!x);
    emitDirectImageTurn({
      sessionId: targetSid,
      turnId: `edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      prompt: label, chipLabel, createdAt: Date.now(), status: 'ok', result: res,
      refImages: refs.length ? refs : undefined,
    });
  }, [runtime]);

  const runEdit = useCallback(async () => {
    const p = prompt.trim();
    if (!p || !cur || editing) return;
    setEditing(true); setBusyLabel(zh ? '正在编辑…' : 'Editing…'); setNotice('');
    try {
      /* 参数面板 (比例×清晰度→size 等) 跟 composer 同一个 store, 编辑请求真实透传. */
      const gp = buildRequestParams(getImageParamValues());
      const res = await directEditImage({ prompt: p, source: cur.path, references: editRef ? [editRef] : undefined, model: model?.name, size: gp.size });
      if (res.ok && res.paths[0]) {
        void emitEditTurn(p, zh ? '改图' : 'Edit', res, cur.fileUrl, editRef ? [editRef] : undefined);
        trackImage('edit', { withRef: !!editRef }, res.mode);
        setPrompt(''); setEditRef(null);
        await reload(res.paths[0]); // 选中新出的图
      } else if (res.error) {
        setNotice(res.error);
      }
    } finally { setEditing(false); setBusyLabel(''); }
  }, [prompt, cur, editing, reload, zh, editRef, model?.name, emitEditTurn]);

  /* 一键去背景 —— 透明底优先, 上游不支持自动降级白底并提示. */
  const runCutout = useCallback(async () => {
    if (!cur || editing) return;
    setEditing(true); setBusyLabel(zh ? '正在去背景…' : 'Removing background…'); setNotice('');
    try {
      const res = await directCutoutImage(cur.path);
      if (res.ok && res.paths[0]) {
        void emitEditTurn(zh ? '去背景' : 'Remove background', zh ? '去背景' : 'Cutout', res, cur.fileUrl);
        trackImage('cutout', {}, res.mode);
        await reload(res.paths[0]);
        setNotice(res.fellBackToWhite
          ? (zh ? '背景较复杂,已改用纯白底' : 'Complex background — used white backdrop')
          : (zh ? '已去背景 · 透明 PNG (可叠任意背景)' : 'Background removed — transparent PNG'));
      } else {
        setNotice(res.error || (zh ? '去背景失败' : 'Cutout failed'));
      }
    } finally { setEditing(false); setBusyLabel(''); }
  }, [cur, editing, reload, zh, model?.name]);

  /* 一键能力执行 —— 走统一模板引擎 (槽位/steps/模型路由/telemetry 全在 runner 里).
   *   换装需先上传服装图; 放大按原图算目标尺寸传给 runner. */
  const runCapability = useCallback(async (cap: ImageTemplate, referenceDataUrl?: string) => {
    if (!cur || editing) return;
    if (cap.needsReference && !referenceDataUrl) {
      pendingCapRef.current = cap;
      refInputRef.current?.click();   // 弹文件选择, 选完回调再跑
      return;
    }
    let size: string | undefined;
    if (cap.upscale) size = await computeUpscaleSize(cur.fileUrl);
    setEditing(true); setBusyLabel(`${zh ? '正在' : ''}${cap.name}…`); setNotice('');
    try {
      const res = await runImageTemplate({
        template: cap,
        input: cur.path,
        reference: referenceDataUrl,
        model: model?.name,   // 模板指定模型优先; 否则用用户在编辑器选的模型 (runner 内定序)
        size,
      });
      if (res.ok && res.paths[0]) {
        void emitEditTurn(cap.name, cap.name, res, cur.fileUrl, referenceDataUrl ? [referenceDataUrl] : undefined);
        await reload(res.paths[0]); setNotice(`${cap.name} ✓`);
      }
      else setNotice(res.error || `${cap.name}${zh ? '失败' : ' failed'}`);
    } finally { setEditing(false); setBusyLabel(''); }
  }, [cur, editing, reload, zh, model?.name, emitEditTurn]);

  /* 导出 = 在系统文件管理器中定位; 打不开就复制路径兜底 (顶栏 + 预览弹窗共用). */
  const revealCur = useCallback(async () => {
    if (!cur) return;
    const api = (window as any).neox;
    const r = api?.imageRevealFile ? await api.imageRevealFile(cur.path) : (api?.fsRevealInFinder ? await api.fsRevealInFinder(cur.path) : { ok: false });
    if (!(r?.ok ?? r?.success)) { void navigator.clipboard?.writeText(cur.path); setNotice(zh ? '打不开，已复制路径' : "Couldn't open — path copied"); }
  }, [cur, zh]);

  /* 导出下拉: 原图 (Finder) / 各平台尺寸 (淘宝/PDD/小红书/X…) / 全部平台. */
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportDdRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!exportMenuOpen) return;
    const onDown = (e: MouseEvent) => { if (!exportDdRef.current?.contains(e.target as Node)) setExportMenuOpen(false); };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [exportMenuOpen]);
  const exportSizes = useCallback(async (presets: PlatformPreset[]) => {
    if (!cur || presets.length === 0) return;
    setExportMenuOpen(false);
    const api = (window as any).neox;
    if (!api?.imageExportSizes) { setNotice(zh ? '尺寸导出需重启应用后生效' : 'Size export needs an app restart'); return; }
    setNotice(zh ? '正在导出尺寸…' : 'Exporting…');
    const r = await api.imageExportSizes({ source: cur.path, presets: presets.map(({ id, label, w, h, fit }) => ({ id, label, w, h, fit })) });
    setNotice(r?.ok
      ? (zh ? `已导出 ${r.files?.length ?? presets.length} 张 · ${revealInFileManagerLabel(zh)}` : `Exported ${r.files?.length ?? presets.length}`)
      : (r?.error || (zh ? '导出失败' : 'Export failed')));
  }, [cur, zh]);

  /* 分享 = macOS 原生分享菜单 (AirDrop/信息/微信…), 挂在按钮下方弹出. */
  const shareCur = useCallback(async (anchor?: HTMLElement | null) => {
    if (!cur) return;
    const api = (window as any).neox;
    if (!api?.imageShareFile) { setNotice(zh ? '分享需重启应用后生效' : 'Share needs an app restart'); return; }
    const rect = anchor?.getBoundingClientRect();
    const r = await api.imageShareFile(cur.path, rect ? { x: rect.left, y: rect.bottom + 6 } : undefined);
    if (!r?.ok) setNotice(r?.error || (zh ? '分享失败' : 'Share failed'));
  }, [cur, zh]);

  /* 复制图片到剪贴板 (真图, 粘微信/备忘录直接是图). 新 IPC 走 nativeImage; 老 preload 走 canvas 同效. */
  const copyCur = useCallback(async () => {
    if (!cur) return;
    try {
      const api = (window as any).neox;
      if (api?.imageCopyFile) {
        const r = await api.imageCopyFile(cur.path);
        if (!r?.ok) throw new Error(r?.error || 'copy failed');
      } else {
        const img = new Image();
        await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('load failed')); img.src = cur.fileUrl; });
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext('2d')!.drawImage(img, 0, 0);
        const blob = await new Promise<Blob>((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('encode failed'))), 'image/png'));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      }
      setNotice(zh ? '已复制图片' : 'Image copied');
    } catch (err: any) {
      setNotice(`${zh ? '复制失败: ' : 'Copy failed: '}${err?.message || err}`);
    }
  }, [cur, zh]);

  /* 相邻切图 (双指横滑 / ←→ 键). items 顺序 = 缩略图条顺序. */
  const navRel = useCallback((dir: 1 | -1) => {
    if (!items.length) return;
    const idx = items.findIndex(i => i.path === curPath);
    const next = idx < 0 ? 0 : Math.min(items.length - 1, Math.max(0, idx + dir));
    if (items[next] && items[next].path !== curPath) setCurPath(items[next].path);
  }, [items, curPath]);

  /* 触控板手势: 双指横滑累积 deltaX 切上/下一张 (带冷却防连跳); 双指捏合 (Chromium 映射
   *   ctrl+wheel) 张开 = 打开大图预览, 捏拢 = 关闭. 大图舞台和预览弹窗共用. */
  const wheelAcc = useRef(0);
  const wheelLockTs = useRef(0);
  const wheelLastTs = useRef(0);
  const onImageWheel = useCallback((e: React.WheelEvent) => {
    if (editing) return;
    const now = Date.now();
    if (e.ctrlKey) {
      if (now - wheelLockTs.current < 400) return;
      if (e.deltaY < -6) { setZoomOpen(true); wheelLockTs.current = now; }
      else if (e.deltaY > 6) { setZoomOpen(false); wheelLockTs.current = now; }
      return;
    }
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;   // 只认横滑
    if (now - wheelLastTs.current > 300) wheelAcc.current = 0;   // 停顿即重新累积
    wheelLastTs.current = now;
    if (now - wheelLockTs.current < 350) return;
    wheelAcc.current += e.deltaX;
    if (Math.abs(wheelAcc.current) > 70) {
      navRel(wheelAcc.current > 0 ? 1 : -1);
      wheelAcc.current = 0;
      wheelLockTs.current = now;
    }
  }, [editing, navRel]);

  /* ←→ 键切图 (输入框聚焦时不抢). */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
      e.preventDefault();
      navRel(e.key === 'ArrowRight' ? 1 : -1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, navRel]);

  const onRefPicked = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    const cap = pendingCapRef.current;
    pendingCapRef.current = null;
    if (!file || !cap) return;
    void readFileAsDataUrl(file).then((url) => runCapability(cap, url));
  }, [runCapability]);

  if (!open) return null;

  return (
    <div style={{ position: 'absolute', inset: 0, background: 'var(--neox-bg-canvas, #fff)', zIndex: 6, display: 'flex', flexDirection: 'column' }}>
      {/* 顶栏 = 一行搞定: 返回 + 一键能力 + 下载/关闭 (无分割线, 不再单独占一行标题). */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '8px 20px 6px' }}>
        <button type="button" onClick={onClose} title={zh ? '返回' : 'Back'} style={{ ...iconBtn, marginRight: 4 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
        </button>
        {/* 去背景 = 特殊能力 (走 cutout IPC, 绿幕→透明) */}
        <button type="button" className="neox-cap-chip" onClick={() => void runCutout()} disabled={!cur || editing} title={zh ? '去背景 (透明 PNG)' : 'Remove background'}>
          <CapIcon path="M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M20 4 8.5 15.5 M14.5 14.5 20 20 M8.5 8.5 12 12" />
          {zh ? '去背景' : 'Remove BG'}
        </button>
        {caps.map((cap) => (
          <button key={cap.id} type="button" className="neox-cap-chip" onClick={() => void runCapability(cap)} disabled={!cur || editing} title={cap.desc}>
            <CapIcon path={cap.iconPath ?? 'M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2.1 2.1 M16.3 16.3l2.1 2.1 M18.4 5.6l-2.1 2.1 M7.7 16.3l-2.1 2.1'} />
            {cap.name}
          </button>
        ))}
        {/* + 自定义能力 —— 把常用的一句改图提示词存成一键 chip (spec: 加能力 = 加数据). */}
        <div ref={capFormRef} style={{ position: 'relative' }}>
          <button type="button" className="neox-cap-chip" onClick={() => setCapFormOpen(o => !o)} title={zh ? '自定义能力: 存一句改图提示词, 以后一键用' : 'Save a custom one-click edit'}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
          {capFormOpen && (
            <div style={{ position: 'absolute', top: 'calc(100% + 8px)', left: 0, zIndex: 40, width: 288, background: 'var(--neox-bg-card, #fff)', border: '1px solid var(--neox-line, rgba(0,0,0,0.12))', borderRadius: 12, boxShadow: '0 12px 34px rgba(0,0,0,0.2)', padding: 12, display: 'flex', flexDirection: 'column', gap: 9 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--neox-fg-primary)' }}>{zh ? '自定义能力' : 'Custom capability'}</div>
              <input value={capName} onChange={e => setCapName(e.target.value)} placeholder={zh ? '名称 (如 复古滤镜)' : 'Name'}
                style={{ fontSize: 13, padding: '7px 9px', borderRadius: 8, border: '1px solid var(--neox-line, rgba(0,0,0,0.12))', background: 'transparent', color: 'var(--neox-fg-primary)', outline: 'none' }} />
              <textarea value={capPrompt} onChange={e => setCapPrompt(e.target.value)} rows={3} placeholder={zh ? '改图提示词 (对图片做什么)' : 'Edit prompt'}
                style={{ fontSize: 13, padding: '7px 9px', borderRadius: 8, border: '1px solid var(--neox-line, rgba(0,0,0,0.12))', background: 'transparent', color: 'var(--neox-fg-primary)', outline: 'none', resize: 'none', lineHeight: 1.5 }} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--neox-fg-secondary, #6b7280)', cursor: 'pointer' }}>
                <input type="checkbox" checked={capNeedsRef} onChange={e => setCapNeedsRef(e.target.checked)} />
                {zh ? '需要上传一张参考图 (如换装的服装图)' : 'Needs a reference image'}
              </label>
              <button type="button" onClick={submitUserCap} disabled={!capName.trim() || !capPrompt.trim()}
                style={{ padding: '8px 12px', borderRadius: 9, border: 'none', cursor: capName.trim() && capPrompt.trim() ? 'pointer' : 'default', background: capName.trim() && capPrompt.trim() ? 'var(--neox-primary-500, #3b82f6)' : 'var(--neox-bg-subtle, rgba(0,0,0,0.08))', color: '#fff', fontSize: 13, fontWeight: 600 }}>
                {zh ? '保存能力' : 'Save'}
              </button>
              {caps.some(c => c.source === 'user') && (
                <div style={{ borderTop: '1px solid var(--neox-line, rgba(0,0,0,0.08))', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ fontSize: 10.5, color: 'var(--neox-fg-secondary, #9ca3af)' }}>{zh ? '我的能力' : 'My capabilities'}</div>
                  {caps.filter(c => c.source === 'user').map(c => (
                    <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--neox-fg-primary)' }}>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                      <button type="button" onClick={() => { deleteImageTemplate(c.id); setCapsVersion(v => v + 1); }} title={zh ? '删除' : 'Delete'}
                        style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--neox-fg-hint, #b0b4bb)', fontSize: 13, padding: '0 3px' }}>×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div style={{ flex: 1 }} />
        {/* 分享 (macOS 原生分享菜单) + 复制图片 —— 导出左侧. */}
        <button type="button" onClick={(e) => void shareCur(e.currentTarget)} disabled={!cur} title={zh ? '分享 (AirDrop/信息…)' : 'Share'} style={iconBtn}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" /><path d="m16 6-4-4-4 4" /><path d="M12 2v13" /></svg>
        </button>
        <button type="button" onClick={() => void copyCur()} disabled={!cur} title={zh ? '复制图片' : 'Copy image'} style={iconBtn}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
        </button>
        <div ref={exportDdRef} style={{ position: 'relative' }}>
          <button type="button" onClick={() => setExportMenuOpen(o => !o)} disabled={!cur} title={zh ? '导出' : 'Export'} style={pillBtn}>
            {zh ? '导出' : 'Export'} <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
          </button>
          {exportMenuOpen && (
            <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 40, minWidth: 200, background: 'var(--neox-bg-card, #fff)', border: '1px solid var(--neox-line, rgba(0,0,0,0.12))', borderRadius: 12, boxShadow: '0 12px 34px rgba(0,0,0,0.2)', padding: 5 }}>
              <button type="button" onClick={() => { setExportMenuOpen(false); void revealCur(); }} style={exportRow}>
                {`${zh ? '原图' : 'Original'} · ${revealInFileManagerLabel(zh)}`}
              </button>
              <div style={{ fontSize: 10.5, color: 'var(--neox-fg-secondary, #9ca3af)', padding: '6px 9px 3px' }}>{zh ? '平台尺寸' : 'Platform sizes'}</div>
              {PLATFORM_PRESETS.map(p => (
                <button key={p.id} type="button" onClick={() => void exportSizes([p])} style={exportRow}>
                  <span style={{ flex: 1 }}>{zh ? p.label : p.labelEn}</span>
                  <span style={{ fontSize: 11, color: 'var(--neox-fg-hint, #b0b4bb)' }}>{p.w}×{p.h}</span>
                </button>
              ))}
              <button type="button" onClick={() => void exportSizes(PLATFORM_PRESETS)} style={{ ...exportRow, fontWeight: 600 }}>
                {zh ? '全部平台一次导出' : 'Export all platforms'}
              </button>
            </div>
          )}
        </div>
        <input ref={refInputRef} type="file" accept="image/*" hidden onChange={onRefPicked} />
      </div>

      {/* 主体: 左缩略图网格 + 中大图 (无竖直分割线) */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ width: 188, flexShrink: 0, overflowY: 'auto', padding: '14px 16px 20px 22px' }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            {[0, 1].map(col => (
              <div key={col} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
                {items.filter((_, i) => i % 2 === col).map(it => (
                  <button key={it.path} type="button" onClick={() => setCurPath(it.path)}
                    /* 每格都描一条淡边 —— 白底图 (苹果/仙人掌/香蕉) 否则跟条背景白融一块看不出间距. */
                    style={{ display: 'block', width: '100%', border: it.path === curPath ? '2px solid var(--neox-primary-500, #3b82f6)' : '2px solid var(--neox-line, rgba(0,0,0,0.12))', borderRadius: 10, overflow: 'hidden', padding: 0, cursor: 'pointer', background: 'var(--neox-bg-subtle, rgba(0,0,0,0.04))', boxSizing: 'border-box', flexShrink: 0 }}>
                    <img src={it.fileUrl} alt={it.filename} loading="lazy" style={{ width: '100%', height: 'auto', display: 'block' }} />
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
        {/* 中间大图 */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div ref={stageRef} onMouseEnter={() => setStageHover(true)} onMouseLeave={() => setStageHover(false)} onWheel={onImageWheel}
            style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 28, position: 'relative' }}>
            {cur && fitted && (
              /* 包裹层 = 图片渲染框的精确像素 → 悬浮按钮贴图片右上角 (不贴舞台角). */
              <div style={{ position: 'relative', width: fitted.w, height: fitted.h, flexShrink: 0 }}>
                {/* 图片本身垫棋盘格: 不透明图完全盖住格子, 透明抠图则透出格子 (标准编辑器做法). */}
                <img src={cur.fileUrl} alt={cur.filename} onClick={() => setZoomOpen(true)}
                  style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 10, boxShadow: '0 8px 30px rgba(0,0,0,0.12)', background: CHECKER, cursor: 'zoom-in', display: 'block' }} />
                {/* 悬浮放大按钮 —— hover 淡入, 点开毛玻璃大图预览. */}
                {!editing && (
                  <button type="button" onClick={() => setZoomOpen(true)} title={zh ? '放大预览' : 'Zoom in'}
                    style={{ position: 'absolute', top: 10, right: 10, width: 34, height: 34, borderRadius: '50%', border: 'none', cursor: 'pointer', background: 'rgba(17,24,39,0.55)', color: '#fff', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 10px rgba(0,0,0,0.25)', opacity: stageHover ? 1 : 0, transform: stageHover ? 'scale(1)' : 'scale(0.92)', transition: 'opacity 140ms ease, transform 140ms ease', pointerEvents: stageHover ? 'auto' : 'none' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="M21 3l-7.5 7.5" /><path d="M3 21l7.5-7.5" /></svg>
                  </button>
                )}
              </div>
            )}
            {/* 自然尺寸还没量出来的一帧: 按老方式直接放, 避免闪空. */}
            {cur && !fitted && (
              <img src={cur.fileUrl} alt={cur.filename} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 10, boxShadow: '0 8px 30px rgba(0,0,0,0.12)', background: CHECKER }} />
            )}
            {!cur && <span style={{ color: 'var(--neox-fg-secondary)', fontSize: 13 }}>{zh ? '暂无图片' : 'No image'}</span>}
            {editing && (
              <div style={{ position: 'absolute', inset: 28, borderRadius: 10, background: 'rgba(255,255,255,0.55)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span className="neox-text-shimmer" style={{ fontSize: 15, fontWeight: 600 }}>{busyLabel || (zh ? '正在编辑…' : 'Editing…')}</span>
              </div>
            )}
            {notice && !editing && (
              <div style={{ position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)', maxWidth: '80%', padding: '6px 14px', borderRadius: 999, background: 'rgba(17,24,39,0.86)', color: '#fff', fontSize: 12, fontWeight: 500, boxShadow: '0 4px 14px rgba(0,0,0,0.2)' }}
                onClick={() => setNotice('')}>
                {notice}
              </div>
            )}
          </div>
          {/* 底部 描述编辑 —— 单行 pill (对标主输入框收起态): + 上传参考图 · 文本 · 发送 */}
          <div style={{ padding: '4px 28px 26px' }}>
            <div style={{ maxWidth: 880, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--neox-line, rgba(0,0,0,0.14))', borderRadius: 999, padding: '5px 6px 5px 6px', background: 'var(--neox-bg-card, #fff)' }}>
              <button type="button" onClick={() => editRefInputRef.current?.click()} title={zh ? '加参考图 (可选)' : 'Add reference'}
                style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', cursor: 'pointer', flexShrink: 0, background: 'transparent', color: 'var(--neox-fg-secondary, #6b7280)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
              </button>
              {editRef && (
                <span style={{ position: 'relative', flexShrink: 0, width: 30, height: 30, borderRadius: 7, overflow: 'hidden', border: '1px solid var(--neox-line, rgba(0,0,0,0.12))' }}>
                  <img src={editRef} alt="ref" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  <button type="button" onClick={() => setEditRef(null)} title={zh ? '移除' : 'Remove'}
                    style={{ position: 'absolute', right: 0, top: 0, width: 14, height: 14, border: 'none', background: 'rgba(0,0,0,0.6)', color: '#fff', cursor: 'pointer', fontSize: 10, lineHeight: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
                </span>
              )}
              <textarea ref={taRef} rows={1} value={prompt} onChange={e => setPrompt(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void runEdit(); } }}
                placeholder={zh ? '描述编辑 · Enter 出图' : 'Describe the edit · Enter'}
                style={{ flex: 1, resize: 'none', border: 'none', outline: 'none', background: 'transparent', fontSize: 14, lineHeight: 1.5, color: 'var(--neox-fg-primary)', maxHeight: 96, padding: '6px 4px', alignSelf: 'center' }} />
              {/* 出图参数 (比例/清晰度/质量…) —— 跟主输入框同一个面板同一个 store. */}
              <ImageParamsButton modelName={model?.name} zh={zh} />
              {/* 模型下拉 (无边框, 带品牌 logo) —— 只有多个图像模型才露出 (单模型用户不该看到"模型"概念). */}
              {imgModels.length > 1 && (
                <div ref={modelDdRef} style={{ position: 'relative', flexShrink: 0 }}>
                  <button type="button" onClick={() => setModelMenuOpen(o => !o)} title={zh ? '切换模型' : 'Switch model'}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 30, padding: '0 8px', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--neox-fg-secondary, #6b7280)', fontSize: 12.5, maxWidth: 190 }}>
                    {model && <ProviderBrandIcon brand={inferProviderBrand(model)} size={15} />}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortModel(model?.name || model?.id)}</span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
                  </button>
                  {modelMenuOpen && (
                    <div style={{ position: 'absolute', bottom: 'calc(100% + 8px)', right: 0, zIndex: 30, minWidth: 220, maxWidth: 260, maxHeight: 340, overflowY: 'auto', background: 'var(--neox-bg-card, #fff)', border: '1px solid var(--neox-line, rgba(0,0,0,0.12))', borderRadius: 12, boxShadow: '0 12px 34px rgba(0,0,0,0.2)', padding: 5 }}>
                      {modelGroups.map(g => {
                        const activeHere = g.models.some(m => m.id === model?.id);
                        const multi = g.models.length > 1;
                        const expanded = multi && openGroup === g.name;
                        return (
                          <div key={g.name}>
                            {/* 一级: 点行 = 直接选中并关菜单 (已在该组则保持当前服务商). 多渠道时行尾单独一个
                             *   箭头按钮, **点击**才展开内联服务商列表 —— 不用悬停 fly-out (点行路上就弹, 像 bug). */}
                            <div style={{ display: 'flex', alignItems: 'center', borderRadius: 8, background: activeHere ? 'var(--neox-bg-subtle, rgba(0,0,0,0.05))' : 'transparent' }}>
                              <button type="button" onClick={() => pickModel(activeHere && model ? model.id : g.models[0].id)}
                                style={{ display: 'flex', alignItems: 'center', gap: 9, flex: 1, minWidth: 0, textAlign: 'left', padding: '7px 4px 7px 9px', border: 'none', cursor: 'pointer', background: 'transparent' }}>
                                <ProviderBrandIcon brand={inferProviderBrand(g.models[0])} size={18} />
                                <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: activeHere ? 600 : 500, color: 'var(--neox-fg-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name}</span>
                                {activeHere && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--neox-primary-500, #3b82f6)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M20 6 9 17l-5-5" /></svg>}
                              </button>
                              {multi && (
                                <button type="button" title={zh ? '选择服务商' : 'Choose provider'}
                                  onClick={(e) => { e.stopPropagation(); setOpenGroup(expanded ? null : g.name); }}
                                  style={{ flexShrink: 0, width: 26, height: 30, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--neox-fg-secondary, #9ca3af)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 120ms ease' }}><path d="m6 9 6 6 6-6" /></svg>
                                </button>
                              )}
                            </div>
                            {/* 二级: 服务商 (内联手风琴, 只多渠道才有) */}
                            {expanded && (
                              <div style={{ padding: '2px 4px 5px 32px', display: 'flex', flexDirection: 'column', gap: 1 }}>
                                {g.models.map(m => {
                                  const act = m.id === model?.id;
                                  return (
                                    <button key={m.id} type="button" onClick={() => pickModel(m.id)}
                                      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', fontSize: 12.5, padding: '5px 8px', borderRadius: 7, border: 'none', cursor: 'pointer', background: act ? 'var(--neox-bg-subtle, rgba(0,0,0,0.05))' : 'transparent', color: 'var(--neox-fg-primary)', fontWeight: act ? 600 : 500 }}>
                                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.provider || m.providerId || providerOf(m)}</span>
                                      {act && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--neox-primary-500, #3b82f6)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M20 6 9 17l-5-5" /></svg>}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              <button type="button" onClick={() => void runEdit()} disabled={!prompt.trim() || editing || !cur} title={zh ? '出图 (Enter)' : 'Generate'}
                style={{ width: 34, height: 34, borderRadius: '50%', border: 'none', cursor: prompt.trim() && !editing ? 'pointer' : 'default', background: prompt.trim() && !editing ? 'var(--neox-primary-500, #3b82f6)' : 'var(--neox-bg-subtle, rgba(0,0,0,0.08))', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
              </button>
              <input ref={editRefInputRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void readFileAsDataUrl(f).then(setEditRef); }} />
            </div>
          </div>
        </div>
        {/* 右侧留白 = 左缩略图宽, 让大图真正在窗口居中 (全展开时不再偏右). */}
        <div style={{ width: 188, flexShrink: 0 }} aria-hidden />
      </div>

      {/* 大图预览弹窗 —— 毛玻璃遮罩 + 卡片贴合图片尺寸零黑边 + 右详情卡 (跟灵感预览同范式).
       *  portal 到 body 逃离 transform/filter 祖先, z-index 顶到极大盖住 titlebar. */}
      {zoomOpen && cur && createPortal(
        <div onClick={() => setZoomOpen(false)} onWheel={onImageWheel}
          style={{ position: 'fixed', inset: 0, zIndex: 2147483000, background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40, cursor: 'zoom-out' }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ display: 'flex', maxWidth: '92vw', maxHeight: '84vh', background: 'var(--neox-bg-card, #fff)', borderRadius: 16, overflow: 'hidden', boxShadow: '0 30px 80px rgba(0,0,0,0.4)', cursor: 'default' }}>
            {/* 左: 大图 — 面板贴合图片本身尺寸 (竖图窄面板 / 横图宽面板); 棋盘格透出透明区. */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--neox-bg-subtle, #f4f4f5)', flexShrink: 0 }}>
              <img src={cur.fileUrl} alt={cur.filename}
                style={{ maxHeight: '84vh', maxWidth: 'min(64vw, calc(92vw - 300px))', width: 'auto', height: 'auto', objectFit: 'contain', display: 'block', background: CHECKER }} />
            </div>
            {/* 右: 详情卡 */}
            <div style={{ width: 300, flexShrink: 0, padding: 22, display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}>
              <div>
                <div title={imageDisplayName(cur.filename).full}
                  style={{ fontSize: 16, fontWeight: 700, color: 'var(--neox-fg-primary)', letterSpacing: '-0.01em', lineHeight: 1.35, ...IMAGE_TITLE_CLAMP }}>{imageDisplayName(cur.filename).title}</div>
                <div style={{ fontSize: 12, color: 'var(--neox-fg-secondary, #9ca3af)', marginTop: 3 }}>{zh ? '本会话生成图' : 'Generated in this session'}</div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', rowGap: 12, columnGap: 16 }}>
                {[
                  [zh ? '分辨率' : 'Resolution', curDims ? `${curDims.w}×${curDims.h}` : (zh ? '加载中…' : '…')],
                  [zh ? '格式' : 'Format', (cur.filename.split('.').pop() || 'PNG').toUpperCase()],
                  [zh ? '生成时间' : 'Created', cur.mtime ? new Date(cur.mtime).toLocaleString() : '—'],
                ].map(([k, v]) => (
                  <div key={k}>
                    <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--neox-fg-secondary, #9ca3af)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 3 }}>{k}</div>
                    <div style={{ fontSize: 13, color: 'var(--neox-fg-primary)', fontWeight: 500 }}>{v}</div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <button type="button" onClick={() => void revealCur()}
                  style={{ padding: '11px 16px', borderRadius: 11, border: 'none', cursor: 'pointer', background: 'linear-gradient(135deg,#3b82f6,#2563eb)', color: '#fff', fontSize: 14, fontWeight: 600, boxShadow: '0 4px 14px rgba(37,99,235,0.35)' }}>
                  {`${zh ? '导出' : 'Export'} · ${revealInFileManagerLabel(zh)}`}
                </button>
                <button type="button" onClick={() => setZoomOpen(false)}
                  style={{ padding: '10px 16px', borderRadius: 11, cursor: 'pointer', border: '1px solid var(--neox-line, rgba(0,0,0,0.12))', background: 'transparent', color: 'var(--neox-fg-secondary, #6b7280)', fontSize: 13.5, fontWeight: 500 }}>
                  {zh ? '关闭 (Esc)' : 'Close (Esc)'}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

/** 模型短名: 去掉 provider 前缀 (openai/gpt-image-2 → gpt-image-2). */
function shortModel(id?: string): string {
  if (!id) return '选择模型';
  const parts = id.split('/');
  return parts[parts.length - 1];
}
/** 提供商: 取前缀 (openai/gpt-image-2 → openai; 无前缀 → default). */
function providerOf(m: { id: string; name?: string }): string {
  const s = m.name || m.id;
  return s.includes('/') ? s.split('/')[0] : 'default';
}
const pathToAsset = absoluteToAssetUrl;
const iconBtn: React.CSSProperties = { width: 32, height: 32, borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--neox-fg-secondary, #6b7280)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' };
const pillBtn: React.CSSProperties = { fontSize: 12, padding: '6px 12px', borderRadius: 8, cursor: 'pointer', border: '1px solid var(--neox-line, rgba(0,0,0,0.12))', background: 'transparent', color: 'var(--neox-fg-secondary, #6b7280)' };
const exportRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', fontSize: 12.5, padding: '7px 9px', borderRadius: 8, border: 'none', cursor: 'pointer', background: 'transparent', color: 'var(--neox-fg-primary)' };
/* 单色黑线条 icon (24 viewBox, path 支持多段 M). */
const CapIcon: React.FC<{ path: string }> = ({ path }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={path} /></svg>
);

export default ImageEditorView;
