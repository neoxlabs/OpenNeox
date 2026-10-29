
import React, { useCallback, useEffect, useState } from 'react';
import type { ConfigField, ListingFeature, ListingShot } from '../pluginListing.js';
import { dispatchHint } from '../../../components/notifyEvents';

/* ---------------- 截图 ---------------- */

export const Gallery: React.FC<{ shots: ListingShot[]; isZh: boolean }> = ({ shots, isZh }) => {
  const [open, setOpen] = useState<number | null>(null);

  const step = useCallback((d: number) => {
    setOpen((i) => (i === null ? i : (i + d + shots.length) % shots.length));
  }, [shots.length]);

  useEffect(() => {
    if (open === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, step]);

  if (!shots.length) return null;
  return (
    <section className="npd-gallery" aria-label={isZh ? '截图' : 'Screenshots'}>
      <div className="npd-gallery__strip">
        {shots.map((s, i) => (
          <button key={s.src} type="button" className="npd-gallery__shot" onClick={() => setOpen(i)}>
            <img src={s.src} alt={s.alt ?? ''} loading="lazy" decoding="async" />
          </button>
        ))}
      </div>
      {open !== null && (
        <div className="npd-lightbox" role="dialog" aria-modal="true" onClick={() => setOpen(null)}>
          <img src={shots[open].src} alt={shots[open].alt ?? ''} onClick={(e) => e.stopPropagation()} />
          {shots.length > 1 && (
            <div className="npd-lightbox__dots" onClick={(e) => e.stopPropagation()}>
              {shots.map((s, i) => (
                <button key={s.src} type="button" className={i === open ? 'is-on' : ''} onClick={() => setOpen(i)} aria-label={`${i + 1}`} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
};

/* ---------------- 试着这样问 ---------------- */

export const TryAsking: React.FC<{ examples: string[]; ready: boolean; isZh: boolean }> = ({ examples, ready, isZh }) => {
  if (!examples.length) return null;
  const ask = (text: string) => {
    if (!ready) {
      dispatchHint(isZh ? '先安装并启用这个插件，再试这句' : 'Install and enable the plugin first', 'info');
      return;
    }
    try { window.dispatchEvent(new CustomEvent('neox:create-new-session')); } catch { /* ignore */ }
    const started = Date.now();
    const tryFill = () => {
      if (!document.querySelector('.atl-composer__input')) {
        if (Date.now() - started < 4000) setTimeout(tryFill, 100);
        return;
      }
      requestAnimationFrame(() => setTimeout(() => {
        try { window.dispatchEvent(new CustomEvent('neox:composer-fill', { detail: { text, focus: true } })); } catch { /* ignore */ }
      }, 50));
    };
    setTimeout(tryFill, 100);
  };
  return (
    <section className="npd-block">
      <h2 className="npd-block__title">{isZh ? '试着这样问' : 'Try asking'}</h2>
      <div className="npd-asks">
        {examples.map((e) => (
          <button key={e} type="button" className="npd-ask" onClick={() => ask(e)} title={ready ? (isZh ? '在新对话里填好这句' : 'Start a new chat with this') : undefined}>
            <span className="npd-ask__q">“</span>{e}
          </button>
        ))}
      </div>
    </section>
  );
};

/* ---------------- 能做什么 ---------------- */

export const Features: React.FC<{ features: ListingFeature[]; isZh: boolean }> = ({ features, isZh }) => {
  if (!features.length) return null;
  return (
    <section className="npd-block">
      <h2 className="npd-block__title">{isZh ? '能做什么' : 'What it can do'}</h2>
      <ul className="npd-features">
        {features.map((f) => (
          <li key={f.title}>
            <span className="npd-features__title">{f.title}</span>
            {f.detail && <span className="npd-features__detail">{f.detail}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
};

/* ---------------- 设置 ---------------- */

export const SettingsForm: React.FC<{ pluginName: string; fields: ConfigField[]; isZh: boolean }> = ({ pluginName, fields, isZh }) => {
  const [values, setValues] = useState<Record<string, any> | null>(null);
  const [saved, setSaved] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const cur = (await (window as any).neox?.pluginConfigGet?.(pluginName).catch(() => ({}))) ?? {};
      if (!alive) return;
      setValues(cur); setSaved(cur);
    })();
    return () => { alive = false; };
  }, [pluginName]);

  if (!fields.length || values === null) return null;
  const dirty = fields.some((f) => (values[f.key] ?? '') !== (saved[f.key] ?? ''));

  const save = async () => {
    setSaving(true);
    try {
      /* 空串 = 用默认值, 不存一个空字符串进去盖掉清单默认 */
      const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '' && v !== undefined));
      const r = await (window as any).neox?.pluginConfigSet?.(pluginName, clean);
      if (r?.success === false) throw new Error('save failed');
      setSaved(values);
      dispatchHint(isZh ? '已保存，下一轮对话生效' : 'Saved — takes effect from the next message', 'success');
    } catch {
      dispatchHint(isZh ? '保存失败' : 'Could not save settings', 'warning');
    } finally {
      setSaving(false);
    }
  };

  const set = (k: string, v: any) => setValues((s) => ({ ...(s ?? {}), [k]: v }));

  return (
    <section className="npd-block">
      <h2 className="npd-block__title">{isZh ? '设置' : 'Settings'}</h2>
      <div className="npd-form">
        {fields.map((f) => {
          const v = values[f.key];
          const ph = f.default !== undefined ? String(f.default) : '';
          return (
            <label key={f.key} className={`npd-field${f.type === 'boolean' ? ' is-inline' : ''}`}>
              <span className="npd-field__label">{f.description}</span>
              {f.type === 'boolean' ? (
                <input type="checkbox" checked={Boolean(v ?? f.default)} onChange={(e) => set(f.key, e.target.checked)} />
              ) : f.type === 'select' && f.options?.length ? (
                <select className="npd-input" value={String(v ?? f.default ?? '')} onChange={(e) => set(f.key, e.target.value)}>
                  {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input
                  className="npd-input"
                  type={f.sensitive ? 'password' : f.type === 'number' ? 'number' : 'text'}
                  value={v ?? ''}
                  placeholder={ph}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => set(f.key, f.type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value)}
                />
              )}
            </label>
          );
        })}
        <div className="npd-form__actions">
          <button type="button" className="neox-plugins__btn is-primary" disabled={!dirty || saving} onClick={save}>
            {saving ? (isZh ? '保存中…' : 'Saving…') : (isZh ? '保存' : 'Save')}
          </button>
        </div>
      </div>
    </section>
  );
};
