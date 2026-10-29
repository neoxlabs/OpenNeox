
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DirectImageTurns, directImageTurnCount, clearDirectImageTurns } from '../agent-timeline/DirectImageTurns';
import TimelineComposer from '../agent-timeline/TimelineComposer';
import { ImageGalleryPage } from './ImageGalleryPage';
import { CATEGORIES, fillFromCategory } from './ImageDiscoveryLanding';
import { ImageEditorView } from './ImageEditorView';
import { useNeoxRuntime } from '../../app/NeoxRuntimeContext';
import { useI18n } from '../../hooks/useI18n';
import imageArt from '../../media/clay/tool-image.webp';
import './image-chat.css';


/** 图库徽章只拉这么多 —— 徽章因此只能表达"至少这么多", 见下方渲染处注释。 */
const GALLERY_STRIP_LIMIT = 60;
/* 空态下面那排常用方向: 证件照 / 头像 / 婚纱照 / 电商主图 / 美食 / 手办 / 小红书封面 */
const STARTERS = CATEGORIES.slice(1, 8);

interface Props {
  /** 语言覆盖 —— **只给测试/预览用**。正常渲染不要传, 让它跟随全局语言。 */
  zh?: boolean;
}

interface GalleryItem {
  path: string;
  fileUrl: string;
  filename: string;
  mtime: number;
}

export const ImageStudioPage: React.FC<Props> = ({ zh: zhOverride }) => {
  const { isZh } = useI18n();
  const zh = zhOverride ?? isZh;
  const runtime = useNeoxRuntime();
  const [scratch, setScratch] = useState(false);
  const scratchBaseRef = useRef<string | null>(null);
  /* 统一会话主线: 绑定到当前 kind=image 会话; scratch 态 或 非图片会话 → 用 'image-studio' 空槽.
   * liveTurnSid: 发送瞬间 createSession 的新 id 往往比 React activeSession 早一拍 —
   *   立刻跟 turn 事件走, 避免 DirectImageTurns 还盯着 'image-studio' 而图落到真 session 槽. */
  const activeSess = runtime.activeSession as { id?: string; kind?: string } | null;
  const [liveTurnSid, setLiveTurnSid] = useState<string | null>(null);
  const imageSessionId = (!scratch && activeSess?.kind === 'image')
    ? activeSess.id!
    : (liveTurnSid || 'image-studio');
  useEffect(() => { (window as { __neoxImageScratch?: boolean }).__neoxImageScratch = scratch; }, [scratch]);
  /* 给 IPC→timeline 桥接用: 裸 generate 成功时把 turn 落到当前图片页正在看的槽. */
  useEffect(() => {
    (window as { __neoxActiveImageSessionId?: string }).__neoxActiveImageSessionId = imageSessionId;
    return () => {
      const w = window as { __neoxActiveImageSessionId?: string };
      if (w.__neoxActiveImageSessionId === imageSessionId) delete w.__neoxActiveImageSessionId;
    };
  }, [imageSessionId]);
  /* "新建图片"信号 → 进 scratch, 记下当下活动会话 id 作基准. */
  useEffect(() => {
    /* 「新建图片」= 真的给一块空白画布。只置 scratch 不够 —— 草稿槽 image-studio 里
     *   还躺着上一次的出图 (内存 + 盘), 用户点完看到的还是上一张, 以为按钮坏了。 */
    const onNew = () => {
      scratchBaseRef.current = (runtime.activeSession as { id?: string } | null)?.id ?? null;
      clearDirectImageTurns('image-studio');
      setLiveTurnSid(null);
      setHasContent(false);
      setScratch(true);
    };
    window.addEventListener('neox:image-new-canvas', onNew);
    return () => window.removeEventListener('neox:image-new-canvas', onNew);
  }, [runtime]);
  /* 活动会话变成"另一个"图片会话 (发送后现建的那个) → 退出 scratch, 绑到它. */
  useEffect(() => {
    if (scratch && activeSess?.kind === 'image' && activeSess.id && activeSess.id !== scratchBaseRef.current) setScratch(false);
  }, [scratch, activeSess?.id, activeSess?.kind]);
  /* activeSession 已跟上真图片会话后, 清掉 liveTurnSid 过渡态. */
  useEffect(() => {
    if (!scratch && activeSess?.kind === 'image' && activeSess.id && liveTurnSid && liveTurnSid === activeSess.id) {
      setLiveTurnSid(null);
    }
  }, [scratch, activeSess?.id, activeSess?.kind, liveTurnSid]);
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);
  const [lightbox, setLightbox] = useState<GalleryItem | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [editorPath, setEditorPath] = useState<string | null>(null);
  /* 会话是否已有出图 — 空态 = 居中问一句 + 常用方向, 有内容 = 对话流 + 输入框沉底. */
  const [hasContent, setHasContent] = useState(false);
  const [showcase, setShowcase] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    const api = (window as unknown as { neox?: { imageShowcase?: () => Promise<Record<string, string>> } }).neox;
    void api?.imageShowcase?.().then((m) => { if (alive && m) setShowcase(m); }).catch(() => { /* 没有示例图就用渐变 + emoji */ });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    const onRefresh = () => setRefreshTick(t => t + 1);
    window.addEventListener('neox:image-gallery-refresh', onRefresh);
    return () => window.removeEventListener('neox:image-gallery-refresh', onRefresh);
  }, []);
  useEffect(() => {
    let alive = true;
    /* 先用内存里已有的 turn 数(含未落盘的 pending)判, 切回会话立刻显内容, 不闪空态.
     * 再用 DB 兜底确认 (只会把 false 抬成 true, 不清掉内存已有的). */
    setHasContent(directImageTurnCount(imageSessionId) > 0);
    const api = (window as any).neox;
    if (api?.imageListTurns) {
      void api.imageListTurns(imageSessionId).then((rows: unknown[]) => {
        if (alive && Array.isArray(rows) && rows.length > 0) setHasContent(true);
      }).catch(() => { /* noop */ });
    }
    /* turn 到来时: 跟到真实 sessionId (修发送瞬间槽错位), 并翻 hasContent.
     * 草稿槽 image-studio 与当前页绑定的 sid 都认; 后台其它会话不打扰空态. */
    const onTurn = (e: Event) => {
      const sid = (e as CustomEvent).detail?.sessionId as string | undefined;
      if (sid && sid !== 'image-studio' && sid !== imageSessionId) {
        /* 本页正在出图 / scratch: 跟到新会话槽 */
        if (scratch || imageSessionId === 'image-studio' || sid === liveTurnSid) {
          setLiveTurnSid(sid);
          setHasContent(true);
        }
        return;
      }
      if (!sid || sid === imageSessionId || sid === 'image-studio') setHasContent(true);
    };
    window.addEventListener('neox:direct-image-turn', onTurn as EventListener);
    return () => { alive = false; window.removeEventListener('neox:direct-image-turn', onTurn as EventListener); };
  }, [imageSessionId, scratch, liveTurnSid]);

  /* 拉历史图库 (只为右上角徽章的数) — 出新图时也会 refresh. */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const api = (window as any).neox;
        if (!api?.imageGalleryList) { setGallery([]); return; }
        const items = await api.imageGalleryList({ limit: GALLERY_STRIP_LIMIT });
        if (alive) setGallery(Array.isArray(items) ? items : []);
      } catch {
        if (alive) setGallery([]);
      }
    })();
    return () => { alive = false; };
  }, [refreshTick]);

  useEffect(() => {
    const onTurn = (evt: Event) => {
      const detail = (evt as CustomEvent).detail;
      if (detail?.status === 'ok') {
        window.setTimeout(() => setRefreshTick(t => t + 1), 300);
      }
    };
    window.addEventListener('neox:direct-image-turn', onTurn as EventListener);
    return () => window.removeEventListener('neox:direct-image-turn', onTurn as EventListener);
  }, []);

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightbox(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [lightbox]);

  useEffect(() => {
    if (galleryOpen || editorPath) return;
    const fileToAttach = (file: File) => {
      const r = new FileReader();
      r.onload = () => window.dispatchEvent(new CustomEvent('neox:image-attach', { detail: { dataUrl: String(r.result), name: file.name } }));
      r.readAsDataURL(file);
    };
    const onDrop = (e: DragEvent) => {
      const imgs = Array.from(e.dataTransfer?.files || []).filter((x) => x.type.startsWith('image/'));
      if (imgs.length) { e.preventDefault(); e.stopPropagation(); imgs.forEach(fileToAttach); }
    };
    const onDragOver = (e: DragEvent) => { if (Array.from(e.dataTransfer?.items || []).some((i) => i.kind === 'file')) e.preventDefault(); };
    const onPaste = (e: ClipboardEvent) => {
      const imgs = Array.from(e.clipboardData?.items || []).filter((x) => x.type.startsWith('image/'));
      const files = imgs.map((it) => it.getAsFile()).filter((f): f is File => !!f);
      if (files.length) { e.preventDefault(); e.stopPropagation(); files.forEach(fileToAttach); }
    };
    window.addEventListener('drop', onDrop, true);
    window.addEventListener('dragover', onDragOver, true);
    window.addEventListener('paste', onPaste, true);
    return () => { window.removeEventListener('drop', onDrop, true); window.removeEventListener('dragover', onDragOver, true); window.removeEventListener('paste', onPaste, true); };
  }, [galleryOpen, editorPath]);

  useEffect(() => {
    const onOpen = (evt: Event) => {
      const d = (evt as CustomEvent).detail as { url?: string; path?: string; filename?: string; mtime?: number };
      if (d?.path) { setEditorPath(d.path); return; }
      if (d?.url) setLightbox({ path: '', fileUrl: d.url, filename: d.filename ?? '', mtime: d.mtime ?? Date.now() });
    };
    window.addEventListener('neox:image-lightbox', onOpen as EventListener);
    return () => window.removeEventListener('neox:image-lightbox', onOpen as EventListener);
  }, []);

  return (
    <div className="atl-page imgchat">
      {!galleryOpen && !editorPath && (
        <div className={`imgchat__grid${hasContent ? ' has-content' : ''}`}>
          <div className="imgchat__top">
            {hasContent ? (
              <div className="imgchat__col"><DirectImageTurns sessionId={imageSessionId} zh={zh} studio /></div>
            ) : (
              <div className="imgchat__hero">
                <img src={imageArt} alt="" draggable={false} />
                <h1>{zh ? '想要一张什么样的图？' : 'What would you like to see?'}</h1>
                <p>{zh ? '说一句就出图，不满意接着说，在同一张上改' : 'Describe it and get a set — keep talking to refine the same image'}</p>
              </div>
            )}
          </div>
          <div className="imgchat__composer">
            <div className="imgchat__col">
              <TimelineComposer
                flat
                defaultIntentIds={['create-image']}
                placeholderOverride={hasContent
                  ? (zh ? '接着说怎么改，或者描述一张新的…' : 'Say how to change it, or describe a new one…')
                  : (zh ? '描述画面：主体 · 风格 · 构图 · 光影' : 'Describe it: subject · style · composition · lighting')}
                onSubmit={() => { /* no-op: image studio 不走 chat */ }}
              />
            </div>
          </div>
          <div className="imgchat__bottom">
            {!hasContent && (
              <div className="imgchat__starters">
                {STARTERS.map((c) => (
                  <button key={c.key} type="button" className="imgchat__starter" onClick={() => fillFromCategory(c)} title={zh ? '点一下填进描述' : 'Click to prefill'}>
                    <span className="imgchat__starter-img" style={showcase[c.key] ? undefined : { background: c.gradient }}>
                      {showcase[c.key] ? <img src={showcase[c.key]} alt="" loading="lazy" /> : <em>{c.emoji}</em>}
                    </span>
                    <span>{zh ? c.labelZh : c.labelEn}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 图库: 原来页头一排按钮收成右上角这一颗 */}
      {!galleryOpen && !editorPath && (
        <button type="button" className="imgchat__gallery-btn" onClick={() => setGalleryOpen(true)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
          {zh ? '图库' : 'Gallery'}
          {/* 这里显示的是**已加载条数**, 不是图库总数 —— 只拉了 GALLERY_STRIP_LIMIT 条。装满时显示 "60+"。 */}
          {gallery.length > 0 && <em>{gallery.length >= GALLERY_STRIP_LIMIT ? `${GALLERY_STRIP_LIMIT}+` : gallery.length}</em>}
        </button>
      )}

      {/* 图库视图 — 只填内容区 (右侧), 不盖框架. */}
      <ImageGalleryPage open={galleryOpen} onClose={() => setGalleryOpen(false)} zh={zh} />

      {/* 独立编辑页 — 点图打开, 只填内容区 (左侧栏+顶栏不变). */}
      <ImageEditorView open={!!editorPath} initialPath={editorPath ?? undefined} onClose={() => setEditorPath(null)} zh={zh} />

      {/* Lightbox — portal 到 body 逃离 .atl-page 里可能有 transform/filter 的祖先.
       *  z-index 8200: 高于 titlebar(5000), 低于 AppShell 切换幕布(8500)/系统弹窗(9998+). */}
      {lightbox && createPortal(
        <div
          onClick={() => setLightbox(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.92)', zIndex: 8200,
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out',
            padding: 40,
          }}
        >
          <img
            src={lightbox.fileUrl}
            alt={lightbox.filename}
            style={{ maxWidth: '100%', maxHeight: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.5)', borderRadius: 8 }}
            onClick={(e) => e.stopPropagation()}
          />
          <div
            style={{
              position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)',
              padding: '6px 14px', background: 'rgba(0,0,0,0.6)', borderRadius: 999,
              color: 'white', fontSize: 12,
            }}
          >
            {lightbox.filename} · {new Date(lightbox.mtime).toLocaleString()}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

export default ImageStudioPage;
