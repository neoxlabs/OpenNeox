import React, { useCallback, useEffect, useState } from 'react';
import { isEmbeddedBrowserEnabled } from '../embeddedBrowserFlag';
import { useI18n } from '../../../hooks/useI18n';
import Icons from '../../../components/Icons';
import {
  PageTitle,
  Section,
  SectionTitle,
  SettingsCard,
  SettingsRow,
  SwitchRow,
  RowIcon,
  Segmented,
  NeoxInput,
  NeoxButton,
} from '../../../components/settings-base';
import { CustomSelect } from '../../../components/CustomSelect';
import { NeoxIllus } from '../../../media/illus';
import { dispatchHint, dispatchOpFailed } from '../../../components/notifyEvents';
import './BrowserTab.clay.css';

const DailyLoginsSection: React.FC<{ zh: boolean }> = ({ zh }) => {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [profile, setProfile] = useState<string>('');
  const [profiles, setProfiles] = useState<Array<{ dir: string; name: string }>>([]);
  const [policy, setPolicy] = useState<'open' | 'allowlist'>('open');
  const [allow, setAllow] = useState<string[]>([]);
  const [deny, setDeny] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  const api = (window as any).neox;

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const cfg = await api?.getBrowserUseConfig?.();
        if (!alive) return;
        setEnabled(cfg?.reuseDailyLogins === true);
        setProfile(typeof cfg?.dailyProfileName === 'string' ? cfg.dailyProfileName : '');
        setPolicy(cfg?.policy === 'allowlist' ? 'allowlist' : 'open');
        setAllow(Array.isArray(cfg?.allow) ? cfg.allow : []);
        setDeny(Array.isArray(cfg?.deny) ? cfg.deny : []);
      } catch { if (alive) setEnabled(false); }
      /* 老 main 进程没这个 IPC → 不渲染下拉, 用默认用户 */
      try {
        const list = await api?.listDailyChromeProfiles?.();
        if (alive && Array.isArray(list)) setProfiles(list);
      } catch { /* 读不到就只有默认 */ }
    })();
    return () => { alive = false; };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const savePatch = useCallback(async (patch: Record<string, unknown>) => {
    try { await api?.setBrowserUseConfig?.(patch); }
    catch (err: any) { dispatchOpFailed({ op: zh ? '保存设置' : 'Save setting', message: err?.message ?? String(err) }); }
  }, [api, zh]);

  const toggle = useCallback(async (v: boolean) => {
    setEnabled(v);
    try { await api?.setBrowserUseConfig?.({ reuseDailyLogins: v }); }
    catch (err: any) {
      setEnabled(!v);
      dispatchOpFailed({ op: zh ? '保存设置' : 'Save setting', message: err?.message ?? String(err) });
    }
  }, [api, zh]);

  const syncNow = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api?.syncDailyLogins?.();
      if (r?.ok) {
        const msg = r.copied
          ? (zh ? `已同步 ${Math.round((r.bytes ?? 0) / 1024)} KB 的 Cookies；下次网页任务会带上。` : `Synced ${Math.round((r.bytes ?? 0) / 1024)} KB of cookies; the next web task will use them.`)
          : (zh ? '日常 Chrome 的登录态没变化，沿用上次同步的。' : 'No change in your everyday Chrome; the last sync stands.');
        setLast(msg);
        dispatchHint(msg, 'success');
      } else {
        const msg = r?.error ?? (zh ? '同步失败' : 'Sync failed');
        setLast(msg);
        dispatchOpFailed({ op: zh ? '同步登录态' : 'Sync logins', message: msg });
      }
    } catch (err: any) {
      dispatchOpFailed({ op: zh ? '同步登录态' : 'Sync logins', message: err?.message ?? String(err) });
    } finally { setBusy(false); }
  }, [api, busy, zh]);

  return (
    <>
      <Section>
        <SectionTitle title={zh ? '登录态' : 'Sign-ins'} />
        <SettingsCard>
          <SwitchRow
            leading={<RowIcon src={NeoxIllus.browserHero} />}
            title={zh ? '带上我日常 Chrome 的登录态' : 'Reuse my everyday Chrome sign-ins'}
            desc={zh
              ? '邮箱、后台这些已登录的站点，Agent 不用再登一遍。只复制 Cookies，不碰保存的密码。'
              : 'Sites you are signed into stay signed in for the agent. Cookies only; saved passwords are never touched.'}
            checked={enabled === true}
            onChange={(v) => void toggle(v)}
          />
          {profiles.length > 1 && (
            <SettingsRow
              leading={<RowIcon src={NeoxIllus.profileHero} />}
              title={zh ? '从哪个 Chrome 用户复制' : 'Copy from Chrome profile'}
              control={(
                <div className="br-profile__select">
                  <CustomSelect
                    value={profile || 'Default'}
                    onChange={(v) => { setProfile(v); void savePatch({ dailyProfileName: v === 'Default' ? null : v }); }}
                    options={profiles.map((p) => ({
                      value: p.dir,
                      label: profiles.filter((q) => q.name === p.name).length > 1 ? `${p.name} · ${p.dir}` : p.name,
                    }))}
                  />
                </div>
              )}
            />
          )}
          <SettingsRow
            leading={<RowIcon src={NeoxIllus.expSnap} />}
            title={zh ? '现在同步一次' : 'Sync now'}
            desc={last ?? (zh ? '会先关掉正在跑的 Agent 浏览器，下次任务自动重启。' : 'Closes a running agent browser first; it restarts on the next task.')}
            control={(
              <NeoxButton variant="secondary" size="sm" onClick={() => void syncNow()} disabled={busy}>
                {busy ? (zh ? '同步中…' : 'Syncing…') : (zh ? '同步' : 'Sync')}
              </NeoxButton>
            )}
          />
        </SettingsCard>
      </Section>

      <Section>
        <SectionTitle title={zh ? '能开哪些网站' : 'Allowed sites'} />
        <SettingsCard>
          <SettingsRow
            leading={<RowIcon src={NeoxIllus.web} />}
            title={zh ? 'Agent 能开哪些网站' : 'Sites the agent may open'}
            desc={policy === 'allowlist'
              ? (zh ? '只有「允许」里的网站能打开。禁止优先。' : 'Only sites under “Allow” can be opened. Block wins.')
              : (zh ? '除了「禁止」里的，都能打开。' : 'Everything except sites under “Block”.')}
            control={(
              <Segmented
                value={policy}
                onChange={(v) => { const p = v as 'open' | 'allowlist'; setPolicy(p); void savePatch({ policy: p }); }}
                options={[
                  { value: 'open', label: zh ? '都能开' : 'Any' },
                  { value: 'allowlist', label: zh ? '只开名单里的' : 'Allowlist only' },
                ]}
              />
            )}
          />
          {policy === 'allowlist' && (
            <SettingsRow>
              <RowIcon src={NeoxIllus.styleStandard} />
              <SiteList zh={zh} label={zh ? '允许' : 'Allow'} items={allow}
                onChange={(xs) => { setAllow(xs); void savePatch({ allow: xs }); }} />
            </SettingsRow>
          )}
          <SettingsRow>
            <RowIcon src={NeoxIllus.nomatch} />
            <SiteList zh={zh} label={zh ? '禁止' : 'Block'} items={deny} danger
              onChange={(xs) => { setDeny(xs); void savePatch({ deny: xs }); }} />
          </SettingsRow>
        </SettingsCard>
        <p className="set-note">{zh ? '子域写 *.example.com；本地可写 localhost:3000。' : 'Use *.example.com for subdomains; localhost:3000 works.'}</p>
      </Section>
    </>
  );
};

/* 站点名单: 小标签 + 回车添加。规范化只做 trim / 去协议和路径 —— 真正的匹配规则在 core browserPolicy。 */
const SiteList: React.FC<{ zh: boolean; label: string; items: string[]; danger?: boolean; onChange: (xs: string[]) => void }> = ({ zh, label, items, danger, onChange }) => {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    if (!v || items.includes(v)) { setDraft(''); return; }
    onChange([...items, v]);
    setDraft('');
  };
  return (
    <div className={`br-sites${danger ? ' is-danger' : ''}`}>
      <span className="br-sites__label">{label}</span>
      {items.map((s) => (
        <span key={s} className="br-sites__chip">
          {s}
          <button type="button" onClick={() => onChange(items.filter((x) => x !== s))} aria-label={zh ? `移除 ${s}` : `Remove ${s}`}>×</button>
        </span>
      ))}
      <input
        className="br-sites__input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        onBlur={add}
        placeholder={zh ? '加一个网站，回车' : 'Add a site, Enter'}
      />
    </div>
  );
};


const BrowserTab: React.FC = () => {
  const { language } = useI18n();
  const zh = language === 'zh';
  const [showEmbeddedBrowser, setShowEmbeddedBrowser] = useState(false);
  const [embeddedBrowserUrl, setEmbeddedBrowserUrl] = useState('');
  const available = isEmbeddedBrowserEnabled();
  const unavailableReason = zh
    ? '暂不支持: 内嵌浏览器用的是 Electron `<webview>` 标签, 而本构建没有开启 webviewTag —— 填了地址点「打开」只会得到一个 0×0 的空元素, 什么都看不到。需要让 Agent 打开网页时, 用右栏的「浏览器」(走本机 Chrome)。'
    : 'Not available: the embedded browser relies on Electron\'s `<webview>` tag, which is not enabled in this build — clicking Open would only create a 0×0 element. Use the "Browser" surface on the right (external Chrome) instead.';

  return (
    <div className="settings-panel-content br3">
      <PageTitle
        title={zh ? '浏览器' : 'Browser'}
        subtitle={zh ? 'Agent 用来上网的那个 Chrome' : 'The Chrome the agent uses to browse the web'}
      />

      <DailyLoginsSection zh={zh} />

      {/* 内嵌浏览器那块只在作者逃生门开着时显示 —— 这页现在对用户可见了, 一个灰输入框写着"暂不支持"
        * 就是这仓库一直不肯立的墓碑 (见文件头)。 */}
      {available && (
      <Section>
        <SectionTitle title={zh ? '内嵌浏览器' : 'Embedded Browser'} />
        <SettingsCard>
          <div style={{ padding: 'var(--nx-space-3) var(--nx-space-4)', display: 'flex', gap: 8, alignItems: 'center' }}>
            <NeoxInput
              placeholder={available ? (zh ? '输入 URL...' : 'Enter URL...') : (zh ? '暂不支持' : 'Not available')}
              value={embeddedBrowserUrl}
              onChange={(e) => setEmbeddedBrowserUrl(e.target.value)}
              onKeyDown={(e) => { if (available && e.key === 'Enter') setShowEmbeddedBrowser(true); }}
              disabled={!available}
              title={available ? undefined : unavailableReason}
              style={{ flex: 1 }}
            />
            <NeoxButton
              variant="primary"
              size="sm"
              onClick={() => { if (available) setShowEmbeddedBrowser(true); }}
              disabled={!available || !embeddedBrowserUrl.trim()}
              title={available ? undefined : unavailableReason}
              leading={<Icons.Globe />}
            >
              {available ? (zh ? '打开' : 'Open') : (zh ? '暂不支持' : 'Unavailable')}
            </NeoxButton>
          </div>
          {available && showEmbeddedBrowser && embeddedBrowserUrl && (
            <div className="embedded-browser-container">
              <div className="embedded-browser-toolbar">
                <span className="browser-url-display">{embeddedBrowserUrl}</span>
                <NeoxButton
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowEmbeddedBrowser(false)}
                  aria-label="Close"
                >
                  <Icons.X />
                </NeoxButton>
              </div>
              <webview src={embeddedBrowserUrl} className="embedded-webview" />
            </div>
          )}
        </SettingsCard>
      </Section>
      )}
    </div>
  );
};

export default BrowserTab;
