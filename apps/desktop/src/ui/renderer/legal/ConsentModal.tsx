'use client';

import React, { useState } from 'react';
import { useEnterTransition } from '../hooks/useEnterTransition';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  LEGAL_DOCS,
  LEGAL_VERSION,
  type LegalDocId,
  type LegalDoc,
} from './policies';
import { recordConsent, useConsentNeeded } from './consentStore';
import { useI18n } from '../hooks/useI18n';

function tryQuit(): void {
  /* electron preload 暴露的退出能力 — preload 没暴露时 fallback window.close (网页环境) */
  const neox = (typeof window !== 'undefined' ? (window as any).neox : null);
  if (typeof neox?.app?.quit === 'function') {
    try { void neox.app.quit(); return; } catch { /* fall through */ }
  }
  if (typeof window !== 'undefined' && typeof window.close === 'function') {
    try { window.close(); } catch { /* ignore */ }
  }
}

/** "1. 协议双方" → ["1", "协议双方"]; 不匹配则原样返回 */
function splitNumberedHeading(text: string): { num: string | null; rest: string } {
  const m = text.match(/^(\d+)\.\s+(.+)$/);
  if (!m) return { num: null, rest: text };
  return { num: m[1]!, rest: m[2]! };
}

const MD_COMPONENTS: Components = {
  /* h2 是各章节标题, 拆 "N. xxx" 成徽章 + 标题 */
  h2({ children, ...rest }) {
    const text = React.Children.toArray(children).map(String).join('');
    const { num, rest: title } = splitNumberedHeading(text);
    if (!num) return <h2 {...rest}>{children}</h2>;
    return (
      <h2 {...rest} className="neox-consent-h2-numbered">
        <span className="neox-consent-h2-badge" aria-hidden>{num}</span>
        <span className="neox-consent-h2-text">{title}</span>
      </h2>
    );
  },
};

/* —— icons —— 内联 SVG, 避免新增资源依赖 */
const IconDoc: React.FC = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
    <path d="M14 3v5h5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
    <path d="M9 13h6M9 17h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
  </svg>
);
const IconShield: React.FC = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M12 3 4 6v6c0 4.5 3.2 8.4 8 9 4.8-.6 8-4.5 8-9V6l-8-3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
    <path d="m9 12 2 2 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);
const IconDb: React.FC = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
    <ellipse cx="12" cy="5" rx="7" ry="2.5" stroke="currentColor" strokeWidth="1.6"/>
    <path d="M5 5v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V5" stroke="currentColor" strokeWidth="1.6"/>
    <path d="M5 11v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-6" stroke="currentColor" strokeWidth="1.6"/>
  </svg>
);
const IconCheck: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="m5 12 4.5 4.5L19 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);
const IconInfo: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6"/>
    <path d="M12 8h.01M11 12h1v5h1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const TAB_ICONS: Record<LegalDocId, React.ReactNode> = {
  terms:          <IconDoc />,
  privacy:        <IconShield />,
  data_inventory: <IconDb />,
};

/* Neox 品牌 logomark — 用真·品牌素材 (不再手画 SVG); 打包用 BASE_URL 相对路径 */
const BrandMark: React.FC = () => (
  <img
    className="neox-consent-brandmark"
    src={`${import.meta.env.BASE_URL}icons/icon-256.png`}
    width={30}
    height={30}
    alt=""
    aria-hidden
    draggable={false}
  />
);

export const ConsentModal: React.FC = () => {
  const needed = useConsentNeeded();
  const { isZh } = useI18n();
  const [activeTab, setActiveTab] = useState<LegalDocId>('terms');
  /* 入场动画: motion-macos / motion-win32 的 .nx-in--* */
  const entered = useEnterTransition();
  const [agreed, setAgreed] = useState(false);

  if (!needed) return null;

  const active: LegalDoc = LEGAL_DOCS.find(d => d.id === activeTab) ?? LEGAL_DOCS[0]!;

  return (
    <div className={`neox-consent-backdrop nx-in nx-in--modal ${entered ? 'is-in' : ''}`} role="dialog" aria-modal="true" aria-labelledby="neox-consent-title">
      <div className="neox-consent-modal">
        <header className="neox-consent-head">
          <div className="neox-consent-head-text">
            <div className="neox-consent-brand">
              <BrandMark />
              <span className="neox-consent-brand-name">Neox</span>
            </div>
            <h2 id="neox-consent-title" className="neox-consent-title">{isZh ? '欢迎使用 Neox' : 'Welcome to Neox'}</h2>
            <p className="neox-consent-sub">
              {isZh ? '在开始使用前, 请阅读并同意以下法律文档' : 'Please read and agree to the legal documents below before you start'}
              <code className="neox-consent-version">{LEGAL_VERSION}</code>
            </p>
          </div>
        </header>

        <nav className="neox-consent-tabs" role="tablist">
          {LEGAL_DOCS.map(doc => {
            const isActive = activeTab === doc.id;
            return (
              <button
                key={doc.id}
                role="tab"
                type="button"
                aria-selected={isActive}
                className={`neox-consent-tab${isActive ? ' is-active' : ''}`}
                onClick={() => setActiveTab(doc.id)}
              >
                <span className="neox-consent-tab-icon">{TAB_ICONS[doc.id]}</span>
                <span className="neox-consent-tab-meta">
                  <span className="neox-consent-tab-title">{doc.title}</span>
                  <span className="neox-consent-tab-sub">{doc.subtitle}</span>
                </span>
                {isActive && (
                  <span className="neox-consent-tab-check" aria-hidden>
                    <IconCheck />
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <article className="neox-consent-content" tabIndex={0}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
            {active.content}
          </ReactMarkdown>
        </article>

        <footer className="neox-consent-foot">
          <label className="neox-consent-agree">
            <input
              type="checkbox"
              checked={agreed}
              onChange={e => setAgreed(e.target.checked)}
            />
            <span>{isZh
              ? '我已完整阅读并同意《用户协议》《隐私政策》及《数据清单》'
              : 'I have read and agree to the Terms of Service, Privacy Policy, and Data Inventory'}</span>
          </label>
          <div className="neox-consent-actions">
            <button
              type="button"
              className="neox-consent-btn neox-consent-btn--secondary"
              onClick={tryQuit}
            >
              {isZh ? '拒绝并退出' : 'Decline & quit'}
            </button>
            <button
              type="button"
              className="neox-consent-btn neox-consent-btn--primary"
              disabled={!agreed}
              onClick={() => recordConsent()}
            >
              {isZh ? '接受并继续' : 'Accept & continue'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
};

/** 让 lint 不抱怨未引用的图标 (仅 IconInfo 在 css ::before 用不上时备用) */
void IconInfo;

export default ConsentModal;
