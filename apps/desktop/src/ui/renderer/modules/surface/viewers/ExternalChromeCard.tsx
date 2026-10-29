/**
 * ExternalChromeCard — 外置 Chrome 模式下 web surface 在 Neox 里的占位卡片.
 *
 * 外置模式下 agent 打开的浏览器是用户机器上的真 Chrome, BrowserView 完全不用.
 * Neox 侧 surface 只显一个卡片: Chrome 状态 + 当前 tabs 列表 + "打开 Chrome" 焦点操作.
 *
 * MVP 极简:
 *   · 状态徽章: Chrome running/stopped/starting
 *   · tabs 列表 (从 surface.metadata.tabs 拿, agent 已经把它填好)
 *   · 一个"聚焦 Chrome 窗口"按钮 (可选, 靠 executeJavaScript window.focus() )
 *   · 一个"关闭 Chrome"按钮 (显式让 shutdown)
 *   · hint 文案说明 agent 已接管 + banner 在 Chrome 里显示
 */

import { useI18n } from '../../../hooks/useI18n';
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import type { Surface } from '../../../state/surfaceStore';
import { BrowserBrandIcon, browserLabel, type BrowserBrand } from './BrowserBrandIcon';
import { isMac } from '../../../utils/keymap';

/* "完整退出应用" 不是修饰键差异, 是**两个平台压根没有对应关系**:
 * mac 关窗口 ≠ 退应用, 所以要专门说 ⌘Q; Windows / Linux 关掉主窗口就是退了,
 * 那里既没有 ⌘ 也没有等价的 Ctrl+Q。所以这里不能用 kbd() 换个修饰键了事 ——
 * 照抄成 "Ctrl+Q" 会让用户按一个不存在的组合, 比留着 ⌘Q 还糟。 */
const QUIT_HINT_ZH = isMac ? '⌘Q ' : '关掉窗口';
const QUIT_HINT_EN = isMac ? '⌘Q' : 'close the window';

interface Props {
  surface: Surface;
}

interface Status {
  running: boolean;
  /** 实际拉起的浏览器 —— chromeLauncher 按 Chrome → Chromium → Brave → Edge 找,
   *  装了哪个就是哪个, 所以这张卡不能一律写死 "Chrome"。 */
  browser: BrowserBrand;
}

export const ExternalChromeCard: React.FC<Props> = ({ surface }) => {
  const { language } = useI18n();
  const zh = language === 'zh';
  const [status, setStatus] = useState<Status>({ running: false, browser: 'chrome' });
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const tabs = useMemo(
    () => (surface.metadata?.tabs as Array<{ id: string; url: string; title?: string }> | undefined) ?? [],
    [surface.metadata],
  );

  const refreshStatus = useCallback(async () => {
    const api = (window as any).neox;
    if (!api?.externalChromeStatus) return;
    try {
      const r = await api.externalChromeStatus();
      setStatus({ running: !!r?.running, browser: (r?.browser as BrowserBrand) || 'chrome' });
    } catch { /* ignore */ }
  }, []);

  const doEnsure = useCallback(async () => {
    setBusy(true);
    setLastError(null);
    const api = (window as any).neox;
    try {
      const r = await api?.externalChromeEnsure?.({});
      if (r && r.ok === false && r.error) {
        setLastError(String(r.error));
      }
    } catch (err: any) {
      setLastError(err?.message || String(err));
    }
    await refreshStatus();
    setBusy(false);
  }, [refreshStatus]);

  useEffect(() => {
    void refreshStatus();
    const t = window.setInterval(() => { void refreshStatus(); }, 3000);
    return () => window.clearInterval(t);
  }, [refreshStatus]);

  /* 卡片不 mount 就自动 ensure — Chrome 生命周期由 BrowserSession 驱动:
   *   agent 调 browser_* tool → wrap() → session.withActivity → session:open → Manager 起 Chrome.
   *   agent turn 结束 refcount==0 → session:close → Manager 关 Chrome.
   *   卡片只在用户主动点"启动 Chrome"按钮时手动触发 doEnsure. */

  const handleEnsure = useCallback(async () => {
    await doEnsure();
  }, [doEnsure]);

  const handleShutdown = useCallback(async () => {
    setBusy(true);
    const api = (window as any).neox;
    try {
      await api?.externalChromeShutdown?.();
    } catch { /* ignore */ }
    await refreshStatus();
    setBusy(false);
  }, [refreshStatus]);

  /* 文案里的浏览器名跟 logo 用同一个来源, 不会出现「Brave 的图标 + Chrome 的字」 */
  const brandName = browserLabel(status.browser);

  const handleFocus = useCallback(async () => {
    const api = (window as any).neox;
    try {
      await api?.externalChromeFocus?.();
    } catch { /* ignore */ }
  }, []);

  return (
    <div className="sfc-ext-chrome">
      <div className="sfc-ext-chrome__head">
        <span className="sfc-ext-chrome__brand">
          <BrowserBrandIcon brand={status.browser} size={18} dimmed={!status.running} />
          <span className={`sfc-ext-chrome__dot ${status.running ? 'is-on' : 'is-off'}`} aria-hidden />
        </span>
        <div className="sfc-ext-chrome__title">
          {status.running
            ? (zh ? `${brandName} 已启动 · Agent 正在接管` : `${brandName} running · agent in control`)
            : (zh ? `${brandName} 未启动` : `${brandName} not running`)}
        </div>
      </div>

      <div className="sfc-ext-chrome__desc">
        {zh
          ? `Agent 打开的浏览器在你机器上的 ${brandName} 里独立运行，不占 Neox 窗口空间。${brandName} 底部会显示「Neox Agent 接管中」悬浮横条 —— 随时能看到当前状态。`
          : `Pages the agent opens run in ${brandName} on your own machine, not inside the Neox window. A "Neox Agent in control" bar sits at the bottom of ${brandName} so you can always see the current state.`}
      </div>

      {lastError && (
        <div className="sfc-ext-chrome__error">
          <div className="sfc-ext-chrome__error-title">{zh ? `${brandName} 启动失败` : `${brandName} failed to start`}</div>
          <div className="sfc-ext-chrome__error-msg">{lastError}</div>
          <div className="sfc-ext-chrome__error-hint">
            {zh ? '排查：1) 你的机器装了 Google Chrome 吗？2) 如果卡在启动，可能需要完整' : 'Checklist: 1) Is Google Chrome installed? 2) If it hangs on launch, fully '}<b>{zh ? '退出并重启 Neox' : 'quit and restart Neox'}</b>{zh ? ` —— ${QUIT_HINT_ZH}后重开。` : ` — ${QUIT_HINT_EN}, then reopen.`}
          </div>
        </div>
      )}

      {tabs.length > 0 && (
        <div className="sfc-ext-chrome__tabs">
          <div className="sfc-ext-chrome__tabs-title">
            {status.running
              ? (zh ? `当前 ${tabs.length} 个标签页` : `${tabs.length} open tab(s)`)
              : (zh ? `启动后会打开这 ${tabs.length} 个页面` : `${tabs.length} page(s) queued for launch`)}
          </div>
          <ul className="sfc-ext-chrome__tab-list">
            {tabs.map(t => (
              <li key={t.id} className="sfc-ext-chrome__tab">
                <div className="sfc-ext-chrome__tab-title">{t.title || (zh ? '(无标题)' : '(untitled)')}</div>
                <div className="sfc-ext-chrome__tab-url">{t.url}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="sfc-ext-chrome__actions">
        {!status.running ? (
          <button type="button" className="sfc-ext-chrome__btn is-primary" onClick={handleEnsure} disabled={busy}>
            {busy ? (zh ? '正在启动…' : 'Starting…') : (zh ? `启动 ${brandName}` : `Start ${brandName}`)}
          </button>
        ) : (
          <>
            <button type="button" className="sfc-ext-chrome__btn is-primary" onClick={handleFocus} disabled={busy}>
              {zh ? `聚焦 ${brandName} 窗口` : `Focus ${brandName} window`}
            </button>
            <button type="button" className="sfc-ext-chrome__btn is-danger" onClick={handleShutdown} disabled={busy}>
              {busy ? (zh ? '正在关闭…' : 'Closing…') : (zh ? `关闭 ${brandName}` : `Close ${brandName}`)}
            </button>
          </>
        )}
      </div>

    </div>
  );
};

export default ExternalChromeCard;
