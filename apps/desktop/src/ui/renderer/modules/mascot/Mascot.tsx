/** Original artwork, articulated head/paws, and continuous vector expressions. */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import MascotRig from './MascotRig';
import { useMascotPrefs, type MascotSpecies as PrefSpecies } from './useMascotPrefs';
import { useMascotActivity } from './useMascotActivity';
import { useMascotMotion, type MascotMood } from './useMascotMotion';
import { useMascotAnchor } from './useMascotAnchor';
import { useI18n } from '../../hooks/useI18n';
import { usePetConfig } from '../pet/petConfig';
import { isLiteEdition } from '../../utils/edition';
import { formatRunDuration, type MascotSignal } from './mascotSignal';
import './mascot.css';

export type MascotSpecies = 'cat' | 'corgi';

export interface MascotProps {
  species?: MascotSpecies;
  attentive?: boolean;
  /** The agent is running a turn: the pet settles at home and watches; it celebrates when the run ends. */
  busy?: boolean;
  composerRef?: RefObject<HTMLElement | null>;
  size?: number;
  className?: string;
  /** 替用户留意的事 (等批准 / 等回答 / 出错 / 长任务跑完), 以气泡说出来。 */
  signal?: MascotSignal | null;
  /** 点气泡或点宠物时带用户去处理那件事。 */
  onSignal?: (kind: MascotSignal['kind']) => void;
  /** 本回合开始时间 + 正在做的那一步: 忙的时候点一下, 气泡报进度。 */
  busySince?: number | null;
  activity?: string | null;
  /** 智能体此刻在干什么: 决定宠物的静息姿态和表情。 */
  mood?: MascotMood;
  /** 本回合每失败一个工具就换一个值, 宠物吓一跳。 */
  flinchKey?: string | null;
}

type Emote = 'think' | 'alert' | 'ask' | 'sweat' | 'sparkle';

function pickEmote(signal: MascotSignal | null, mood: MascotMood): Emote | null {
  if (signal?.kind === 'approval') return 'alert';
  if (signal?.kind === 'ask') return 'ask';
  if (signal?.kind === 'error' || mood === 'error') return 'sweat';
  if (signal?.kind === 'done') return 'sparkle';
  if (mood === 'thinking') return 'think';
  return null;
}

const EmoteMark: React.FC<{ kind: Emote }> = ({ kind }) => {
  if (kind === 'think') {
    return <span className="neox-mascot__emote is-think" aria-hidden><i /><i /><i /></span>;
  }
  if (kind === 'alert' || kind === 'ask') {
    return <span className="neox-mascot__emote is-mark" aria-hidden>{kind === 'alert' ? '!' : '?'}</span>;
  }
  if (kind === 'sweat') {
    return (
      <span className="neox-mascot__emote is-sweat" aria-hidden>
        <svg viewBox="0 0 12 16"><path d="M6 0.8C6 0.8 1 7 1 10.2a5 5 0 0 0 10 0C11 7 6 0.8 6 0.8z" /></svg>
      </span>
    );
  }
  return (
    <span className="neox-mascot__emote is-sparkle" aria-hidden>
      <svg viewBox="0 0 16 16"><path d="M8 0l1.7 6.3L16 8l-6.3 1.7L8 16l-1.7-6.3L0 8l6.3-1.7z" /></svg>
      <svg viewBox="0 0 16 16"><path d="M8 0l1.7 6.3L16 8l-6.3 1.7L8 16l-1.7-6.3L0 8l6.3-1.7z" /></svg>
    </span>
  );
};

const STATUS_BUBBLE_MS = 3200;

export const Mascot: React.FC<MascotProps> = ({
  species: speciesProp,
  attentive = false,
  busy = false,
  composerRef,
  size = 150,
  className = '',
  signal = null,
  onSignal,
  busySince = null,
  activity = null,
  mood = 'idle',
  flinchKey = null,
}) => {
  const { language } = useI18n();
  const mascotPrefs = useMascotPrefs();
  /* One pet at a time: while the open-source desktop pet is on, ours stays put away
     (Settings → Pet keeps the two exclusive; this also covers older setups with both on). */
  const desktopPetOn = usePetConfig().enabled && !isLiteEdition();
  const prefs = desktopPetOn ? { ...mascotPrefs, hidden: true } : mascotPrefs;
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const active = useMascotActivity(rootRef, !prefs.hidden);
  const species = speciesProp ?? (prefs.species as MascotSpecies);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const calling = signal?.kind === 'approval' || signal?.kind === 'ask';
  const pet = useMascotMotion(rootRef, composerRef, active && !menu, species, busy, calling, mood, flinchKey, prefs.stayPut);
  const emote = pickEmote(signal, mood);
  useMascotAnchor(rootRef, composerRef, !prefs.hidden, size);

  /* 忙的时候点它: 报一句已经跑了多久、在做哪一步, 几秒后收起 */
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    if (!status) return;
    const t = window.setTimeout(() => setStatus(null), STATUS_BUBBLE_MS);
    return () => window.clearTimeout(t);
  }, [status]);
  useEffect(() => { if (!busy) setStatus(null); }, [busy]);

  const onTouch = useCallback(() => {
    pet();
    if (signal) {
      onSignal?.(signal.kind);
      return;
    }
    if (busy) {
      const zhNow = language === 'zh';
      const parts: string[] = [];
      if (busySince) parts.push((zhNow ? '跑了 ' : 'Running ') + formatRunDuration(Date.now() - busySince, zhNow));
      else parts.push(zhNow ? '正在干活' : 'Working');
      if (activity) parts.push(activity);
      setStatus(parts.join(' · '));
    }
  }, [pet, signal, onSignal, busy, busySince, activity, language]);

  const bubble = signal ? (signal.kind === 'ask' ? null : { kind: signal.kind, text: signal.text, key: signal.key })
    : status ? { kind: 'status' as const, text: status, key: 'status' } : null;

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        rootRef.current?.focus();
      }
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const box = menuRef.current.getBoundingClientRect();
    const dx = Math.max(8 - box.left, Math.min(0, window.innerWidth - 8 - box.right));
    const dy = Math.max(8 - box.top, Math.min(0, window.innerHeight - 8 - box.bottom));
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      setMenu({ x: menu.x + dx, y: menu.y + dy });
      return;
    }
    menuRef.current.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [menu]);

  useEffect(() => {
    if (prefs.hidden) setMenu(null);
  }, [prefs.hidden]);

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: e.clientX - box.left, y: e.clientY - box.top });
  }, []);

  const zh = language === 'zh';
  if (prefs.hidden) return null;

  return (
    <div
      ref={rootRef}
      className={`neox-mascot ${className}`}
      role="group"
      tabIndex={0}
      aria-label={species === 'cat' ? (zh ? '猫' : 'Cat') : (zh ? '柯基' : 'Corgi')}
      aria-haspopup="menu"
      aria-expanded={Boolean(menu)}
      data-species={species}
      data-eyes={attentive ? 'wide' : 'normal'}
      style={{ ['--neox-mascot-h' as string]: `${size}px` }}
      onContextMenu={onContextMenu}
      onKeyDown={(event) => {
        if (menu) return;
        if ((event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' '))
          || event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          setMenu({ x: 0, y: 0 });
        }
      }}
    >
      <MascotRig key={species} species={species} />
      {emote && <EmoteMark key={emote} kind={emote} />}
      <span className="neox-mascot__emote is-zzz" aria-hidden><i>z</i><i>z</i><i>z</i></span>
      <button
        className="neox-mascot__touch"
        type="button"
        aria-label={zh ? (species === 'cat' ? '摸摸猫' : '摸摸柯基') : `Pet the ${species}`}
        title={zh ? '摸摸' : 'Pet'}
        onPointerDown={(event) => {
          // A mouse pet must not steal the editor's selection or interrupt an IME.
          if (event.pointerType === 'mouse' && event.button === 0) event.preventDefault();
        }}
        onClick={onTouch}
      />
      {bubble && (
        <button
          key={bubble.key}
          type="button"
          className={`neox-mascot__bubble is-${bubble.kind}`}
          role={bubble.kind === 'status' ? 'status' : 'alert'}
          onPointerDown={(event) => {
            if (event.pointerType === 'mouse' && event.button === 0) event.preventDefault();
          }}
          onClick={() => { if (signal) onSignal?.(signal.kind); else setStatus(null); }}
        >
          <span className="neox-mascot__bubble-text">{bubble.text}</span>
        </button>
      )}
      {menu && (
        <div
          ref={menuRef}
          className="neox-mascot__menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
          role="menu"
          aria-label={zh ? '角色' : 'Mascot'}
          onKeyDown={(event) => {
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            let next: number | undefined;
            if (event.key === 'ArrowDown') next = (index + 1) % items.length;
            if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
            if (event.key === 'Home') next = 0;
            if (event.key === 'End') next = items.length - 1;
            if (event.key === 'Tab') setMenu(null);
            if (next !== undefined) {
              event.preventDefault();
              items[next]?.focus();
            }
          }}
        >
          {(['cat', 'corgi'] as PrefSpecies[]).map((k) => (
            <button
              key={k}
              type="button"
              role="menuitemradio"
              aria-checked={species === k}
              className={`neox-mascot__menu-item${species === k ? ' is-on' : ''}`}
              onClick={() => { prefs.setSpecies(k); setMenu(null); rootRef.current?.focus(); }}
            >
              {k === 'cat' ? (zh ? '猫' : 'Cat') : (zh ? '柯基' : 'Corgi')}
            </button>
          ))}
          <div className="neox-mascot__menu-sep" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={!prefs.stayPut}
            className={`neox-mascot__menu-item${!prefs.stayPut ? ' is-on' : ''}`}
            onClick={() => { prefs.setStayPut(!prefs.stayPut); setMenu(null); rootRef.current?.focus(); }}
          >
            {zh ? '允许动作' : 'Allow moving'}
          </button>
          {rootRef.current?.dataset.free === 'yes' && (
            <button
              type="button"
              role="menuitem"
              className="neox-mascot__menu-item"
              onClick={() => { rootRef.current?.dispatchEvent(new CustomEvent('neox-mascot:dock')); setMenu(null); rootRef.current?.focus(); }}
            >
              {zh ? '回到输入框' : 'Back to the composer'}
            </button>
          )}
          <div className="neox-mascot__menu-sep" />
          <button
            type="button"
            role="menuitem"
            className="neox-mascot__menu-item"
            onClick={() => { prefs.setHidden(true); setMenu(null); }}
          >
            {zh ? '隐藏' : 'Hide'}
          </button>
        </div>
      )}
    </div>
  );
};

export default Mascot;
