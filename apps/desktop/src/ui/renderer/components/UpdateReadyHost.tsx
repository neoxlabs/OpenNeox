import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getGlobalLanguage } from '../hooks/useI18n';
import { NeoxIllus } from '../media/illus';
import './featureIntro/featureIntro.css';

type Pending = { id: number; version?: string };

export function UpdateReadyHost(): React.ReactElement | null {
  /* 同一个 id 只处理一次 — 主进程重发 (比如窗口重建后重推) 不该叠两个弹窗 */
  const handled = useRef(new Set<number>());
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => {
    const bridge = (window as any)?.neox;
    if (typeof bridge?.onUpdateReady !== 'function') return;

    const off = bridge.onUpdateReady((payload: { id: number; version?: string }) => {
      const id = Number(payload?.id);
      if (!Number.isFinite(id) || handled.current.has(id)) return;
      handled.current.add(id);
      /* 先 ack, 再弹 —— 顺序反了的话, 用户思考超过 1.5s 主进程就会补一个原生框 */
      try { bridge.updateReadyAck?.(id); } catch { /* ack 失败就让主进程走原生兜底 */ }
      setPending({ id, version: payload?.version });
    });

    return () => { try { off?.(); } catch { /* 已卸载 */ } };
  }, []);

  const decide = (accept: boolean) => {
    if (!pending) return;
    const bridge = (window as any)?.neox;
    try {
      if (accept) bridge?.updateReadyAccept?.(pending.id);
      else bridge?.updateReadyDismiss?.(pending.id);
    } catch { /* 通道断了 — 下次检查更新会再提示一遍 */ }
    setPending(null);
  };

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') decide(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  if (!pending) return null;
  const zh = getGlobalLanguage() === 'zh';
  const version = pending.version ? ` ${pending.version}` : '';

  return createPortal(
    <div className="nx-intro" role="dialog" aria-modal="true" aria-label={zh ? '更新已就绪' : 'Update ready'}>
      <div className="nx-intro__scrim" onClick={() => decide(false)} />
      <div className="nx-intro__card">
        <div className="nx-intro__stage">
          <div className="nx-intro__glow" />
          <img className="nx-intro__art" src={NeoxIllus.updateReady} alt="" draggable={false} decoding="sync" />
        </div>
        <div className="nx-intro__body">
          <h3 className="nx-intro__title">{zh ? `Neox${version} 已准备好` : `Neox${version} is ready`}</h3>
          <p className="nx-intro__lead">
            {zh ? '重启即可用上新版，正在进行的会话会自动恢复。' : 'Restart to use the new version. Open sessions are restored automatically.'}
          </p>
          <div className="nx-intro__foot">
            <button type="button" className="nx-intro__mute" onClick={() => decide(false)}>
              {zh ? '稍后' : 'Later'}
            </button>
            <button type="button" className="nx-intro__ok" onClick={() => decide(true)}>
              {zh ? '立即重启' : 'Restart now'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
