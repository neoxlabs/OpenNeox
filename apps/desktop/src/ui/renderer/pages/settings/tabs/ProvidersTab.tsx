import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSettingsContext } from '../SettingsContext';
import { isByokPinned, setByokPinned, useByokPinned } from '../../../state/byokPickerPrefs';
import { ProviderBrandIcon, inferProviderBrand, type ProviderBrand } from '../../../modules/agent-timeline/ProviderBrandIcon';
import { NEOX_CLOUD_PROVIDER_ID } from '../../../../shared/neoxCloud';
import { ProviderEditForm } from './ProviderEditForm';
import { CustomSelect } from '../../../components/CustomSelect';
import { NeoxIllus } from '../../../media/illus';
import { PageTitle, Segmented } from '../../../components/settings-base';
import {
  isProviderHealthCheckSkipped,
  setProviderHealthCheckSkipped,
  useProviderHealthPrefsVersion,
} from '../providerHealthPrefs';

/* ============================================================
 * ProvidersTab V2 — API 服务商 (设计图驱动)
 *
 *   - 顶部: 标题 + 自动测速 toggle + 检测频率 popover + 添加服务商
 *   - 3 张统计卡: 已配置 / 健康可用 / 异常告警 (从 healthMap 实时聚合)
 *   - 2 列 grid: 每张卡含 sparkline + 延迟 + 成功率 + URL + 模型 chips
 *   - 底部 hint
 *
 *   后端能力都齐: window.neox.checkProviderHealth / health-data 持久化 / 自动测速 / 频率持久化.
 *   UI 只是把已有 SettingsContext 暴露的 handler 换装到设计图.
 * ============================================================ */

type HealthHistoryEntry = {
  status: string;
  latency: number;
  timestamp: number;
  error?: string;
  httpStatus?: number;
  model?: string;
};

type AnyHealth = {
  /** 未测过时缺席 —— 不得兜底成 'offline' (见 resolveHealthKind 注释) */
  current?: 'excellent' | 'good' | 'poor' | 'offline' | 'error' | 'testing';
  latency?: number;
  history?: HealthHistoryEntry[];
};

/* 状态码 → 一句人话诊断. 已提到 ../utils/httpStatusHint 共用 —— "测试连接"那边也要用. */
import { httpStatusHint } from '../utils/httpStatusHint.js';

const fmtTime = (ts: number, zh: boolean): string => {
  try {
    return new Date(ts).toLocaleString(zh ? 'zh-CN' : 'en-US', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch { return String(ts); }
};

/* 'slow' = 连得上、请求成功, 只是慢 (providerHealthCheck: HTTP 2xx 且 latency >= 3000ms)。
 *
 * 这跟 'warn' 必须分开。老实现把 poor 归进 warn → 徽章显示「警告」+ 琥珀色,
 * 还计进首屏「异常告警」计数 —— 一个 3312ms / 成功率 100% 的服务商被标成警告,
 * 用户第一反应是"这个不能用了"。而它明明完全可用, 只是慢。
 * (旧 UI 本来就是对的: i18n 里一直有 health.slow「较慢」, 是新页面归错了类。) */
type StatusKind = 'ok' | 'slow' | 'warn' | 'err' | 'idle';

const statusKindOf = (cur?: string): StatusKind => {
  if (cur === 'excellent' || cur === 'good') return 'ok';
  if (cur === 'poor') return 'slow';
  if (cur === 'offline' || cur === 'error') return 'err';
  return 'idle';
};

/** 是否算「可用」—— 慢也算可用, 只有真连不上才不算。 */
const isUsableKind = (k: StatusKind): boolean => k === 'ok' || k === 'slow';

export const resolveHealthKind = (
  cur: string | undefined,
  opts?: { skipped?: boolean },
): StatusKind => (opts?.skipped ? 'idle' : statusKindOf(cur));

const statusLabel = (cur: string | undefined, zh: boolean): string => {
  if (cur === 'testing') return zh ? '检测中' : 'Testing';
  const k = statusKindOf(cur);
  if (k === 'ok')   return zh ? '健康' : 'Healthy';
  if (k === 'slow') return zh ? '较慢' : 'Slow';
  if (k === 'warn') return zh ? '警告' : 'Warning';
  if (k === 'err')  return zh ? '错误' : 'Error';
  return zh ? '未检测' : 'Not checked';
};

const providerRowBrand = (provider: { id: string; name: string; baseUrl?: string; models?: unknown[] }): ProviderBrand => {
  const byName = inferProviderBrand({ name: provider.name, id: provider.id });
  if (byName !== 'generic') return byName;
  const host = provider.baseUrl ? hostOf(provider.baseUrl).split('/')[0] : '';
  if (host) {
    const byHost = inferProviderBrand({ name: host });
    if (byHost !== 'generic') return byHost;
  }
  /* 网关自己的牌子: 服务商行才有意义 (模型图标那边不认, 见 inferProviderBrand 结尾) */
  const hay = `${provider.name} ${provider.id} ${host}`.toLowerCase();
  if (hay.includes('openrouter')) return 'openrouter';
  if (/(^|[^a-z])opencode($|[^a-z])/.test(hay)) return 'opencode';
  const models = (provider.models ?? [])
    .map((m) => (typeof m === 'string' ? m : (m as { name?: string; id?: string })?.name ?? (m as { id?: string })?.id ?? ''))
    .filter(Boolean);
  const counts = new Map<ProviderBrand, number>();
  for (const m of models) {
    const b = inferProviderBrand({ id: m });
    if (b !== 'generic') counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  let top: ProviderBrand = 'generic';
  let topN = 0;
  for (const [b, n] of counts) if (n > topN) { top = b; topN = n; }
  return topN * 2 >= models.length && topN > 0 ? top : 'generic';
};

/** 认不出厂牌时的通用图标: 一个接口插头, 跟品牌图标同尺寸, 不用字母 */
const GenericApiIcon: React.FC = () => (
  <span className="pv-row__glyph pv-row__glyph--api">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 3v4M15 3v4" />
      <path d="M6 7h12v4a6 6 0 0 1-12 0V7Z" />
      <path d="M12 17v4" />
    </svg>
  </span>
);

/* ── UI 3.0 列表行的小工具 ── */
const isTestingRow = (h: AnyHealth): boolean => h.current === 'testing';

const protocolName = (protocol?: string): string => {
  const p = (protocol || '').toLowerCase();
  const known: Record<string, string> = {
    openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', glm: 'GLM', kimi: 'Kimi',
    deepseek: 'DeepSeek', doubao: 'Doubao', qwen: 'Qwen', 'openai-images': 'OpenAI Images',
  };
  return known[p] ?? (p ? p.charAt(0).toUpperCase() + p.slice(1) : '—');
};

const hostOf = (url: string): string => url.replace(/^https?:\/\//, '').replace(/\/+$/, '');

/** Key 打码: 留前 3 后 4, 中间圆点 */
const maskKey = (key?: string): string => {
  const k = (key || '').trim();
  if (!k) return '—';
  if (k.length <= 8) return '••••••••';
  return `${k.slice(0, 3)}••••••••${k.slice(-4)}`;
};

/** 状态列的小字形: 健康 ✓ / 较慢 ! / 出错 × / 检测中 转圈 / 未检测 ? */
const StatusGlyph: React.FC<{ kind: StatusKind | 'testing' }> = ({ kind }) => (
  <svg className="pv-glyph" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {kind === 'testing'
      ? <path d="M8 2a6 6 0 1 0 6 6" />
      : <circle cx="8" cy="8" r="6" />}
    {kind === 'ok' && <path d="m5.5 8.2 1.7 1.7 3.3-3.6" />}
    {(kind === 'slow' || kind === 'warn') && <><path d="M8 5v3.5" /><path d="M8 11h.01" /></>}
    {kind === 'err' && <path d="m6 6 4 4m0-4-4 4" />}
    {kind === 'idle' && <path d="M6.6 6.3a1.5 1.5 0 1 1 1.9 1.5c-.3.1-.5.4-.5.7v.4M8 11h.01" />}
  </svg>
);

/* 6 小时窗口成功率 (仅 excellent/good/poor 算可用). */
const computeAvailability = (history: Array<{ status: string; timestamp: number }>): number | null => {
  if (!history?.length) return null;
  const since = Date.now() - 6 * 60 * 60 * 1000;
  const recent = history.filter(r => r.timestamp > since);
  if (!recent.length) return null;
  const ok = recent.filter(r => r.status === 'excellent' || r.status === 'good' || r.status === 'poor').length;
  return Math.round((ok / recent.length) * 100);
};

const ProvidersTab: React.FC = () => {
  const ctx = useSettingsContext();
  const zh = ctx.language === 'zh';
  const text = (cn: string, en: string) => (zh ? cn : en);
  const {
    providers, loading, healthMap,
    autoHealthCheckEnabled, handleAutoHealthCheckToggle,
    showHealthIntervalPopover, setShowHealthIntervalPopover,
    healthCheckIntervalMinutes, healthPopoverRef,
    formatHealthIntervalLabel, handleHealthIntervalChange,
    resetForm, setShowAddForm,
    openEditModal, handleSetDefault, handleDeleteProvider,
    cancelHealthCheck, checkProviderHealth,
    showAddForm, editingProvider,
    handleDeleteProviders,
  } = ctx;

  const [selecting, setSelecting] = useState(false);
  /* 行内展开 (UI 3.0): 一次只开一行; 换一行时 Key 重新打码 */
  const [expandedId, setExpandedIdRaw] = useState<string | null>(null);
  const [revealKey, setRevealKey] = useState(false);
  const setExpandedId = (id: string | null) => { setExpandedIdRaw(id); setRevealKey(false); };
  const [filter, setFilter] = useState<'all' | 'ok' | 'alert' | 'idle'>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const exitSelecting = () => { setSelecting(false); setSelected(new Set()); };
  const toggleSelected = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') exitSelecting(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selecting]);
  /* 删掉之后列表里没了的 id 不能还算"已选" */
  useEffect(() => {
    if (selected.size === 0) return;
    const alive = new Set((providers as any[]).map((p) => p.id));
    if ([...selected].some((id) => !alive.has(id))) {
      setSelected(new Set([...selected].filter((id) => alive.has(id))));
    }
  }, [providers]);

  /* 状态弹窗 — 点卡片状态徽章展开最近探测结果 (成功/失败都显示) */
  const [errorDetailId, setErrorDetailId] = useState<string | null>(null);
  /** 诊断弹窗里用户指定的探测模型; 打开弹窗时按 provider 默认模型初始化 */
  const [probeModelById, setProbeModelById] = useState<Record<string, string>>({});

  /* 卡片 ⋯ 菜单 — 一次只开一个 */
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const menuAnchorRef = useRef<HTMLDivElement | null>(null);
  const menuPortalRef = useRef<HTMLDivElement | null>(null);
  const healthPrefsVersion = useProviderHealthPrefsVersion();

  const closeMenu = () => {
    setMenuOpenId(null);
    setMenuPos(null);
  };
  useEffect(() => {
    if (!menuOpenId) return;
    const onDocPointerDown = (e: PointerEvent) => {
      const anchor = menuAnchorRef.current;
      const menu = menuPortalRef.current;
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      const target = e.target as Node;
      const inAnchor = !!anchor && (anchor.contains(target) || path.includes(anchor));
      const inMenu = !!menu && (menu.contains(target) || path.includes(menu));
      if (!inAnchor && !inMenu) closeMenu();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [menuOpenId]);
  useEffect(() => {
    if (!menuOpenId) return;
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    return () => {
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
    };
  }, [menuOpenId]);

  /* 状态弹窗 Esc 关闭 */
  useEffect(() => {
    if (!errorDetailId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setErrorDetailId(null); };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [errorDetailId]);

  /* BYOK 列表只列用户自己加的第三方服务商 — Neox Cloud 是订阅网关 (OAuth 登录访问, 非 API+key),
   * 它只是内部路由用的 provider 框架, 绝不能出现在 BYOK 管理页 (更不该被当 BYOK 健康检测)。 */
  const byokProviders = useMemo(
    () => (providers as any[]).filter(p => p.id !== NEOX_CLOUD_PROVIDER_ID),
    [providers],
  );

  /* 统计 */
  const stats = useMemo(() => {
    let healthy = 0, warned = 0, error = 0;
    for (const p of byokProviders) {
      if (isProviderHealthCheckSkipped(p.id)) continue;
      const h: AnyHealth | undefined = healthMap[p.id];
      const k = resolveHealthKind(h?.current);
      /* 慢 = 可用, 计进「健康可用」而不是「异常告警」 */
      if (isUsableKind(k)) healthy++;
      else if (k === 'warn') warned++;
      else if (k === 'err')  error++;
    }
    return { total: byokProviders.length, healthy, alert: warned + error };
  }, [byokProviders, healthMap, healthPrefsVersion]);

  /* 编辑/添加 mode — 向导内自带 OAuth / API Key 二分入口 */
  if (showAddForm || editingProvider) {
    return <ProviderEditForm />;
  }

  const kindOf = (p: any): StatusKind => resolveHealthKind(healthMap[p.id]?.current, { skipped: isProviderHealthCheckSkipped(p.id) });
  const q = query.trim().toLowerCase();
  const visible = byokProviders.filter((p: any) => {
    const k = kindOf(p);
    if (filter === 'ok' && !isUsableKind(k)) return false;
    if (filter === 'alert' && !(k === 'warn' || k === 'err')) return false;
    if (filter === 'idle' && k !== 'idle') return false;
    if (!q) return true;
    return String(p.name ?? '').toLowerCase().includes(q)
      || String(p.baseUrl ?? '').toLowerCase().includes(q)
      || (p.models ?? []).some((m: any) => String(m?.name ?? '').toLowerCase().includes(q));
  });
  const idleCount = byokProviders.filter((p: any) => kindOf(p) === 'idle').length;

  return (
    <div className="settings-content apiv2">
      {/* UI 3.0 稿 (set-prov3): 页头 = 陶土图标 + 标题 + 一句概况, 右边只有「添加服务商」和「⋯」;
        *   自动测速 / 检测频率 / 多选 / 用量与余额收进「⋯」, 不占版面。 */}
      <header className="pv-head">
        <PageTitle
          title={text('API 服务商', 'API Providers')}
          subtitle={byokProviders.length > 0
            ? text(`用你自己的 Key 接模型 · ${stats.total} 个，${stats.healthy} 个可用`, `Bring your own keys · ${stats.total} providers, ${stats.healthy} healthy`)
            : text('不加也能用 Neox 网关；加了优先走你的额度', 'Neox gateway works without one; with one, your quota is used first')}
        />
        <div className="pv-head__actions">
          {selecting ? (
            <>
              <button
                type="button"
                className="apiv2__chip"
                onClick={() => setSelected(selected.size === byokProviders.length ? new Set() : new Set(byokProviders.map((p: any) => p.id)))}
              >
                <span>{selected.size === byokProviders.length ? text('取消全选', 'Select none') : text('全选', 'Select all')}</span>
              </button>
              <button type="button" className="apiv2__btn apiv2__btn--primary" onClick={exitSelecting}>
                <span>{text('完成', 'Done')}</span>
              </button>
            </>
          ) : (
          <>
          <button
            type="button"
            className="pv-head__add"
            onClick={() => { resetForm(); setShowAddForm(true); }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 5v14M5 12h14"/></svg>
            <span>{text('添加服务商', 'Add Provider')}</span>
          </button>
          {/* 「⋯」复用原检测频率弹层的开关 / 外点关闭 (SettingsPage 里的 healthPopoverRef) */}
          <div className="pv-head__more" ref={healthPopoverRef}>
            <button
              type="button"
              className="pv-head__more-btn"
              onClick={() => setShowHealthIntervalPopover((v: boolean) => !v)}
              aria-label={text('更多', 'More')}
              aria-haspopup="menu"
              aria-expanded={showHealthIntervalPopover}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/>
              </svg>
            </button>
            {showHealthIntervalPopover && (
              <div className="apiv2__popover pv-head__menu" role="menu">
                {/* 这是个开关, 不是"点我测一次"的动作 —— 文案说状态 (老文案「手动测速」被读成动作按钮) */}
                <button type="button" role="menuitemcheckbox" aria-checked={autoHealthCheckEnabled}
                  className="apiv2__popover-opt" onClick={handleAutoHealthCheckToggle}>
                  <span>{text('自动测速', 'Auto health checks')}</span>
                  <span className={`pv-head__switch${autoHealthCheckEnabled ? ' is-on' : ''}`} aria-hidden />
                </button>
                {/* 自动测速关着时频率不生效 —— 灰掉, 别向用户承诺没发生的事 */}
                <div className={`apiv2__popover-title${autoHealthCheckEnabled ? '' : ' is-muted'}`}>{text('检测频率', 'Check interval')}</div>
                <div className="apiv2__popover-opts">
                  {[5, 10, 30, 60, 180].map((m: number) => (
                    <button
                      key={m}
                      type="button"
                      role="menuitemradio"
                      aria-checked={healthCheckIntervalMinutes === m}
                      className={`apiv2__popover-opt${healthCheckIntervalMinutes === m ? ' is-on' : ''}`}
                      onClick={() => handleHealthIntervalChange(m)}
                      disabled={!autoHealthCheckEnabled}
                    >
                      <span>{formatHealthIntervalLabel(m)}</span>
                      {healthCheckIntervalMinutes === m && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m5 12 5 5L20 7"/></svg>
                      )}
                    </button>
                  ))}
                </div>
                <div className="apiv2__popover-sep" />
                <button type="button" role="menuitem" className="apiv2__popover-opt" onClick={() => {
                  setShowHealthIntervalPopover(false);
                  for (const p of byokProviders) if (!isProviderHealthCheckSkipped(p.id)) void checkProviderHealth(p);
                }}>
                  {text('全部检测一次', 'Check all now')}
                </button>
                {byokProviders.length > 1 && (
                  <button type="button" role="menuitem" className="apiv2__popover-opt"
                    onClick={() => { setShowHealthIntervalPopover(false); closeMenu(); setSelecting(true); }}>
                    {text('多选管理…', 'Select several…')}
                  </button>
                )}
                <button type="button" role="menuitem" className="apiv2__popover-opt"
                  onClick={() => { setShowHealthIntervalPopover(false); ctx.setUsageSource?.('local'); ctx.setActiveTab?.('usage'); }}>
                  {text('用量与余额 →', 'Usage & balances →')}
                </button>
              </div>
            )}
          </div>
          </>
          )}
        </div>
      </header>


      {byokProviders.length > 3 && (
        <div className="pv-toolbar">
          <Segmented
            value={filter}
            onChange={(v) => setFilter(v as typeof filter)}
            options={[
              { value: 'all', label: text(`全部 ${stats.total}`, `All ${stats.total}`) },
              { value: 'ok', label: text(`可用 ${stats.healthy}`, `Healthy ${stats.healthy}`) },
              { value: 'alert', label: text(`异常 ${stats.alert}`, `Failing ${stats.alert}`) },
              { value: 'idle', label: text(`未检测 ${idleCount}`, `Unchecked ${idleCount}`) },
            ]}
          />
          <div className="skills-toolbar__search pv-toolbar__search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input className="nx-bare-input" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder={text('搜名字、地址或模型', 'Search name, URL or model')} aria-label={text('搜索服务商', 'Search providers')} />
          </div>
        </div>
      )}

      {/* ---------- 卡片列表 ---------- */}
      {loading ? (
        <div className="apiv2__empty neox-text-shimmer">{text('加载中…', 'Loading...')}</div>
      ) : byokProviders.length === 0 ? (
        <div className="apiv2__empty">
          <img className="nx-illus" src={NeoxIllus.routing} alt="" aria-hidden draggable={false} />
          <h3>{text('还没有自定义服务商', 'No custom providers yet')}</h3>
          <p>{text('接入你自己的 API Key,该服务商会优先用你的额度;不加也能正常用 Neox 网关。', 'Connect your own API key to use your quota first. Without one, Neox gateway still works.')}</p>
          <button
            type="button"
            className="apiv2__btn apiv2__btn--primary"
            onClick={() => { resetForm(); setShowAddForm(true); }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 5v14M5 12h14"/></svg>
            <span>{text('添加服务商', 'Add Provider')}</span>
          </button>
        </div>
      ) : visible.length === 0 ? (
        <div className="pv-none">{text('没有符合条件的服务商', 'No providers match')}</div>
      ) : (
        <section className={`pv-list${selecting ? ' is-selecting' : ''}`}>
          {visible.map((provider: any) => {
            const health: AnyHealth = healthMap[provider.id] || { history: [] };
            const healthCheckSkipped = isProviderHealthCheckSkipped(provider.id);
            const kind = resolveHealthKind(health.current, { skipped: healthCheckSkipped });
            const availability = healthCheckSkipped ? null : computeAvailability(health.history || []);
            /* 状态列文字: 健康写延迟, 较慢写延迟 + 较慢, 出错写一句原因, 没测写未检测 */
            const latestRec = (health.history || [])[(health.history || []).length - 1];
            const errShort = latestRec?.httpStatus === 401 || latestRec?.httpStatus === 403
              ? text('Key 无效', 'Bad key')
              : statusLabel(health.current, zh);
            const statusText = healthCheckSkipped ? text('不测速', 'Skipped')
              : isTestingRow(health) ? text('检测中', 'Testing')
              : kind === 'ok' ? `${health.latency ?? '—'} ms${availability != null && availability < 100 ? ` · ${availability}%` : ''}`
              : kind === 'slow' ? text(`${health.latency ?? '—'} ms 较慢`, `${health.latency ?? '—'} ms slow`)
              : kind === 'err' ? errShort
              : statusLabel(health.current, zh);
            const lastError = kind === 'err' && latestRec
              ? [latestRec.httpStatus, httpStatusHint(latestRec.httpStatus, zh) || latestRec.error].filter(Boolean).join(' · ')
              : '';
            const isOpen = expandedId === provider.id;
            const brand = providerRowBrand(provider);
            const isMenuOpen = menuOpenId === provider.id;
            const isTesting = !healthCheckSkipped && health.current === 'testing';

            return (
              <React.Fragment key={provider.id}>
              <article
                className={`pv-row pv-row--${kind}${isTesting ? ' is-testing' : ''}${healthCheckSkipped ? ' is-health-skipped' : ''}${isOpen ? ' is-open' : ''}${selecting && selected.has(provider.id) ? ' is-selected' : ''}`}
              >
                <div
                  className="pv-row__line"
                  role="button"
                  tabIndex={0}
                  aria-expanded={selecting ? undefined : isOpen}
                  onClick={() => (selecting ? toggleSelected(provider.id) : setExpandedId(isOpen ? null : provider.id))}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (selecting) toggleSelected(provider.id); else setExpandedId(isOpen ? null : provider.id); } }}
                >
                  {selecting && (
                    <span className="apiv2__card-check pv-row__check" aria-hidden>
                      {selected.has(provider.id) && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5L20 7" /></svg>
                      )}
                    </span>
                  )}
                  <span className={`pv-row__icon apiv2__card-icon--${brand}`} aria-hidden>
                    {brand === 'generic' ? (
                      <GenericApiIcon />
                    ) : (
                      <ProviderBrandIcon brand={brand} size={22} />
                    )}
                  </span>
                  <span className="pv-row__main">
                    <span className="pv-row__name">
                      <span className="pv-name" title={provider.name}>{provider.name}</span>
                      <ProviderPinTag providerId={provider.id} zh={zh} />
                    </span>
                    <span className="pv-row__sub">
                      {protocolName(provider.protocol)} {text('协议', 'protocol')} · {provider.models.length} {zh ? '个模型' : `model${provider.models.length === 1 ? '' : 's'}`}
                      {provider.baseUrl ? <> · <span className="pv-row__host">{hostOf(provider.baseUrl)}</span></> : null}
                    </span>
                  </span>
                  {/* 状态: 小字形 + 文字, 不用色块签; 点它看探测诊断 */}
                  <button
                    type="button"
                    className={`pv-row__status is-${isTesting ? 'testing' : kind}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (isTesting) return;
                      const models = (provider.models || []).map((m: any) => m?.name).filter(Boolean) as string[];
                      const preferred = models.find((n) => !/image|dall-?e|imagen|gpt-image|imagine|flux|sdxl/i.test(n))
                        || provider.defaultModel
                        || provider.lastSelectedModel
                        || models[0]
                        || '';
                      setProbeModelById((prev) => ({ ...prev, [provider.id]: prev[provider.id] || preferred }));
                      setErrorDetailId(provider.id);
                    }}
                    title={text('查看探测诊断', 'View probe diagnostics')}
                  >
                    <StatusGlyph kind={isTesting ? 'testing' : kind} />
                    <span>{statusText}</span>
                  </button>
                  <svg className="pv-row__chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d={isOpen ? 'm6 9 6 6 6-6' : 'm9 6 6 6-6 6'} />
                  </svg>
                </div>

                {isOpen && !selecting && (
                  <div className="pv-row__panel">
                    <div className="pv-row__fields">
                      <label className="pv-field">
                        <span className="pv-field__label">API Key</span>
                        <span className="pv-field__box">
                          <span className="pv-field__val">{revealKey ? (provider.apiKey || '—') : maskKey(provider.apiKey)}</span>
                          {provider.apiKey ? (
                            <button type="button" className="pv-field__eye" onClick={() => setRevealKey((v) => !v)}
                              aria-label={revealKey ? text('隐藏', 'Hide') : text('显示', 'Show')}>
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" />
                                {revealKey && <path d="M4 20 20 4" />}
                              </svg>
                            </button>
                          ) : null}
                        </span>
                      </label>
                      <label className="pv-field">
                        <span className="pv-field__label">Base URL</span>
                        <span className="pv-field__box"><span className="pv-field__val">{provider.baseUrl || text('默认地址', 'Default')}</span></span>
                      </label>
                    </div>
                    <div className="pv-row__foot">
                      <div className="pv-row__models">
                        {provider.models.slice(0, 2).map((m: any) => (
                          <span key={m.name} className="apiv2__chip-model">{m.name}</span>
                        ))}
                        {provider.models.length > 2 && <span className="apiv2__chip-model is-more">+{provider.models.length - 2}</span>}
                      </div>
                      <div className="pv-row__acts">
                        {isTesting ? (
                          <button type="button" className="pv-btn" onClick={() => cancelHealthCheck(provider.id)}>{text('停止检测', 'Stop')}</button>
                        ) : (
                          <button type="button" className="pv-btn" onClick={() => {
                            if (healthCheckSkipped) setProviderHealthCheckSkipped(provider.id, false);
                            void checkProviderHealth(provider);
                          }}>{text('测试连接', 'Test connection')}</button>
                        )}
                        <button type="button" className="pv-btn pv-btn--text" onClick={() => openEditModal(provider)}>{text('编辑', 'Edit')}</button>
                        <div className="pv-row__menu" ref={isMenuOpen ? menuAnchorRef : undefined}>
                          <button
                            type="button"
                            className="pv-btn pv-btn--text"
                            onClick={(e) => {
                              if (isMenuOpen) { closeMenu(); return; }
                              const rect = e.currentTarget.getBoundingClientRect();
                              setMenuPos({
                                top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 260)),
                                right: Math.max(8, window.innerWidth - rect.right),
                              });
                              setMenuOpenId(provider.id);
                            }}
                            aria-haspopup="menu"
                            aria-expanded={isMenuOpen}
                          >{text('更多', 'More')}</button>
                        </div>
                        <button type="button" className="pv-btn pv-btn--text pv-btn--danger" onClick={(ev) => handleDeleteProvider(provider.id, ev)}>{text('删除', 'Delete')}</button>
                      </div>
                    </div>
                    {lastError && <div className="pv-row__err">{text('上次检测：', 'Last check: ')}{lastError}</div>}
                  </div>
                )}
              </article>
              {isMenuOpen && menuPos && createPortal(
                <div
                  ref={menuPortalRef}
                  className="apiv2__popover apiv2__popover--menu is-portaled"
                  style={{ top: menuPos.top, right: menuPos.right }}
                  role="menu"
                  onClick={(e) => e.stopPropagation()}
                >
                  {healthCheckSkipped ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="apiv2__popover-opt"
                      onClick={(e) => {
                        e.stopPropagation();
                        setProviderHealthCheckSkipped(provider.id, false);
                        closeMenu();
                      }}
                    >
                      {text('恢复测速', 'Resume checks')}
                    </button>
                  ) : isTesting ? (
                    <button type="button" role="menuitem" className="apiv2__popover-opt"
                            onClick={(e) => { e.stopPropagation(); cancelHealthCheck(provider.id); closeMenu(); }}>
                      {text('停止检测', 'Stop check')}
                    </button>
                  ) : (
                    <button type="button" role="menuitem" className="apiv2__popover-opt"
                            onClick={(e) => { e.stopPropagation(); checkProviderHealth(provider); closeMenu(); }}>
                      {text('立即测速', 'Check now')}
                    </button>
                  )}
                  {!healthCheckSkipped && (
                    <button
                      type="button"
                      role="menuitem"
                      className="apiv2__popover-opt"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isTesting) cancelHealthCheck(provider.id);
                        setProviderHealthCheckSkipped(provider.id, true);
                        closeMenu();
                      }}
                    >
                      {text('不用测速', 'Skip checks')}
                    </button>
                  )}
                  <button type="button" role="menuitem" className="apiv2__popover-opt"
                          onClick={(e) => { e.stopPropagation(); openEditModal(provider); closeMenu(); }}>
                    {text('编辑', 'Edit')}
                  </button>
                  <button type="button" role="menuitem" className="apiv2__popover-opt"
                          onClick={(ev) => { ev.stopPropagation(); handleSetDefault(provider.id, ev); closeMenu(); }}>
                    {text('设为默认', 'Set as default')}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="apiv2__popover-opt"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      setByokPinned(provider.id, !isByokPinned(provider.id));
                      closeMenu();
                    }}
                  >
                    {isByokPinned(provider.id) ? text('从 BYOK 菜单隐藏', 'Hide from BYOK menu') : text('显示到 BYOK 菜单', 'Show in BYOK menu')}
                  </button>
                  <button type="button" role="menuitem" className="apiv2__popover-opt is-danger"
                          onClick={(ev) => { ev.stopPropagation(); handleDeleteProvider(provider.id, ev); closeMenu(); }}>
                    {text('删除', 'Delete')}
                  </button>
                </div>,
                document.body,
              )}
              </React.Fragment>
            );
          })}
        </section>
      )}

      {selecting && (() => {
        const ids = [...selected];
        const none = ids.length === 0;
        const bulkBtn = (label: string, onClick: () => void, extra?: string) => (
          <button type="button" className={`apiv2-bulk__btn${extra ? ` ${extra}` : ''}`} disabled={none} onClick={onClick}>{label}</button>
        );
        return (
          <div className="apiv2-bulk" role="toolbar" aria-label={text('批量操作', 'Bulk actions')}>
            <span className="apiv2-bulk__count">
              {none ? text('点卡片来选择', 'Click cards to select') : text(`已选 ${ids.length} 个`, `${ids.length} selected`)}
            </span>
            {bulkBtn(text('显示到菜单', 'Show in menu'), () => ids.forEach((id) => setByokPinned(id, true)))}
            {bulkBtn(text('从菜单隐藏', 'Hide from menu'), () => ids.forEach((id) => setByokPinned(id, false)))}
            <span className="apiv2-bulk__sep" aria-hidden />
            {bulkBtn(text('立即测速', 'Check now'), () => {
              for (const id of ids) {
                const p = byokProviders.find((x: any) => x.id === id);
                if (!p) continue;
                if (isProviderHealthCheckSkipped(id)) setProviderHealthCheckSkipped(id, false);
                void checkProviderHealth(p);
              }
            })}
            {bulkBtn(text('不再测速', 'Skip checks'), () => ids.forEach((id) => {
              if (healthMap[id]?.current === 'testing') cancelHealthCheck(id);
              setProviderHealthCheckSkipped(id, true);
            }))}
            <span className="apiv2-bulk__sep" aria-hidden />
            {bulkBtn(text('删除', 'Delete'), () => {
              void (async () => {
                if (await handleDeleteProviders(ids)) setSelected(new Set());
              })();
            }, 'is-danger')}
          </div>
        );
      })()}

      {errorDetailId && (() => {
        const p = byokProviders.find((x: any) => x.id === errorDetailId);
        const h: AnyHealth | undefined = healthMap[errorDetailId];
        if (!p) return null;
        const isTestingNow = h?.current === 'testing';
        const recent = [...(h?.history || [])].slice(-10).reverse();
        const latest = recent[0];
        const modelOptions = ((p.models || []).map((m: any) => m?.name).filter(Boolean) as string[]);
        const selectedModel = probeModelById[p.id]
          || latest?.model
          || p.defaultModel
          || p.lastSelectedModel
          || modelOptions[0]
          || '';
        const latestHint = httpStatusHint(latest?.httpStatus, zh);
        const latestKind = statusKindOf(latest?.status);
        const latestHeadline = latest
          ? (latestKind === 'ok'
              ? text(`连通正常 · ${latest.latency}ms`, `Healthy · ${latest.latency}ms`)
              : latestKind === 'slow'
                ? text(`连通正常 · 偏慢 ${latest.latency}ms`, `Healthy but slow · ${latest.latency}ms`)
                : (latestHint || statusLabel(latest.status, zh)))
          : null;
        const latestDetail = latest?.error
          || (latest && latestKind === 'ok'
                ? text('探测成功，服务商可正常响应。', 'Probe succeeded — provider responded normally.')
                : latest && latest.status === 'poor' && !latest.error
                  ? text('连接正常但响应偏慢。', 'Reachable but slow.')
                  : null);

        return createPortal(
          <div className="apiv2-errm__overlay" onClick={() => setErrorDetailId(null)}>
            <div className="apiv2-errm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
              <header className="apiv2-errm__head">
                <div className="apiv2-errm__title">
                  <span className={`apiv2__pill-dot apiv2-errm__dot--${statusKindOf(h?.current)}`} />
                  <div>
                    <h3>{p.name}</h3>
                    <p>{text('最近探测诊断', 'Recent probe diagnostics')}</p>
                  </div>
                </div>
                <button type="button" className="apiv2-errm__close" onClick={() => setErrorDetailId(null)} aria-label={text('关闭', 'Close')}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </header>

              <div className="apiv2-errm__model">
                <label htmlFor={`probe-model-${p.id}`}>{text('测试模型', 'Probe model')}</label>
                {modelOptions.length > 0 ? (
                  /* 走项目自己的 CustomSelect (portal + 搜索), 不用原生 <select> —
                   * 原生下拉是 OS 渲染的, 在暗色玻璃弹窗上是一块突兀的系统白底菜单,
                   * 而且模型多到二三十条时没有搜索。设置页其它 tab 早就统一了, 这处是漏网。 */
                  <CustomSelect
                    id={`probe-model-${p.id}`}
                    className="apiv2-errm__model-select"
                    value={selectedModel}
                    disabled={isTestingNow}
                    options={modelOptions.map((name) => ({ value: name, label: name }))}
                    onChange={(next) => setProbeModelById((prev) => ({ ...prev, [p.id]: next }))}
                  />
                ) : (
                  <input
                    id={`probe-model-${p.id}`}
                    type="text"
                    value={selectedModel}
                    disabled={isTestingNow}
                    placeholder={text('输入模型 ID', 'Model id')}
                    onChange={(e) => setProbeModelById((prev) => ({ ...prev, [p.id]: e.target.value }))}
                  />
                )}
              </div>

              {isTestingNow ? (
                <div className="apiv2-errm__empty apiv2-errm__empty--testing">
                  {text(`正在用 ${selectedModel || '…'} 探测…`, `Probing with ${selectedModel || '…'}…`)}
                </div>
              ) : latest ? (
                <div className={`apiv2-errm__summary apiv2-errm__summary--${latestKind}`}>
                  {latestHeadline && <div className="apiv2-errm__diag">{latestHeadline}</div>}
                  {latestDetail && <div className="apiv2-errm__raw">{latestDetail}</div>}
                  {latest.model && (
                    <div className="apiv2-errm__meta">{text('模型', 'Model')}: {latest.model}</div>
                  )}
                  <div className="apiv2-errm__endpoint" title={p.baseUrl || ''}>{p.baseUrl || '—'}</div>
                  <div className="apiv2-errm__meta">{fmtTime(latest.timestamp, zh)}</div>
                </div>
              ) : (
                <div className="apiv2-errm__empty">
                  {text('还没有探测记录。选好模型后点「重新测速」。', 'No probe records yet. Pick a model and hit Re-check.')}
                </div>
              )}

              {recent.length > 1 && (
                <div className="apiv2-errm__list">
                  <div className="apiv2-errm__list-label">{text('历史记录', 'History')}</div>
                  {recent.slice(1).map((r, i) => (
                    <div key={r.timestamp + '-' + i} className="apiv2-errm__row">
                      <span className={`apiv2-errm__row-badge apiv2-errm__row-badge--${statusKindOf(r.status)}`}>
                        {r.httpStatus ? r.httpStatus : statusLabel(r.status, zh)}
                      </span>
                      <span className="apiv2-errm__row-msg" title={r.error || r.model || ''}>
                        {r.error
                          || httpStatusHint(r.httpStatus, zh)
                          || (r.model ? `${statusLabel(r.status, zh)} · ${r.model}` : statusLabel(r.status, zh))}
                      </span>
                      <span className="apiv2-errm__row-time">{fmtTime(r.timestamp, zh)}</span>
                    </div>
                  ))}
                </div>
              )}

              <footer className="apiv2-errm__foot">
                <button
                  type="button"
                  className="apiv2-errm__btn"
                  disabled={isTestingNow || !selectedModel}
                  onClick={() => {
                    void checkProviderHealth(p, { model: selectedModel });
                  }}
                >
                  {isTestingNow ? text('探测中…', 'Probing…') : text('重新测速', 'Re-check')}
                </button>
                <button type="button" className="apiv2-errm__btn apiv2-errm__btn--primary" onClick={() => { openEditModal(p); setErrorDetailId(null); }}>
                  {text('去编辑配置', 'Edit config')}
                </button>
              </footer>
            </div>
          </div>,
          document.body,
        );
      })()}

      {/* Neox 默认可用模型 catalog 已从 BYOK 页移除 — 跟自带 Key 无关, 属于账户/订阅范畴 */}

    </div>
  );
};

const ProviderPinTag: React.FC<{ providerId: string; zh: boolean }> = ({ providerId, zh }) => {
  const pinned = useByokPinned(providerId);
  const text = (cn: string, en: string) => (zh ? cn : en);
  if (pinned) return null;
  return (
    <button
      type="button"
      className="apiv2__pin-tag apiv2__pin-tag--toggle"
      onClick={(e) => {
        e.stopPropagation();
        setByokPinned(providerId, true);
      }}
      title={text('点击显示到 BYOK 菜单', 'Click to show in the BYOK menu.')}
    >
      <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M9 2 6 4l-3 1 3 3-1 5 4-3 4 3-1-5 3-3-3-1-3-2Z" />
      </svg>
      <span>{text('已从菜单隐藏', 'Hidden from menu')}</span>
    </button>
  );
};

export default ProvidersTab;
