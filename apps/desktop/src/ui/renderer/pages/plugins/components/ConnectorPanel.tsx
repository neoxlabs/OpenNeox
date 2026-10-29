/**
 * ConnectorPanel — 已装连接器的连接 / 授权 / 自检
 *
 *   一个 connector 装上之后要能真正被 Agent 用, 用户还差三步:
 *     1. 连账号 (粘贴令牌)
 *     2. 确认授了哪些能力
 *     3. 确认真的通
 *   这三步没有落地的地方, 插件就停在「装上了但不能用」——所以它们收在同一张卡里。
 *
 *   令牌只写不读: 输入框里的值提交后立刻清空, 渲染进程从不回读已存的凭据,
 *   主进程也没有回读的通道 (见 pluginHandlers 的 CONNECTOR_* 注释)。
 */

import React, { useCallback, useEffect, useState } from 'react';
import type {
  PluginConnectorSummary,
  PluginExternalAgentSummary,
} from '@neoxlabs/platform/shared/ipc/plugin.js';
import { useI18n } from '../../../hooks/useI18n.js';
import { confirmAsync } from '../../../components/confirmEvents';
import { PluginBrandLogo } from './PluginBrandLogo.js';

const EFFECT_META: Record<string, { zh: string; en: string; tone: string }> = {
  readonly: { zh: '只读', en: 'read', tone: 'is-muted' },
  writes: { zh: '写入', en: 'write', tone: 'is-warn' },
  destructive: { zh: '不可逆', en: 'destructive', tone: 'is-danger' },
  costly: { zh: '计费', en: 'costly', tone: 'is-danger' },
};

/* 外部 Agent 的委派工具目前到不了模型手里 (见下方 section 的注释)。
 * 修好之后把这里翻成 true, 整节连同卡片/安装指引一起回来 —— 不需要改别处。 */
const EXTERNAL_AGENTS_READY = false;

/* 说明里的「去哪拿令牌」网址 (dash.cloudflare.com/profile/api-tokens) 做成链接 —— 用户第一步就是打开它,
 * 纯文本得自己选中复制。要求带路径, 免得把 Zone.Zone 这种权限名当成域名。 */
const INSTRUCTION_URL_RE = /((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}\/[\w\-./?=&%#]*[\w/])/gi;
export function linkifyInstructions(text: string): React.ReactNode[] {
  return text.split(INSTRUCTION_URL_RE).map((part, i) =>
    i % 2 === 1
      ? <a key={i} href={/^https?:\/\//i.test(part) ? part : `https://${part}`} target="_blank" rel="noreferrer">{part}</a>
      : part);
}

export const ConnectorPanel: React.FC<{ pluginName?: string }> = ({ pluginName }) => {
  const { language } = useI18n();
  const isZh = language === 'zh';

  const [connectors, setConnectors] = useState<PluginConnectorSummary[]>([]);
  const [externalAgents, setExternalAgents] = useState<PluginExternalAgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [tokenDraft, setTokenDraft] = useState<Record<string, string>>({});
  const [fieldDraft, setFieldDraft] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Record<string, { ok: boolean; text: string }>>({});

  const fieldValue = (pluginName: string, key: string, fallback?: unknown) => {
    const draft = fieldDraft[pluginName]?.[key];
    if (draft !== undefined) return draft;
    return typeof fallback === 'string' ? fallback : '';
  };

  const extraFields = (c: PluginConnectorSummary) =>
    (c.connectionFields ?? []).filter(f => f.key !== 'clientId');

  const buildConnection = (c: PluginConnectorSummary) => {
    const next: Record<string, unknown> = { ...c.connection };
    for (const f of extraFields(c)) {
      const v = fieldValue(c.pluginName, f.key, c.connection?.[f.key]).trim();
      if (v) next[f.key] = v;
      else delete next[f.key];
    }
    return next;
  };

  const missingRequired = (c: PluginConnectorSummary) =>
    extraFields(c).some(f => f.required && !fieldValue(c.pluginName, f.key, c.connection?.[f.key]).trim());

  const refresh = useCallback(async () => {
    const api = (window as any).neox;
    if (!api?.pluginConnectorList) { setLoading(false); return; }
    try {
      const [conns, agents] = await Promise.all([
        api.pluginConnectorList({ lang: isZh ? 'zh' : 'en' }),
        api.pluginExternalAgentList?.() ?? Promise.resolve([]),
      ]);
      setConnectors(conns ?? []);
      setExternalAgents(agents ?? []);
    } finally {
      setLoading(false);
    }
  }, [isZh]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const onChanged = () => { void refresh(); };
    window.addEventListener('neox:plugins-changed', onChanged);
    return () => window.removeEventListener('neox:plugins-changed', onChanged);
  }, [refresh]);

  const connect = useCallback(async (c: PluginConnectorSummary) => {
    const api = (window as any).neox;
    const token = (tokenDraft[c.pluginName] ?? '').trim();
    if (!token) return;
    setBusy(c.pluginName);
    try {
      const res = await api.pluginConnectorConnect({
        pluginName: c.pluginName,
        token,
        connection: buildConnection(c),
      });
      /* 成功与否都清掉草稿 —— 令牌不该在渲染进程的 state 里多待一秒 */
      setTokenDraft(prev => ({ ...prev, [c.pluginName]: '' }));
      setNotice(prev => ({
        ...prev,
        [c.pluginName]: res?.success
          ? { ok: true, text: isZh ? '已连接' : 'Connected' }
          : { ok: false, text: res?.error || (isZh ? '连接失败' : 'Failed') },
      }));
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [tokenDraft, fieldDraft, isZh, refresh]);

  const oauth = useCallback(async (c: PluginConnectorSummary) => {
    const api = (window as any).neox;
    if (!api?.pluginConnectorOAuth) return;
    setBusy(c.pluginName);
    try {
      const res = await api.pluginConnectorOAuth({
        pluginName: c.pluginName,
        connection: buildConnection(c),
      });
      setNotice(prev => ({
        ...prev,
        [c.pluginName]: res?.success
          ? { ok: true, text: isZh ? '已连接' : 'Connected' }
          : { ok: false, text: res?.error || (isZh ? '授权失败' : 'Failed') },
      }));
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [fieldDraft, isZh, refresh]);

  const disconnect = useCallback(async (name: string) => {
    const api = (window as any).neox;
    const ok = await confirmAsync({
      title: isZh ? '断开连接' : 'Disconnect',
      message: isZh ? `确定断开「${name}」？` : `Disconnect “${name}”?`,
      description: isZh
        ? '本机保存的凭据和已授予的能力都会被清除，之后需要重新粘贴令牌才能用。'
        : 'The stored credential and all granted capabilities are cleared — you’ll need to paste the token again.',
      variant: 'danger',
      confirmLabel: isZh ? '断开' : 'Disconnect',
    });
    if (!ok) return;
    setBusy(name);
    try {
      await api.pluginConnectorDisconnect(name);
      setNotice(prev => ({ ...prev, [name]: { ok: true, text: isZh ? '已断开' : 'Disconnected' } }));
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [isZh, refresh]);

  const toggleGrant = useCallback(async (c: PluginConnectorSummary, capability: string) => {
    const api = (window as any).neox;
    const next = c.permissions
      .filter(p => (p.capability === capability ? !p.granted : p.granted))
      .map(p => p.capability);
    setBusy(c.pluginName);
    try {
      const res = await api.pluginConnectorSetGrants({ pluginName: c.pluginName, capabilities: next });
      if (!res?.success) {
        setNotice(prev => ({ ...prev, [c.pluginName]: { ok: false, text: res?.error || 'Failed' } }));
      }
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const test = useCallback(async (c: PluginConnectorSummary) => {
    const api = (window as any).neox;
    /* 拿一条已授予的只读能力去打 —— 自检不该有副作用 */
    const probe = c.permissions.find(p => p.effect === 'readonly' && p.granted);
    if (!probe) {
      setNotice(prev => ({
        ...prev,
        [c.pluginName]: { ok: false, text: isZh ? '没有已授予的只读能力可用于自检' : 'No granted read-only capability to probe' },
      }));
      return;
    }
    setBusy(c.pluginName);
    try {
      const res = await api.pluginConnectorTest({ pluginName: c.pluginName, capability: probe.capability });
      setNotice(prev => ({
        ...prev,
        [c.pluginName]: res?.success
          ? { ok: true, text: isZh ? `连通 (HTTP ${res.status})` : `Reachable (HTTP ${res.status})` }
          /* 缺参数导致的失败也是「连上了」的证据, 但别把它说成成功 */
          : { ok: false, text: `${res?.code ?? 'error'}: ${String(res?.error ?? '').slice(0, 160)}` },
      }));
    } finally {
      setBusy(null);
    }
  }, [isZh]);

  const visibleConnectors = pluginName
    ? connectors.filter(c => c.pluginName === pluginName)
    : connectors;
  const showExternal = EXTERNAL_AGENTS_READY && !pluginName && externalAgents.length > 0;

  if (loading || (visibleConnectors.length === 0 && !showExternal)) return null;

  return (
    <>
    {EXTERNAL_AGENTS_READY && externalAgents.length > 0 && (
      <section className="neox-connector-panel">
        <header className="neox-connector-panel__head">
          <h3 className="neox-connector-panel__title">{isZh ? '外部 Agent' : 'External agents'}</h3>
          <span className="neox-connector-panel__hint">
            {isZh
              ? '把活派给本机其它 agent CLI，在独立分支上跑'
              : 'Delegate work to other agent CLIs on this machine, on an isolated branch'}
          </span>
        </header>

        {externalAgents.map(a => (
          <div key={`${a.pluginName}:${a.id}`} className="neox-connector-card">
            <div className="neox-connector-card__head">
              <span className={`neox-connector-card__dot${a.installed ? ' is-on' : ''}`} aria-hidden="true" />
              <span className="neox-connector-card__name">{a.displayName}</span>
              <span className="neox-plugin-card__chip is-muted">{a.id}_delegate</span>
              {a.isolation === 'worktree'
                ? <span className="neox-plugin-card__chip is-muted">{isZh ? '独立分支' : 'worktree'}</span>
                : <span className="neox-plugin-card__chip is-warn">{isZh ? '直接改工作区' : 'shared workspace'}</span>}
              <span className="neox-plugin-card__chip is-warn">{isZh ? '暂不支持' : 'Not available'}</span>
              <span className="neox-connector-card__spacer" />
              <span className="neox-connector-card__msg">
                {a.installed ? (a.version || (isZh ? '已安装' : 'installed')) : (isZh ? '未安装' : 'not installed')}
              </span>
            </div>

            {/* 没装就给安装指引 —— 这是唯一能让用户自己解决的信息 */}
            {!a.installed && (
              <p className="neox-connector-card__instructions">{a.installHint}</p>
            )}

            {/* 示例指令先撤掉 —— 委派工具目前到不了模型手里, 照着敲只会得到"我没有这个工具"。
              * 换成一句说清现状的话。等工具能被检索到了, 把这段换回 examplePrompts 即可。 */}
            {a.installed && (
              <p className="neox-connector-card__instructions">
                {isZh
                  ? `已检测到 ${a.displayName}，但委派工具（${a.id}_delegate）还没接进 Agent 的工具表，暂时用不了。`
                  : `${a.displayName} is detected, but its delegate tool (${a.id}_delegate) is not wired into the agent's tool list yet.`}
              </p>
            )}
          </div>
        ))}
      </section>
    )}

    {visibleConnectors.length > 0 && (
    <section className={`neox-connector-panel${pluginName ? ' is-embedded' : ''}`}>
      {!pluginName && (
      <header className="neox-connector-panel__head">
        <h3 className="neox-connector-panel__title">{isZh ? '平台连接' : 'Connections'}</h3>
        <span className="neox-connector-panel__hint">
          {isZh ? '连上之后这些工具才会出现在 Agent 的工具表里' : 'Agents only see these tools once connected'}
        </span>
      </header>
      )}

      {visibleConnectors.map(c => {
        const msg = notice[c.pluginName];
        const isBusy = busy === c.pluginName;
        return (
          <div key={c.pluginName} className="neox-connector-card">
            <div className="neox-connector-card__head">
              <PluginBrandLogo name={c.pluginName} size={20} />
              <span className={`neox-connector-card__dot${c.connected ? ' is-on' : ''}`} aria-hidden="true" />
              <span className="neox-connector-card__name">{c.displayName}</span>
              <span className="neox-plugin-card__chip is-muted">{c.namespace}</span>
              {!c.enabled && (
                <span className="neox-plugin-card__chip is-muted">{isZh ? '已禁用' : 'disabled'}</span>
              )}
              <span className="neox-connector-card__spacer" />
              {c.connected && (
                <>
                  <button className="neox-plugins__btn is-ghost" disabled={isBusy} onClick={() => test(c)}>
                    {isZh ? '自检' : 'Test'}
                  </button>
                  <button className="neox-plugins__btn is-ghost" disabled={isBusy} onClick={() => disconnect(c.pluginName)}>
                    {isZh ? '断开' : 'Disconnect'}
                  </button>
                </>
              )}
            </div>

            {!c.connected && extraFields(c).length > 0 && (
              <div className="neox-connector-card__connect">
                {extraFields(c).map(f => (
                  <input
                    key={f.key}
                    type="text"
                    className="neox-connector-card__input"
                    placeholder={f.placeholder || f.label}
                    aria-label={f.label}
                    value={fieldValue(c.pluginName, f.key, c.connection?.[f.key])}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={e => setFieldDraft(prev => ({
                      ...prev,
                      [c.pluginName]: { ...prev[c.pluginName], [f.key]: e.target.value },
                    }))}
                  />
                ))}
              </div>
            )}

            {!c.connected && c.authKind === 'token' && (
              <div className="neox-connector-card__connect">
                {c.authInstructions && (
                  <p className="neox-connector-card__instructions">{linkifyInstructions(c.authInstructions)}</p>
                )}
                <div className="neox-connector-card__row">
                  <input
                    type="password"
                    className="neox-connector-card__input"
                    placeholder={isZh ? '粘贴访问令牌' : 'Paste access token'}
                    value={tokenDraft[c.pluginName] ?? ''}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={e => setTokenDraft(prev => ({ ...prev, [c.pluginName]: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter' && !missingRequired(c)) void connect(c); }}
                  />
                  <button
                    className="neox-plugins__btn is-primary"
                    disabled={isBusy || !(tokenDraft[c.pluginName] ?? '').trim() || missingRequired(c)}
                    onClick={() => connect(c)}
                  >
                    {isZh ? '连接' : 'Connect'}
                  </button>
                </div>
                <p className="neox-connector-card__note">
                  {isZh
                    ? '令牌用本机密钥加密后存放，换台机器解不开，也不会出主进程。'
                    : 'Encrypted with a machine-derived key; it never leaves the main process.'}
                </p>
              </div>
            )}

            {!c.connected && c.authKind === 'oauth2' && (
              <div className="neox-connector-card__connect">
                <p className="neox-connector-card__instructions">
                  {c.authInstructions || (isZh
                    ? '在浏览器里登录授权。官方应用还在审核时，这里会登不上。'
                    : 'Sign in with your browser. This stays unavailable until the official app is approved.')}
                </p>
                <div className="neox-connector-card__row">
                  <button
                    className="neox-plugins__btn is-primary"
                    disabled={isBusy || missingRequired(c)}
                    onClick={() => void oauth(c)}
                  >
                    {isZh ? '授权登录' : 'Sign in'}
                  </button>
                </div>
              </div>
            )}

            <ul className="neox-connector-card__perms">
              {c.permissions.map(p => {
                const meta = EFFECT_META[p.effect] ?? EFFECT_META.readonly;
                return (
                  <li key={p.capability} className="neox-connector-card__perm">
                    <label>
                      <input
                        type="checkbox"
                        checked={p.granted}
                        disabled={isBusy}
                        onChange={() => toggleGrant(c, p.capability)}
                      />
                      <span className="neox-connector-card__reason">{p.reason}</span>
                      <span className={`neox-plugin-card__chip ${meta.tone}`}>
                        {isZh ? meta.zh : meta.en}
                        {p.approxUsd ? ` · $${p.approxUsd}` : ''}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>

            <p className="neox-connector-card__tools">
              {isZh ? '工具：' : 'Tools: '}{c.tools.join(', ')}
            </p>

            {msg && (
              <p className={`neox-connector-card__msg${msg.ok ? ' is-ok' : ' is-err'}`}>{msg.text}</p>
            )}
          </div>
        );
      })}
    </section>
    )}
    </>
  );
};
