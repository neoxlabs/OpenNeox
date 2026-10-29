import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { kbd } from '../../../utils/keymap';

interface Props {
  text: string;
  model?: string;
  tokens?: number;
  onClose: () => void;
  zh: boolean;
}

type State =
  | { s: 'rendering' }
  | { s: 'ok'; dataUrl: string }
  | { s: 'error'; msg: string };

export const ShareCardModal: React.FC<Props> = ({ text, model, tokens, onClose, zh }) => {
  const [state, setState] = useState<State>({ s: 'rendering' });
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'));
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ s: 'rendering' });
    void (async () => {
      try {
        const r = await (window as any).neox?.renderShareCard?.({ text, model, tokens, theme });
        if (cancelled) return;
        if (r?.ok && r.dataUrl) setState({ s: 'ok', dataUrl: r.dataUrl });
        else setState({ s: 'error', msg: r?.error || 'RENDER_FAILED' });
      } catch (err: any) {
        if (!cancelled) setState({ s: 'error', msg: err?.message || String(err) });
      }
    })();
    return () => { cancelled = true; };
  }, [text, model, tokens, theme]);

  /* Esc 关闭 —— 弹窗的基本礼貌, 不用鼠标也能退出 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const flash = (m: string) => { setToast(m); window.setTimeout(() => setToast(null), 1600); };

  const doCopy = async () => {
    if (state.s !== 'ok') return;
    try {
      const r = await (window as any).neox?.copyShareCard?.(state.dataUrl);
      flash(r?.ok ? (zh ? '已复制图片' : 'Image copied') : (zh ? '复制失败' : 'Copy failed'));
    } catch {
      flash(zh ? '复制失败' : 'Copy failed');
    }
  };
  const doSave = async () => {
    if (state.s !== 'ok') return;
    try {
      const r = await (window as any).neox?.saveShareCard?.(state.dataUrl);
      if (r?.error === 'CANCELED') return;
      flash(r?.ok ? (zh ? '已保存' : 'Saved') : (zh ? '保存失败' : 'Save failed'));
    } catch {
      flash(zh ? '保存失败' : 'Save failed');
    }
  };
  /* X 的 web intent 不能带图 —— 主进程把图放进剪贴板再拉起发帖框,
   * 这里的 toast 负责把「粘贴」这一步告诉用户, 不然图"丢了"。 */
  const doShareX = async () => {
    if (state.s !== 'ok') return;
    const r = await (window as any).neox?.shareCardToX?.(state.dataUrl);
    flash(r?.ok
      ? (zh ? `图已复制 — 在 X 里 ${kbd('mod+v')} 粘贴` : `Copied — paste in X with ${kbd('mod+v')}`)
      : (zh ? '打开 X 失败' : 'Failed to open X'));
  };

  /* 必须 portal 到 body。
   *   position:fixed 是相对【最近的有 transform / filter / will-change:transform 的祖先】
   *   定位的, 而 timeline 的行有入场动画 (.atl-row-clamp--fresh .atl-msg { animation;
   *   will-change: transform })。直接就地渲染的话, 遮罩会被关进那一行的盒子里 ——
   *   截图上"消息区中间一块黑的、弹窗被压扁"就是这么来的, 不是样式丑, 是定位基准错了。 */
  return createPortal((
    <div className="atl-share-mask" onClick={onClose} role="dialog" aria-modal="true"
      aria-label={zh ? '分享这段回复' : 'Share this reply'}>
      <div className="atl-share-panel" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="atl-share-x" onClick={onClose} aria-label={zh ? '关闭' : 'Close'}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
            strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>

        <div className="atl-share-preview">
          {state.s === 'rendering' && (
            <div className="atl-share-hint">{zh ? '正在生成卡片…' : 'Rendering card…'}</div>
          )}
          {state.s === 'error' && (
            <div className="atl-share-hint atl-share-hint--err">
              {zh ? '生成失败：' : 'Failed: '}{state.msg}
            </div>
          )}
          {state.s === 'ok' && <img src={state.dataUrl} alt="" className="atl-share-img" />}
        </div>

        <div className="atl-share-bar">
          <div className="atl-share-themes" role="group"
            aria-label={zh ? '卡片配色' : 'Card theme'}>
            {(['dark', 'light'] as const).map(t => (
              <button
                key={t}
                type="button"
                className={`atl-share-theme${theme === t ? ' is-on' : ''}`}
                onClick={() => setTheme(t)}
              >
                {t === 'dark' ? (zh ? '深色' : 'Dark') : (zh ? '浅色' : 'Light')}
              </button>
            ))}
          </div>
          <span className="atl-share-bar__sep" aria-hidden="true" />
          <button type="button" className="atl-share-btn" onClick={doShareX} disabled={state.s !== 'ok'}
            title={zh ? '复制图片并打开 X 发帖框' : 'Copy image and open X composer'}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
            {zh ? '分享到 X' : 'Share to X'}
          </button>
          <button type="button" className="atl-share-btn" onClick={doSave} disabled={state.s !== 'ok'}>
            {zh ? '保存 PNG' : 'Save PNG'}
          </button>
          <button type="button" className="atl-share-btn atl-share-btn--primary" onClick={doCopy} disabled={state.s !== 'ok'}>
            {zh ? '复制图片' : 'Copy image'}
          </button>
        </div>
        {!!toast && <div className="atl-share-toast" role="status">{toast}</div>}
      </div>
    </div>
  ), document.body);
};

export default ShareCardModal;
