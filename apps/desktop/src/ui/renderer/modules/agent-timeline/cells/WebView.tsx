import React, { useState } from 'react';
import type { WebResult } from '../types';
import { useI18n } from '../../../hooks/useI18n';

const SHOW_FIRST = 3;

function hostOf(url?: string): string {
  if (!url) return '';
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/** 域名 → 稳定的底色 (图标拿不到时的字母块) */
function tintOf(host: string): string {
  let h = 0;
  for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 38% 46%)`;
}

const SiteIcon: React.FC<{ url?: string }> = ({ url }) => {
  const host = hostOf(url);
  const [failed, setFailed] = useState(false);
  if (!host) return <span className="nx-web__fav is-letter" style={{ background: '#9a9184' }}>·</span>;
  if (failed) {
    return <span className="nx-web__fav is-letter" style={{ background: tintOf(host) }}>{host.charAt(0).toUpperCase()}</span>;
  }
  return (
    <img
      className="nx-web__fav"
      src={`https://${host}/favicon.ico`}
      alt=""
      width={18}
      height={18}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
};

export const WebView: React.FC<{
  kind: 'search' | 'fetch';
  query?: string;
  url?: string;
  results?: WebResult[];
}> = ({ kind, results }) => {
  const { isZh } = useI18n();
  const [all, setAll] = useState(false);
  if (!results || results.length === 0) return null;
  if (kind === 'fetch' && results.length === 1) {
    const r = results[0]!;
    return (
      <div className="nx-web is-link">
        <SiteIcon url={r.url} />
        <div className="nx-web__m">
          {r.url
            ? <a href={r.url} target="_blank" rel="noreferrer" className="nx-web__t">{r.title}</a>
            : <span className="nx-web__t">{r.title}</span>}
          {r.url && <span className="nx-web__u">{hostOf(r.url)}</span>}
          {r.snippet && <span className="nx-web__x">{r.snippet}</span>}
        </div>
      </div>
    );
  }
  const shown = all ? results : results.slice(0, SHOW_FIRST);
  const rest = results.length - shown.length;
  return (
    <div className="nx-web">
      {shown.map((r, i) => (
        <div key={i} className="nx-web__i">
          <SiteIcon url={r.url} />
          <div className="nx-web__m">
            {r.url
              ? <a href={r.url} target="_blank" rel="noreferrer" className="nx-web__t" title={r.snippet || r.title}>{r.title}</a>
              : <span className="nx-web__t">{r.title}</span>}
            {r.url && <span className="nx-web__u">{hostOf(r.url)}{(() => { try { const p = new URL(r.url).pathname; return p && p !== '/' ? p : ''; } catch { return ''; } })()}</span>}
          </div>
        </div>
      ))}
      {rest > 0 && (
        <button type="button" className="nx-web__more" onClick={(e) => { e.stopPropagation(); setAll(true); }}>
          {isZh ? `还有 ${rest} 条 ›` : `${rest} more ›`}
        </button>
      )}
    </div>
  );
};
