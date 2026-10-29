/**
 * 它记得的 —— 你的偏好、约定、人名、常去的地方。看得见才信得过: 列出来, 不对的删掉, 也能直接教它一条。
 * 只有云端 Pilot 有 (记忆在云端账本); 本机 Pilot 不出这一块。
 */
import React, { useEffect, useState } from 'react';
import * as S from '../../shell/shellIcons';
import { boardApi, SectionHead, type BoardMemory } from './boardKit';
import { ART } from './art';

const FOLD = 5;

export const MemorySection: React.FC<{ sessionId: string | null; refreshKey: number; isZh: boolean }> = ({ sessionId, refreshKey, isZh }) => {
  const t = (zh: string, en: string) => (isZh ? zh : en);
  const [rows, setRows] = useState<BoardMemory[] | null>(null);
  const [nonce, setNonce] = useState(0);
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [all, setAll] = useState(false);

  useEffect(() => {
    if (!sessionId) { setRows(null); return undefined; }
    let alive = true;
    void boardApi().pilotMemories?.(sessionId).then((r) => {
      if (!alive) return;
      setRows(r?.cloud ? [...r.memories].sort((a, b) => b.at - a.at) : null);
    }).catch(() => { if (alive) setRows(null); });
    return () => { alive = false; };
  }, [sessionId, refreshKey, nonce]);

  if (!sessionId || rows === null) return null;

  const submit = async () => {
    const v = text.trim();
    if (!v) return;
    setText('');
    setAdding(false);
    await boardApi().pilotAddMemory?.(sessionId, v).catch(() => null);
    setNonce((n) => n + 1);
  };
  const forget = async (id: string) => {
    setRows((r) => (r ?? []).filter((m) => m.id !== id));
    await boardApi().pilotForgetMemory?.(id).catch(() => null);
  };
  const shown = all ? rows : rows.slice(0, FOLD);

  return (
    <section className="pb-sec is-memory">
      <SectionHead
        art={ART.memory}
        title={t('它记得', 'It remembers')}
        count={rows.length}
        action={{ label: t('教它记住一件事', 'Teach it something'), icon: <S.IconPlus size={14} />, onClick: () => setAdding((v) => !v), active: adding }}
      />
      {adding && (
        <div className="pb-form">
          <input
            className="pb-input"
            autoFocus
            placeholder={t('例：我女儿 10 月 7 日生日', 'e.g. My daughter’s birthday is Oct 7')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submit(); if (e.key === 'Escape') setAdding(false); }}
          />
          <div className="pb-form__row">
            <button type="button" className="pb-btn" onClick={() => setAdding(false)}>{t('取消', 'Cancel')}</button>
            <button type="button" className="pb-btn pb-btn--primary" disabled={!text.trim()} onClick={() => void submit()}>{t('记住', 'Remember')}</button>
          </div>
        </div>
      )}
      {shown.map((m) => (
        <div key={m.id} className="pb-mem">
          <span className="pb-mem__text">{m.text}</span>
          <button type="button" className="pb-mem__x" onClick={() => void forget(m.id)} title={t('忘掉这条', 'Forget')} aria-label={t('忘掉这条', 'Forget')}>
            <S.IconTrash size={12} />
          </button>
        </div>
      ))}
      {rows.length > FOLD && (
        <button type="button" className="pb-more" onClick={() => setAll((v) => !v)}>
          {all ? t('收起', 'Show less') : t(`全部 ${rows.length} 条`, `All ${rows.length}`)}
        </button>
      )}
    </section>
  );
};
