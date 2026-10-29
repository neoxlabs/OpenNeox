
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { getEditionHook } from '../../../modules/shell/editionHooks';
import { useI18n, defaultIsZh } from '../../../hooks/useI18n';
import { confirmAsync } from '../../../components/confirmEvents';
import { dispatchOpFailed } from '../../../components/notifyEvents';
import { PageTitle, NeoxButton, Section, SectionTitle, SettingsCard, SettingsRow, SwitchRow } from '../../../components/settings-base';
import Icons from '../../../components/Icons';
import './MobileBridgeTab.clay.css';

interface MobileBridgeStatus {
  running: boolean;
  port: number;
  lan_ip: string | null;
  device_id: string;
  device_name: string;
  paired_count: number;
  active_connections: number;
  pending_pairings: number;
}

interface PairedMobileSafe {
  id: number;
  device_id: string;
  device_name: string | null;
  paired_at: number;
  last_seen_at: number | null;
  active_transport: 'lan' | 'cloud' | null;
}

interface PairingSessionInfo {
  ok: boolean;
  pairing_token: string;
  backup_code: string;
  expires_at: number;
  qr_payload: Record<string, any>;
  qr_encoded: string;
}

interface CloudStatus {
  logged_in: boolean;
  email: string | null;
  server_base_url: string | null;
  connected: boolean;
  auto_start: boolean;
}

const STALE_MS = 30 * 86400_000;

const MobileBridgeTab: React.FC = () => {
  const { language } = useI18n();
  const zh = language === 'zh';
  const [status, setStatus] = useState<MobileBridgeStatus | null>(null);
  const [paired, setPaired] = useState<PairedMobileSafe[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [pairingSession, setPairingSession] = useState<PairingSessionInfo | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [pairedFlash, setPairedFlash] = useState<{ name: string } | null>(null);
  const pairingStartedAtRef = useRef<number>(0);

  const api = (window as any).neox?.mobileBridge;

  const refresh = useCallback(async () => {
    if (!api) {
      setError(zh ? 'mobile bridge 不可用 (preload 未暴露)' : 'mobile bridge unavailable (preload not exposed)');
      setLoading(false);
      return;
    }
    try {
      const [s, p] = await Promise.all([api.status(), api.listPaired()]);
      setStatus(s);
      setPaired(p as PairedMobileSafe[]);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    const interval = pairingSession ? 1000 : 5000;
    const t = setInterval(() => void refresh(), interval);
    return () => clearInterval(t);
  }, [refresh, pairingSession]);

  useEffect(() => {
    if (!pairingSession || pairingStartedAtRef.current === 0) return;
    const fresh = paired.find((p) => p.paired_at >= pairingStartedAtRef.current);
    if (!fresh) return;
    setPairedFlash({ name: fresh.device_name ?? fresh.device_id });
    setPairingSession(null);
    pairingStartedAtRef.current = 0;
    const t = setTimeout(() => setPairedFlash(null), 2500);
    return () => clearTimeout(t);
  }, [paired, pairingSession]);

  const [pairingCountdown, setPairingCountdown] = useState(0);
  useEffect(() => {
    if (!pairingSession) { setPairingCountdown(0); return; }
    const tick = () => {
      const left = Math.max(0, pairingSession.expires_at - Date.now());
      setPairingCountdown(left);
      if (left <= 0) {
        setPairingSession(null);
        void refresh();
      }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [pairingSession, refresh]);

  const startPairing = useCallback(async () => {
    setPairingError(null);
    try {
      const r = await api.startPairing();
      if (r.ok) {
        pairingStartedAtRef.current = Date.now();
        setPairingSession(r);
      } else {
        setPairingError(r.error ?? (zh ? '配对启动失败' : 'Failed to start pairing'));
      }
    } catch (e: any) {
      setPairingError(e?.message ?? String(e));
    }
  }, [api]);

  const cancelPairing = useCallback(async () => {
    if (!pairingSession) return;
    try { await api.cancelPairing(pairingSession.pairing_token); } catch { /* ignore */ }
    setPairingSession(null);
    void refresh();
  }, [api, pairingSession, refresh]);

  const removePaired = useCallback(async (deviceId: string, deviceName: string | null) => {
    const ok = await confirmAsync({
      title: zh ? '移除设备' : 'Remove Device',
      message: zh ? `移除设备 "${deviceName ?? deviceId}"?` : `Remove device "${deviceName ?? deviceId}"?`,
      confirmLabel: zh ? '移除' : 'Remove',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await api.removePaired(deviceId);
      void refresh();
    } catch (e: any) {
      dispatchOpFailed({ op: zh ? '移除设备' : 'Remove device', message: e?.message ?? String(e) });
    }
  }, [api, refresh, zh]);

  const commitDeviceName = useCallback(async () => {
    const name = nameDraft.trim();
    if (!name || !status) { setEditingName(false); return; }
    if (name === status.device_name) { setEditingName(false); return; }
    try {
      await api.setDeviceName(name);
      setEditingName(false);
      void refresh();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, [api, nameDraft, status, refresh]);

  /* 在线的排前面, 其余按最近活跃倒序; 同名设备 (同型号手机/多个模拟器) 带上 id 尾巴才分得清 */
  const sorted = useMemo(() => {
    const seen = (p: PairedMobileSafe) => p.last_seen_at ?? p.paired_at;
    return [...paired].sort((a, b) => (Number(!!b.active_transport) - Number(!!a.active_transport)) || seen(b) - seen(a));
  }, [paired]);
  const dupNames = useMemo(() => {
    const n = new Map<string, number>();
    for (const p of paired) { const k = p.device_name ?? p.device_id; n.set(k, (n.get(k) ?? 0) + 1); }
    return n;
  }, [paired]);
  const onlineCount = paired.filter((p) => p.active_transport).length;
  const stale = paired.filter((p) => !p.active_transport && Date.now() - (p.last_seen_at ?? p.paired_at) > STALE_MS);

  const removeStale = useCallback(async () => {
    const ok = await confirmAsync({
      title: zh ? '清理不用的设备' : 'Remove unused devices',
      message: zh ? `移除 ${stale.length} 台 30 天没用过的设备?` : `Remove ${stale.length} devices unused for 30 days?`,
      confirmLabel: zh ? '移除' : 'Remove',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      for (const p of stale) await api.removePaired(p.device_id);
    } catch (e: any) {
      dispatchOpFailed({ op: zh ? '移除设备' : 'Remove device', message: e?.message ?? String(e) });
    }
    void refresh();
  }, [api, refresh, stale, zh]);

  if (loading) return <div className="neox-text-shimmer rm-placeholder">{zh ? '加载中…' : 'Loading…'}</div>;
  if (error) return <div className="rm-placeholder is-bad">{zh ? '错误: ' : 'Error: '}{error}</div>;
  if (!status) return <div className="rm-placeholder">{zh ? '无状态' : 'No status'}</div>;

  return (
    <div className="settings-panel-content mb3">
      <PageTitle
        title={zh ? '远程访问' : 'Remote access'}
        subtitle={zh ? '在手机上接着用这台电脑的会话' : 'Pick up this computer’s sessions on your phone'}
      />

      {/* 本机行: 名字 (点击改名) + 设备数 / 在线数 + 配对按钮 */}
      <Section>
        <SettingsCard>
          <div className="nx-row mb3-host">
            <span className="mb3-ico" aria-hidden="true"><LaptopIcon /></span>
            <div className="mb3-host__info">
              <div className="mb3-host__name">
                {editingName ? (
                  <input
                    className="rm-name-input"
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onBlur={commitDeviceName}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitDeviceName(); if (e.key === 'Escape') setEditingName(false); }}
                    autoFocus
                  />
                ) : (
                  <>
                    <button type="button" className="rm-name" onClick={() => { setNameDraft(status.device_name); setEditingName(true); }}
                      title={zh ? '点击改名' : 'Click to rename'}>
                      {status.device_name}
                    </button>
                    <button type="button" className="mb3-rename" onClick={() => { setNameDraft(status.device_name); setEditingName(true); }}>
                      {zh ? '改名' : 'Rename'}
                    </button>
                  </>
                )}
              </div>
              <span className="mb3-host__meta">
                <span className={onlineCount ? 'is-live' : ''}>
                  {zh ? `${paired.length} 台设备 · ${onlineCount} 台在线` : `${paired.length} devices · ${onlineCount} online`}
                </span>
              </span>
            </div>
            <NeoxButton variant="secondary" size="sm" onClick={() => void startPairing()} disabled={!status.running || !!pairingSession}>
              {zh ? '+ 配对手机' : '+ Pair phone'}
            </NeoxButton>
          </div>
        </SettingsCard>

        {pairedFlash && (
          <div className="rm-flash">
            <CheckIcon />
            <span><strong>{pairedFlash.name}</strong> {zh ? '已配对' : 'paired'}</span>
          </div>
        )}
        {pairingSession && (
          <PairingPanel session={pairingSession} countdownMs={pairingCountdown} onCancel={cancelPairing} />
        )}
        {pairingError && <div className="rm-err">{pairingError}</div>}
      </Section>

      {/* 连接方式: 局域网 / 云中转 —— 同一张卡里的线条图标行 */}
      <Section>
        <SectionTitle title={zh ? '连接方式' : 'Connections'} />
        <SettingsCard>
          <LanCard status={status} />
          {/* 云中转要登录账号 —— 没有账号体系的构建只有局域网这一路 */}
          {getEditionHook('hasAccount') && <CloudRows />}
          <SelfRelayRow />
        </SettingsCard>
      </Section>

      {/* 已配对设备: 一张列表卡 */}
      <Section>
        <SectionTitle
          title={<>{zh ? '已配对设备' : 'Paired devices'}<span className="mb3-count">{paired.length}</span></>}
        />
        <SettingsCard>
          {paired.length === 0 ? (
            <div className="nx-row mb3-empty">
              <span>{zh ? '还没有设备，点「配对手机」扫码添加。' : 'No devices yet. Use “Pair phone” to add one.'}</span>
            </div>
          ) : (
            sorted.map((m) => (
              <PairedDeviceRow
                key={m.id}
                paired={m}
                dup={(dupNames.get(m.device_name ?? m.device_id) ?? 0) > 1}
                onRename={async (newName) => {
                  await api.renamePaired(m.device_id, newName);
                  void refresh();
                }}
                onRemove={() => void removePaired(m.device_id, m.device_name)}
              />
            ))
          )}
          {stale.length > 0 && (
            <button type="button" className="nx-row nx-row--clickable mb3-clean" onClick={() => void removeStale()}>
              <span className="mb3-ico mb3-ico--danger" aria-hidden="true"><TrashIcon /></span>
              <span className="mb3-clean__text">{zh ? `清理 30 天未用的设备 (${stale.length})` : `Remove devices unused for 30+ days (${stale.length})`}</span>
              <span className="mb3-clean__go" aria-hidden="true">›</span>
            </button>
          )}
        </SettingsCard>
      </Section>
    </div>
  );
};

/* ─── 已配对设备行 ─ 点名字改名, 右侧「移除」 ─────────────────────────── */

const PairedDeviceRow: React.FC<{
  paired: PairedMobileSafe;
  dup: boolean;
  onRename: (newName: string) => Promise<void>;
  onRemove: () => void;
}> = ({ paired, dup, onRename, onRemove }) => {
  const { language } = useI18n();
  const zh = language === 'zh';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const commit = async () => {
    const next = draft.trim();
    setEditing(false);
    if (next === (paired.device_name ?? '')) return;
    await onRename(next);
  };

  const transport = paired.active_transport;
  const lastAt = paired.last_seen_at ?? paired.paired_at;
  const isStale = !transport && Date.now() - lastAt > STALE_MS;
  const name = paired.device_name ?? paired.device_id;

  return (
    <div className={`nx-row mb3-dev${transport ? ' is-live' : ''}${isStale ? ' is-stale' : ''}`}>
      <span className="mb3-ico" aria-hidden="true"><PhoneIcon /></span>
      <div className="mb3-dev__info">
        {editing ? (
          <input
            className="rm-name-input rm-name-input--sm"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') void commit(); if (e.key === 'Escape') setEditing(false); }}
            autoFocus
            maxLength={64}
          />
        ) : (
          <button type="button" className="rm-device__name" onClick={() => { setDraft(paired.device_name ?? ''); setEditing(true); }}
            title={zh ? `${name} · 点击改名` : `${name} · click to rename`}>
            {name}
          </button>
        )}
        <span className="rm-device__meta">
          {transport
            ? <span className="mb3-pill is-ok"><i className="rm-dot is-ok" />{transport === 'lan' ? (zh ? '局域网在线' : 'Online · LAN') : (zh ? '云中转在线' : 'Online · relay')}</span>
            : <span className="mb3-pill"><i className="rm-dot" />{paired.last_seen_at
              ? relTime(paired.last_seen_at, zh)
              : (zh ? `配对于 ${relTime(paired.paired_at, zh)}` : `Paired ${relTime(paired.paired_at, zh)}`)}</span>}
          {dup && <em>#{paired.device_id.slice(-4)}</em>}
        </span>
      </div>
      <NeoxButton variant="secondary" size="sm" onClick={onRemove}
        aria-label={zh ? `移除 ${name}` : `Remove ${name}`}>
        {zh ? '移除' : 'Remove'}
      </NeoxButton>
    </div>
  );
};

/* ─── 局域网行 ──────────────────────────────────────────────────────── */

const LanCard: React.FC<{ status: MobileBridgeStatus }> = ({ status }) => {
  const { language } = useI18n();
  const zh = language === 'zh';
  const live = status.active_connections > 0;
  return (
    <SettingsRow
      leading={<span className="mb3-ico" aria-hidden="true"><Icons.Wifi /></span>}
      title={zh ? '局域网直连' : 'Local network'}
      desc={(
        <>
          {zh ? '同一 WiFi 下直连，免登录，自带 API Key 也能用。' : 'Direct on the same WiFi. No sign-in; your own API key works.'}
          {status.running && status.lan_ip && <> <span className="rm-mono">{status.lan_ip}:{status.port}</span></>}
        </>
      )}
      control={(
        <StatusPill tone={live ? 'ok' : 'idle'} text={live
          ? (zh ? `${status.active_connections} 台在线` : `${status.active_connections} online`)
          : status.running ? (zh ? '待机' : 'Idle') : (zh ? '配对时启动' : 'Starts on pairing')} />
      )}
    />
  );
};

/* ─── 自托管中继行 ─ 自己服务器上的 cloud/relay, 地址 + 部署令牌, 不要账号 ──── */

interface SelfRelayState { configured: boolean; url: string; token_tail: string; connected: boolean }

const SELF_RELAY_DOCS = 'https://github.com/neoxlabs/OpenNeox/tree/main/cloud/relay';

const SelfRelayRow: React.FC = () => {
  const { language } = useI18n();
  const zh = language === 'zh';
  const api = (window as any).neox?.mobileBridge;
  const [state, setState] = useState<SelfRelayState | null>(null);
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setState(await api?.selfRelayGet?.()); } catch { /* ignore */ }
  }, [api]);
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const errText = (code: string): string => {
    if (code === 'invalid_url') return zh ? '地址格式不对，应为 https://你的域名' : 'Enter a URL like https://relay.example.com';
    if (code === 'token_too_short') return zh ? '令牌至少 16 位' : 'The token must be at least 16 characters';
    if (code === 'not_a_relay') return zh ? '这个地址不是 Neox 中继' : 'That address is not a Neox relay';
    if (code.startsWith('unreachable')) return zh ? `连不上这个地址 (${code.slice(12).trim()})` : `Could not reach it (${code.slice(12).trim()})`;
    return code;
  };

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.selfRelaySet({ url, token });
      if (!r?.ok) { setErr(errText(r?.error ?? 'error')); return; }
      setEditing(false); setToken('');
      await refresh();
    } finally { setBusy(false); }
  };

  const clear = async () => {
    const ok = await confirmAsync({
      title: zh ? '移除自托管中继？' : 'Remove the self-hosted relay?',
      message: zh ? '手机将只能在同一 WiFi 下连接这台电脑。' : 'Your phone will only reach this computer on the same Wi-Fi.',
    });
    if (!ok) return;
    await api.selfRelayClear();
    setEditing(false);
    await refresh();
  };

  const configured = !!state?.configured;
  const startEdit = () => { setUrl(state?.url ?? ''); setToken(''); setErr(null); setEditing(true); };

  return (
    <>
      <SettingsRow
        leading={<span className="mb3-ico" aria-hidden="true"><Icons.Server /></span>}
        title={zh ? '自托管中继' : 'Self-hosted relay'}
        desc={configured ? (
          <><span className="rm-mono">{state!.url}</span>{' '}{zh ? '· 端到端加密，中继看不到内容' : '· end-to-end encrypted'}</>
        ) : (
          <>
            {zh ? '在自己的服务器上部署中继，出门也能连这台电脑。' : 'Run the relay on your own server to reach this computer from anywhere.'}{' '}
            <a href={SELF_RELAY_DOCS} target="_blank" rel="noreferrer">{zh ? '部署说明' : 'Setup guide'}</a>
          </>
        )}
        control={configured && !editing ? (
          <div className="mb3-inline-actions">
            <StatusPill tone={state!.connected ? 'ok' : 'idle'} text={state!.connected ? (zh ? '已连接' : 'Connected') : (zh ? '未连接' : 'Not connected')} />
            <NeoxButton variant="secondary" size="sm" onClick={startEdit}>{zh ? '修改' : 'Edit'}</NeoxButton>
          </div>
        ) : !editing ? (
          <NeoxButton variant="secondary" size="sm" onClick={startEdit}>{zh ? '设置' : 'Set up'}</NeoxButton>
        ) : null}
      />
      {editing && (
        <div className="nx-row mb3-relay-form">
          <input className="rm-name-input" placeholder="https://relay.example.com" value={url}
            onChange={(e) => setUrl(e.target.value)} autoFocus spellCheck={false} />
          <input className="rm-name-input" type="password"
            placeholder={configured ? (zh ? `令牌 (留空沿用 …${state!.token_tail})` : `Token (blank keeps …${state!.token_tail})`) : (zh ? '部署令牌 RELAY_TOKEN' : 'RELAY_TOKEN')}
            value={token} onChange={(e) => setToken(e.target.value)} spellCheck={false}
            onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
          <div className="mb3-inline-actions">
            {configured && <NeoxButton variant="secondary" size="sm" onClick={() => void clear()}>{zh ? '移除' : 'Remove'}</NeoxButton>}
            <NeoxButton variant="secondary" size="sm" onClick={() => setEditing(false)}>{zh ? '取消' : 'Cancel'}</NeoxButton>
            <NeoxButton size="sm" disabled={busy} onClick={() => void save()}>{busy ? (zh ? '连接中…' : 'Connecting…') : (zh ? '保存' : 'Save')}</NeoxButton>
          </div>
          {err && <div className="rm-err">{err}</div>}
          {!configured && (
            <div className="mb3-relay-hint">
              {zh ? '保存后，已配对的手机下次在同一 WiFi 连上时会自动拿到中继地址；新手机扫码配对时一并带上。'
                : 'Paired phones pick up the relay the next time they connect on the same Wi-Fi; new phones get it when they pair.'}
            </div>
          )}
        </div>
      )}
    </>
  );
};

/* ─── 云中转行 ──────────────────────────────────────────────────────── */

const CloudRows: React.FC = () => {
  const { language } = useI18n();
  const zh = language === 'zh';
  const [status, setStatus] = useState<(CloudStatus & { display_name?: string | null }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await (window as any).neox?.mobileBridge?.cloudStatus?.();
      if (s) setStatus(s);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const setRunning = async (on: boolean) => {
    setBusy(true); setErr(null);
    try {
      if (!on) {
        await (window as any).neox.mobileBridge.cloudStop();
      } else {
        const r = await (window as any).neox.mobileBridge.cloudStart();
        if (!r.ok) setErr(r.error ?? (zh ? '启动失败' : 'Failed to start'));
      }
      await refresh();
    } finally { setBusy(false); }
  };

  const setAutoStart = async (v: boolean) => {
    await (window as any).neox.mobileBridge.cloudSetAutoStart(v);
    await refresh();
  };

  const loggedIn = !!status?.logged_in;
  const live = loggedIn && !!status?.connected;
  const errLine = err ? <> <span className="rm-err-inline">{err}</span></> : null;
  if (!loggedIn) {
    return (
      <SettingsRow
        leading={<span className="mb3-ico" aria-hidden="true"><Icons.Cloud /></span>}
        title={zh ? '云中转' : 'Cloud relay'}
        desc={<>{zh ? '4G、外网也能连，登录后可用。' : 'Works over cellular and other networks after sign-in.'}{errLine}</>}
        control={(
          <NeoxButton variant="secondary" size="sm" onClick={() => window.dispatchEvent(new CustomEvent('neox:login-required'))}>
            {zh ? '登录 Neox' : 'Sign in'}
          </NeoxButton>
        )}
      />
    );
  }
  return (
    <>
      <SwitchRow
        leading={<span className="mb3-ico" aria-hidden="true"><Icons.Cloud /></span>}
        title={zh ? '云中转' : 'Cloud relay'}
        desc={<>{zh ? '4G、外网也能连。' : 'Works over cellular and other networks.'} <span className="rm-muted">{status?.display_name || status?.email}</span>{errLine}</>}
        checked={live}
        disabled={busy}
        onChange={(v) => void setRunning(v)}
      />
      <SwitchRow
        leading={<span className="mb3-ico" aria-hidden="true"><BoltIcon /></span>}
        title={zh ? '开机自动连' : 'Auto-connect on start'}
        desc={zh ? '打开 Neox 就连上云中转。' : 'Connects the relay when Neox starts.'}
        checked={!!status?.auto_start}
        disabled={busy}
        onChange={(v) => void setAutoStart(v)}
      />
    </>
  );
};

/* ─── 配对面板 ─────────────────────────────────────────────────────── */

const PairingPanel: React.FC<{
  session: PairingSessionInfo;
  countdownMs: number;
  onCancel: () => void;
}> = ({ session, countdownMs, onCancel }) => {
  const { language } = useI18n();
  const zh = language === 'zh';
  /* 倒计时条: 以面板出现时剩下的时间为满格 (session 里没有起始时刻) */
  const totalRef = useRef(0);
  if (totalRef.current === 0 && countdownMs > 0) totalRef.current = countdownMs;
  const frac = totalRef.current > 0 ? Math.max(0, Math.min(1, countdownMs / totalRef.current)) : 1;
  return (
    <section className="rm-pair mb3-pair">
      <QrCanvas data={session.qr_encoded} />
      <div className="rm-pair__body">
        <h4>{zh ? '用 Neox 手机端扫码' : 'Scan with the Neox phone app'}</h4>
        <span className="rm-pair__label">{zh ? '或输入配对码' : 'Or enter the code'}</span>
        <code className="rm-pair__code">{session.backup_code}</code>
        <div className="rm-pair__timer" aria-hidden="true"><i style={{ transform: `scaleX(${frac})` }} /></div>
        <div className="rm-pair__foot">
          <span>{zh ? `${Math.ceil(countdownMs / 1000)} 秒后过期` : `Expires in ${Math.ceil(countdownMs / 1000)}s`}</span>
          <NeoxButton variant="ghost" size="sm" onClick={onCancel}>{zh ? '取消' : 'Cancel'}</NeoxButton>
        </div>
      </div>
    </section>
  );
};

const QrCanvas: React.FC<{ data: string }> = ({ data }) => {
  const { language } = useI18n();
  const zh = language === 'zh';
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    QRCode.toCanvas(canvas, `neox://pair?data=${data}`, {
      width: 144,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    }).catch((e: Error) => setErr(e.message));
  }, [data]);

  if (err) return <div className="rm-qr is-bad">{zh ? '二维码生成失败' : 'QR render failed'}</div>;
  return <div className="rm-qr"><canvas ref={canvasRef} /></div>;
};

/* ─── 小组件 ───────────────────────────────────────────────────────── */

const svgProps = { width: 16, height: 16, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

const LaptopIcon: React.FC = () => (
  <svg {...svgProps}><rect x="4.5" y="5" width="11" height="8" rx="1.2" /><path d="M2.5 15.5h15" /></svg>
);

const PhoneIcon: React.FC = () => (
  <svg {...svgProps}><rect x="6" y="2.5" width="8" height="15" rx="2" /><path d="M9 14.8h2" /></svg>
);

const TrashIcon: React.FC = () => (
  <svg {...svgProps}><path d="M3.5 5.5h13M8 5.5V4h4v1.5" /><path d="M5.5 5.5l.7 10a1 1 0 0 0 1 .9h5.6a1 1 0 0 0 1-.9l.7-10" /></svg>
);

const BoltIcon: React.FC = () => (
  <svg {...svgProps}><path d="M11 2.5 4.5 11h5l-1 6.5L15.5 9h-5l.5-6.5Z" /></svg>
);

const CheckIcon: React.FC = () => (
  <svg className="rm-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="20 6 9 17 4 12" pathLength={1} />
  </svg>
);

const StatusPill: React.FC<{ tone: 'ok' | 'idle'; text: string }> = ({ tone, text }) => (
  <span className={`rm-pill mb3-pill${tone === 'ok' ? ' is-ok' : ''}`}><i className={`rm-dot${tone === 'ok' ? ' is-ok' : ''}`} />{text}</span>
);

function relTime(ms: number, zh = defaultIsZh()): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (zh) {
    if (s < 60) return '刚刚';
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
    if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
    return `${Math.floor(s / 86400)} 天前`;
  }
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default MobileBridgeTab;
