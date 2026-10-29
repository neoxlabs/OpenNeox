/* 首次使用介绍 —— 第一次进某个功能时弹一次: 插画 + 一句话 + 三步怎么用。
 *
 *   任何地方调 showFeatureIntro(id) 即可; 看过的记在本机 (localStorage), 同一功能只弹一次。
 *   弹窗里「以后都不弹」= 关掉全部介绍。真正渲染的是 AppShell 里挂着的 <FeatureIntroHost/>。 */
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../hooks/useI18n';
import { FEATURE_INTROS, type FeatureIntroId } from './intros';
import './featureIntro.css';

const SEEN_KEY = 'neox.intro.seen';
const OFF_KEY = 'neox.intro.off';
const EVENT = 'neox:feature-intro';

function readSeen(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]') as string[]); } catch { return new Set(); }
}
function markSeen(id: string): void {
  try { const s = readSeen(); s.add(id); localStorage.setItem(SEEN_KEY, JSON.stringify([...s])); } catch { /* 存不了就下次再弹 */ }
}
function introsOff(): boolean {
  try { return localStorage.getItem(OFF_KEY) === '1'; } catch { return false; }
}

/** 这个功能还没介绍过就弹; 介绍过 / 全部关了什么都不做 */
export function showFeatureIntro(id: FeatureIntroId): void {
  if (introsOff() || readSeen().has(id)) return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: id }));
}

/** 设置 → 通知里的「功能介绍」开关 */
export function featureIntrosEnabled(): boolean {
  return !introsOff();
}
export function setFeatureIntrosEnabled(on: boolean): void {
  try { if (on) localStorage.removeItem(OFF_KEY); else localStorage.setItem(OFF_KEY, '1'); } catch { /* ignore */ }
}
/** 看过的全部清掉, 每个功能下次进去再弹一次 */
export function resetFeatureIntros(): void {
  try { localStorage.removeItem(SEEN_KEY); localStorage.removeItem(OFF_KEY); } catch { /* ignore */ }
}

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);

export const FeatureIntroHost: React.FC = () => {
  const { isZh } = useI18n();
  const [id, setId] = useState<FeatureIntroId | null>(null);

  useEffect(() => {
    const on = (e: Event) => {
      const next = (e as CustomEvent<FeatureIntroId>).detail;
      if (!FEATURE_INTROS[next]) return;
      /* 已经开着一个就不叠第二个; 被挤掉的下次进来再弹 */
      setId((cur) => cur ?? next);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);

  useEffect(() => {
    if (!id) return;
    markSeen(id);
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'Escape' || e.key === 'Enter') && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        setId(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [id]);

  if (!id) return null;
  const it = FEATURE_INTROS[id];
  const t = (p: [string, string]) => {
    const s = isZh ? p[0] : p[1];
    return isMac ? s : s.replace('⌘⇧M', 'Ctrl+Shift+M');
  };
  const close = () => setId(null);

  return createPortal(
    <div className="nx-intro" role="presentation">
      <div className="nx-intro__scrim" onMouseDown={close} aria-hidden="true" />
      <div className="nx-intro__card" role="dialog" aria-modal="true" aria-label={t(it.title)}>
        <div className="nx-intro__stage" aria-hidden="true">
          <span className="nx-intro__glow" />
          <img className="nx-intro__art" src={it.art} alt="" draggable={false} />
        </div>
        <div className="nx-intro__body">
          <h3 className="nx-intro__title">{t(it.title)}</h3>
          <p className="nx-intro__lead">{t(it.lead)}</p>
          <ol className="nx-intro__steps">
            {it.steps.map((s, i) => (
              <li key={i}><span className="nx-intro__num">{i + 1}</span><span>{t(s)}</span></li>
            ))}
          </ol>
          <div className="nx-intro__foot">
            <button
              type="button"
              className="nx-intro__mute"
              onClick={() => { try { localStorage.setItem(OFF_KEY, '1'); } catch { /* ignore */ } close(); }}
            >{isZh ? '以后都不弹' : "Don't show tips"}</button>
            <button type="button" className="nx-intro__ok" onClick={close} autoFocus>{isZh ? '知道了' : 'Got it'}</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};
