/* ============================================================
 * MessageAttachmentChip + Lightbox — message bubble 附件渲染 + 图片放大
 *   从 MessageRow.tsx 抽出 (Phase 3.6), UserCell / AssistantTextCell 共用.
 * ============================================================ */

import React from 'react';
import { createPortal } from 'react-dom';
import type { MessageAttachment } from '../types';
import { useI18n } from '../../../hooks/useI18n';
import { useEscClose } from '../../../hooks/useEscClose';
import { usePanZoom } from '../../../hooks/usePanZoom';

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const MessageAttachmentChip: React.FC<{
  att: MessageAttachment;
  onPreview: (url: string) => void;
}> = ({ att, onPreview }) => {
  const { isZh } = useI18n();
  if (att.kind === 'image' && att.data) {
    return (
      <button
        type="button"
        className="atl-msg__att atl-msg__att--image"
        onClick={() => onPreview(att.data!)}
        title={att.name ?? (isZh ? '图片' : 'Image')}
      >
        {/* draggable=false: 缩略图误拖会出"幽灵图"还可能误 drop 回 composer 变成重复附件 */}
        <img src={att.data} alt={att.name ?? ''} draggable={false} />
      </button>
    );
  }
  const displayName = att.name ?? att.path ?? (att.kind === 'url' ? att.data : (isZh ? '附件' : 'Attachment'));
  return (
    <div className={`atl-msg__att atl-msg__att--${att.kind}`} title={displayName}>
      <span className="atl-msg__att-name">{displayName}</span>
      {typeof att.size === 'number' && att.size > 0 && (
        <span className="atl-msg__att-size">{formatSize(att.size)}</span>
      )}
    </div>
  );
};

export const Lightbox: React.FC<{ src: string; name?: string; size?: number; onClose: () => void }> = ({ src, name, size, onClose }) => {
  const { isZh } = useI18n();
  /* capture + LIFO — lightbox 是最顶层浮层 (z 2147483000), Esc 必须先关它, 不能穿透到底下的面板 */
  useEscClose(true, onClose);
  const [dim, setDim] = React.useState<{ w: number; h: number } | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);
  /* 双指开合 / 拖动 / 双击放大 (见 hooks/usePanZoom) */
  const pz = usePanZoom<HTMLImageElement>(src);
  const zoomed = pz.view.scale > 1.001;
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '+' || e.key === '=') pz.zoomBy(1.25);
      else if (e.key === '-') pz.zoomBy(0.8);
      else if (e.key === '0') pz.reset();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pz.zoomBy, pz.reset]);

  const flash = (msg: string) => { setToast(msg); window.setTimeout(() => setToast(null), 1600); };

  /* 复制/保存都走主进程的 nativeImage 通道 (share:copy-card / share:save-card) ——
   * 它们只认 dataURL, 所以 http(s)/neox-asset:// 的图先取回来转一次。
   * 走主进程而不是 navigator.clipboard 是沿用既有做法: nativeImage 那条保了 alpha 通道。 */
  const toDataUrl = async (u: string): Promise<string> => {
    if (u.startsWith('data:')) return u;
    const blob = await (await fetch(u)).blob();
    return await new Promise<string>((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(blob);
    });
  };

  const onCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const api = (window as any).neox;
      const r = await api?.copyShareCard?.(await toDataUrl(src));
      flash(r?.ok === false ? (isZh ? '复制失败' : 'Copy failed') : (isZh ? '已复制图片' : 'Image copied'));
    } catch { flash(isZh ? '复制失败' : 'Copy failed'); }
  };

  const onSave = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const api = (window as any).neox;
      const r = await api?.saveShareCard?.(await toDataUrl(src));
      if (r?.ok) flash(isZh ? '已保存' : 'Saved');
      else if (r?.error !== 'CANCELED') flash(isZh ? '保存失败' : 'Save failed');
    } catch { flash(isZh ? '保存失败' : 'Save failed'); }
  };

  /* 图和按钮吞掉点击 —— 只有点遮罩才关闭 */
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  /* 工具结果给的标签常带「(41.1KB, image/png)」这种技术尾巴 —— 尺寸已经单独显示, 文件类型对人没用 */
  const title = (name || '').replace(/\s*\((?:[\d.]+\s*[KMG]?B)[^)]*\)\s*$/i, '') || (isZh ? '图片' : 'Image');
  const meta = [dim ? `${dim.w} × ${dim.h}` : '', typeof size === 'number' && size > 0 ? formatSize(size) : '']
    .filter(Boolean).join(' · ');

  return createPortal(
    <div
      className={`atl-lightbox${zoomed ? ' is-zoomed' : ''}`}
      onClick={() => { if (!pz.consumeDrag()) onClose(); }}
      role="dialog" aria-modal="true" aria-label={title}
    >
      <div className="atl-lightbox__actions" onClick={stop}>
        <div className="atl-lightbox__zoom">
          <button type="button" className="atl-lightbox__icon" onClick={() => pz.zoomBy(0.8)} title={isZh ? '缩小 (−)' : 'Zoom out (−)'} aria-label={isZh ? '缩小' : 'Zoom out'}>
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3.5 8h9" /></svg>
          </button>
          <button type="button" className="atl-lightbox__zoomval" onClick={pz.reset} title={isZh ? '还原 (0)' : 'Reset (0)'}>{Math.round(pz.view.scale * 100)}%</button>
          <button type="button" className="atl-lightbox__icon" onClick={() => pz.zoomBy(1.25)} title={isZh ? '放大 (+) · 也可双指开合 / 双击' : 'Zoom in (+) · or pinch / double-click'} aria-label={isZh ? '放大' : 'Zoom in'}>
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3.5 8h9M8 3.5v9" /></svg>
          </button>
        </div>
        <button type="button" className="atl-lightbox__icon" onClick={onCopy} title={isZh ? '复制图片' : 'Copy image'} aria-label={isZh ? '复制图片' : 'Copy image'}>
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.8" /><path d="M10.5 3.2v-.4c0-.7-.6-1.3-1.3-1.3H3.8c-.7 0-1.3.6-1.3 1.3v5.4c0 .7.6 1.3 1.3 1.3h.4" strokeLinecap="round" /></svg>
        </button>
        <button type="button" className="atl-lightbox__icon" onClick={onSave} title={isZh ? '保存到…' : 'Save as…'} aria-label={isZh ? '保存' : 'Save'}>
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2.5v8M4.8 7.5 8 10.7l3.2-3.2M3 13.3h10" /></svg>
        </button>
        <button type="button" className="atl-lightbox__icon" onClick={onClose} title={isZh ? '关闭 (Esc)' : 'Close (Esc)'} aria-label={isZh ? '关闭' : 'Close'}>
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="m4 4 8 8M12 4l-8 8" /></svg>
        </button>
      </div>
      <figure className="atl-lightbox__figure">
        <img
          ref={pz.ref}
          src={src}
          alt={title}
          draggable={false}
          onClick={stop}
          onPointerDown={pz.onPointerDown}
          onDoubleClick={pz.onDoubleClick}
          style={{ transform: `translate(${pz.view.x}px, ${pz.view.y}px) scale(${pz.view.scale})` }}
          onLoad={(e) => setDim({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        />
        <figcaption className="atl-lightbox__caption" onClick={stop}>
          <span className="atl-lightbox__title" title={title}>{title}</span>
          {meta && <span className="atl-lightbox__info">{meta}</span>}
        </figcaption>
      </figure>
      {toast && <div className="atl-lightbox__toast">{toast}</div>}
    </div>,
    document.body,
  );
};
