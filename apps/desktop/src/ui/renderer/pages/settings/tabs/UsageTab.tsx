/** 百分比"占的是哪个额度" —— 给"占 X 额度"这类短语用.
 *
 *   只看 quotaMode, **不要拿 activeUsageWindows()[0]**: window 档下它返回
 *   [5h, weekly] 两条, 取第一条会得出"占 5 小时额度", 把本来正确的"本周"改坏
 *   (写这个函数时就踩了一次, 被单测拦下)。服务端那个字段叫 percentOfWeekly,
 *   window 档下口径就是周额度; 月额度档才换成本月。
 *   跟 AccountOverviewTab.ledgerCostLabel 的 monthly 开关同源。
 *
 *   不复用 windowLabelOf: 那个给的是展示名 ("本月"/"This month"), 中文拼
 *   "占本月额度" 没问题, 英文 "% of This month quota" 就不像话了。 */

import React from 'react';
import { useSettingsContext } from '../SettingsContext';
import { useI18n } from '../../../hooks/useI18n';
import Icons from '../../../components/Icons';
import UsageTrendChart, { type DailyUsagePoint } from './UsageTrendChart';
import { UsageShareCard, type UsageShareData } from './UsageShareCard';
import { customRange, presetRange, rangeLabel, type UsageRange } from './usageRange';
import { PageTitle } from '../../../components/settings-base';
import { UiSlot } from '../../../modules/shell/uiSlots';
import { formatTokenCount } from './usageFormat';
import { ByokBalancePanel } from './ByokBalancePanel';
import { ProviderBrandIcon, inferProviderBrand } from '../../../modules/agent-timeline/ProviderBrandIcon';
import './UsageByok.css';

/** 轮耗时的人话化 —— ms 原样打出来会出现 393779ms 这种没人读得懂的数字。 */
function formatTurnDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return sec ? `${m}分${sec}秒` : `${m}分`;
}


// --- helpers (copied from SettingsPage, pure / language-only deps) ---

const formatTime = (timestamp: number, language: string): string => {
  if (!timestamp) return '-';
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - timestamp;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return language === 'zh' ? '刚刚' : 'Just now';
  if (diffMins < 60) return language === 'zh' ? `${diffMins} 分钟前` : `${diffMins}m ago`;
  if (diffHours < 24) return language === 'zh' ? `${diffHours} 小时前` : `${diffHours}h ago`;
  if (diffDays < 7) return language === 'zh' ? `${diffDays} 天前` : `${diffDays}d ago`;
  return date.toLocaleDateString();
};

/* 行式分布 —— 「按服务商」「按模型」「详情里的模型分布」共用一个版式:
 *   [品牌标 20] [名字] [细条 240] [占比 56 右对齐] [token 92 右对齐]。
 *   认不出品牌的给首字母圆标, 跟余额卡的行保持一致。 */
const DistRow: React.FC<{ name: string; percent: number; tokens: number }> = ({ name, percent, tokens }) => {
  const brand = inferProviderBrand({ name });
  const clamped = Math.min(100, Math.max(0, percent || 0));
  const pctText = clamped >= 10 ? clamped.toFixed(0) : clamped.toFixed(1);
  return (
    <div className="byok3-drow">
      <span className="byok3-drow__logo" aria-hidden="true">
        {brand !== 'generic'
          ? <ProviderBrandIcon brand={brand} size={20} />
          : <span className="byok3-drow__initial">{(name || '?').trim().charAt(0).toUpperCase()}</span>}
      </span>
      <span className="byok3-drow__name" title={name}>{name}</span>
      <span className="byok3-drow__bar" aria-hidden="true">
        <span className="byok3-drow__fill" style={{ width: `${clamped}%` }} />
      </span>
      <span className="byok3-drow__pct">{pctText}%</span>
      <span className="byok3-drow__tok">{formatTokenCount(tokens)}</span>
    </div>
  );
};

// --- RateLimitUsagePanel (was at bottom of SettingsPage.tsx) ---

const RateLimitUsagePanel: React.FC<{ language: string }> = ({ language }) => {
  const [usage, setUsage] = React.useState<Array<{
    windowId: string;
    label: string;
    requests: number;
    tokens: number;
    maxRequests: number;
    maxTokens: number;
  }>>([]);

  React.useEffect(() => {
    // getRateLimitUsage is on window.neox (preload.cjs:754), not window.api.
    const api = (window as any).neox;
    if (api?.getRateLimitUsage) {
      api.getRateLimitUsage().then((data: any) => {
        if (Array.isArray(data)) setUsage(data);
      }).catch(() => {});
    }
  }, []);

  const hasUsage = usage.some(u => u.requests > 0);
  if (!hasUsage) return null;

  const formatK = (n: number): string => {
    if (n >= 1000000) {
      const value = n / 1000000;
      const nearest = Math.round(value);
      if (nearest >= 1 && Math.abs(value - nearest) <= 0.11) return `${nearest}M`;
      const formatted = value >= 10 ? `${Math.round(value)}` : value.toFixed(1).replace(/\.0$/, '');
      return `${formatted}M`;
    }
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  };

  return (
    <div className="byok3-card byok3-limit">
      <div className="byok3-card__head">
        <span className="byok3-card__title">{language === 'zh' ? '用量窗口' : 'Rate Limit Windows'}</span>
      </div>
      <div className="usg-limit-grid">
        {usage.filter(u => u.requests > 0).map(u => {
          const pct = u.maxRequests > 0
            ? Math.min(100, Math.round((u.requests / u.maxRequests) * 100))
            : -1;
          const tone = pct >= 80 ? 'danger' : pct >= 50 ? 'warn' : 'ok';
          return (
            <div key={u.windowId} className="usg-limit-card">
              <div className="usg-limit-card__top">
                <span className="usg-limit-requests">{u.requests}</span>
                {pct >= 0 && <span className={`usg-limit-pct ${tone}`}>{pct}%</span>}
              </div>
              <span className="usg-limit-label">{language === 'zh' ? `${u.label} 请求` : `${u.label} requests`}</span>
              <span className="usg-limit-tokens">{formatK(u.tokens)} tokens</span>
              {pct >= 0 && (
                <div className="usg-limit-meter" aria-hidden>
                  <div className={`usg-limit-meter__fill ${tone}`} style={{ width: `${pct}%` }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

/* --- 订阅用量面板 ---
 *   订阅数据源下的额度面板在发行版 (billing/UsageSubscriptionPanel), 经
 *   'settings.usage.subscription' 插槽挂进来; 公开构建没有这个数据源。 */

const LocalUsageEmpty: React.FC<{
  zh: boolean;
  hasMembership: boolean;
  onGoSubscription: () => void;
}> = ({ zh, hasMembership, onGoSubscription }) => {
  const { setActiveTab } = useSettingsContext();
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      textAlign: 'center', padding: '52px 24px', gap: 4,
    }}>
      {/* 空图表的样子 —— 坐标轴还在, 只是没有线。比一个通用的"空盒子"更贴题:
          一眼看出"这里本该有一张图" */}
      <svg width="112" height="72" viewBox="0 0 112 72" fill="none" aria-hidden="true" style={{ marginBottom: 12 }}>
        <line x1="10" y1="8" x2="10" y2="58" stroke="currentColor" strokeOpacity="0.16" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="10" y1="58" x2="102" y2="58" stroke="currentColor" strokeOpacity="0.16" strokeWidth="1.5" strokeLinecap="round" />
        {[22, 40, 58, 76, 94].map(x => (
          <line key={x} x1={x} y1="58" x2={x} y2="61" stroke="currentColor" strokeOpacity="0.1" strokeWidth="1.5" strokeLinecap="round" />
        ))}
        {/* 虚线 = "还没有数据的那条线" */}
        <path
          d="M14 46 C 30 44, 40 40, 52 41 S 76 36, 98 30"
          stroke="currentColor" strokeOpacity="0.2" strokeWidth="2"
          strokeLinecap="round" strokeDasharray="3 5" fill="none"
        />
        <circle cx="98" cy="30" r="3" fill="currentColor" fillOpacity="0.18" />
      </svg>

      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--neox-fg-primary)' }}>
        {hasMembership
          ? (zh ? '本地还没有请求记录' : 'No local requests yet')
          : (zh ? '还没有用量数据' : 'No usage data yet')}
      </div>

      <div style={{ fontSize: 12.5, lineHeight: 1.7, color: 'var(--neox-fg-secondary)', maxWidth: 380, marginTop: 2 }}>
        {hasMembership
          ? (zh
            ? '这里只统计走你自己 API Key（BYOK）的请求。你现在用的是云端订阅，那部分用量在「订阅用量」里。'
            : 'This only counts requests made with your own API keys (BYOK). You are on a cloud subscription — that usage lives under "Subscription".')
          : (zh
            ? '配置一个 API 服务商并发起对话后，这里会记录每次请求的 token、耗时和首响，并按天画出趋势。'
            : 'Add an API provider and start a chat — every request’s tokens, latency and TTFT get recorded here and charted by day.')}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        {hasMembership ? (
          <button type="button" className="sfc-svc-btn sfc-svc-btn--primary" onClick={onGoSubscription}>
            {zh ? '查看订阅用量' : 'View subscription usage'}
          </button>
        ) : (
          <button
            type="button"
            className="sfc-svc-btn sfc-svc-btn--primary"
            onClick={() => setActiveTab?.('providers')}
          >
            {zh ? '去配置 API 服务商' : 'Add an API provider'}
          </button>
        )}
      </div>
    </div>
  );
};

// --- UsageTab ---

const UsageTab: React.FC = () => {
  const { t, language } = useI18n();
  const {
    usageSource, setUsageSource, usageHasMembership,
    usageSummary,
    usageIsCloud,
    cloudUsageError,
    cloudUsageLastSuccessAt,
    usageLoading,
    usageViewMode,
    setUsageViewMode,
    costEstimate,
    providerStats,
    expandedProviders,
    setExpandedProviders,
    selectedProviderRecords,
    setSelectedProviderRecords,
    showPricingConfig,
    setShowPricingConfig,
    newPricing,
    setNewPricing,
    pricingLoading,
    pricingList,
    exportUsageReport,
    clearAllUsageStats,
    loadUsageStats,
    getProviderDistribution,
    getModelDistribution,
    loadProviderRecords,
    clearProviderUsageStats,
    loadPricingConfig,
    savePricing,
    deletePricing,
  } = useSettingsContext();

  /* Esc 关闭 records / pricing 弹层 — 与点击遮罩关闭对齐 (审计 §1 交互项) */
  React.useEffect(() => {
    if (!selectedProviderRecords && !showPricingConfig) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setSelectedProviderRecords(null);
      setShowPricingConfig(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selectedProviderRecords, showPricingConfig, setSelectedProviderRecords, setShowPricingConfig]);

  const [range, setRange] = React.useState<UsageRange>(() => presetRange('30d'));
  const [rangePickerOpen, setRangePickerOpen] = React.useState(false);
  const [draftStart, setDraftStart] = React.useState(() => presetRange('7d').startDay);
  const [draftEnd, setDraftEnd] = React.useState(() => presetRange('7d').endDay);
  /* 趋势图算好的序列回抛上来, 分享卡直接复用 —— 不为了同一份数据再查一次库 */
  const [rangeSeries, setRangeSeries] = React.useState<DailyUsagePoint[]>([]);
  const [shareOpen, setShareOpen] = React.useState(false);
  const [pricing, setPricing] = React.useState<any[] | null>(null);

  /* 用户自己配的单价 —— 只有配了才算钱。没配就不显示金额, 绝不拿一个"默认价"编数字:
     BYOK 的真实成本只有用户自己知道, 我们编出来的数会被当真。 */
  React.useEffect(() => {
    void (async () => {
      try { setPricing(await (window as any).neox?.pricingGetAll?.() ?? null); }
      catch { setPricing(null); }
    })();
  }, []);

  const shareData = React.useMemo<UsageShareData | null>(() => {
    if (!usageSummary) return null;
    const totalTokens = rangeSeries.reduce((a, p) => a + (p.totalTokens || 0), 0);
    const inputTokens = rangeSeries.reduce((a, p) => a + (p.inputTokens || 0), 0);
    const outputTokens = rangeSeries.reduce((a, p) => a + (p.outputTokens || 0), 0);
    const totalRequests = rangeSeries.reduce((a, p) => a + (p.requests || 0), 0);

    /* 用得最多的模型 —— providerStats 是全量口径(不分区间), 这里只用它排个名次。
       严格按区间切分需要按天 × 模型的聚合, 本地库没有那张表, 与其编一个数
       不如老实用全量排名: 卡上写的是"用得最多", 不是"这段时间用了多少"。 */
    let topModel: { model: string; totalTokens: number } | null = null;
    for (const st of (providerStats ?? [])) {
      for (const [model, ms] of Object.entries((st as any).models ?? {})) {
        const tk = Number((ms as any).totalTokens || 0);
        if (!topModel || tk > topModel.totalTokens) topModel = { model, totalTokens: tk };
      }
    }

    /* 成本: 只有命中用户配的 pattern 才算, 一条都没配则整个金额不显示 */
    let costUsd: number | null = null;
    if (Array.isArray(pricing) && pricing.length > 0 && topModel) {
      const hit = pricing.find((r: any) => {
        try { return new RegExp(String(r.pattern), 'i').test(topModel!.model); } catch { return false; }
      });
      if (hit && typeof hit.inputPrice === 'number' && typeof hit.outputPrice === 'number') {
        costUsd = (inputTokens / 1_000_000) * hit.inputPrice + (outputTokens / 1_000_000) * hit.outputPrice;
      }
    }

    return {
      range, series: rangeSeries, totalTokens, totalRequests, inputTokens, outputTokens,
      activeDays: rangeSeries.filter(p => (p.totalTokens || 0) > 0).length,
      costUsd, topModel,
      avgTokensPerSec: usageSummary.avgTokensPerSec ?? null,
      cacheHitRate: usageSummary.cacheHitRate ?? null,
    };
  }, [usageSummary, rangeSeries, range, providerStats, pricing]);

  /* Token 构成条 (UI3 照稿): 缓存 token 是输入的子集 (cacheHitRate = 缓存 / 总输入),
     所以"输入"段要扣掉缓存, 三段加起来正好是 输入 + 输出, 条的每一段才不会重复计数。 */
  const cachedTok = usageSummary?.totalCachedTokens || 0;
  const uncachedInTok = Math.max(0, (usageSummary?.totalInputTokens || 0) - cachedTok);
  const outTok = usageSummary?.totalOutputTokens || 0;
  const mixTotal = uncachedInTok + cachedTok + outTok;
  const mixPct = (n: number) => (mixTotal > 0 ? (n / mixTotal) * 100 : 0);
  /* cloud mode: fetch failed but cache still has data -> stale=true.
   *   First failure (no cache) also shows banner so user knows why list is empty. */
  const cloudUsageStale = usageIsCloud && !!cloudUsageError;

  const openPricing = () => { void loadPricingConfig(); setShowPricingConfig(true); };

  /* 「按模型」卡 (概览 + 详情共用): 底下一个安静的「模型定价配置 ›」入口, 打开原来的定价弹层 */
  const renderModelCard = () => (
    <div className="byok3-card byok3-dist">
      <div className="byok3-card__head">
        <span className="byok3-card__title">{language === 'zh' ? '按模型' : 'By model'}</span>
      </div>
      {getModelDistribution().map((item: any) => (
        <DistRow key={item.name} name={item.name} percent={item.percent} tokens={item.tokens} />
      ))}
      <div className="byok3-card__foot">
        <button type="button" className="byok3-textbtn" onClick={openPricing}>
          {language === 'zh' ? '模型定价配置 ›' : 'Model pricing ›'}
        </button>
      </div>
    </div>
  );

  return (
    <div className="settings-panel-content">
      {/* UI 3.0 稿: 页头 = 陶土图标 + 标题 + 一句说明, 右边是数据源分段; 原来的说明横幅并进副标题 */}
      <div className="usage-head">
        <PageTitle
          title={t.settings.usage.title}
          subtitle={usageHasMembership
            ? (language === 'zh' ? '订阅额度还剩多少，自带 Key 单独按 token 算' : 'Subscription quota left; your own keys counted in tokens')
            : (language === 'zh' ? '自带 Key 的每次请求按 token 统计，按模型分开看' : 'Every request on your own keys, counted in tokens by model')}
        />
        {/* 数据源 tab —— 登录后才有得切。两份口径不同: 订阅额度是云端网关计的,
            本地统计是自带 key 烧的 token, 合并成一个数没有意义。 */}
        {usageHasMembership && (
          <div className="usage-tab-bar usage-head__seg">
            <button
              className={`usage-tab ${usageSource === 'cloud' ? 'active' : ''}`}
              onClick={() => setUsageSource('cloud')}
              title={language === 'zh' ? '云端订阅额度 · 近 30 天' : 'Subscription quota · last 30d'}
            >
              {language === 'zh' ? '订阅用量' : 'Subscription'}
            </button>
            <button
              className={`usage-tab ${usageSource === 'local' ? 'active' : ''}`}
              onClick={() => setUsageSource('local')}
              title={language === 'zh' ? '自带 API Key (BYOK) 的本地 token 统计' : 'Local token stats for your own API keys (BYOK)'}
            >
              {language === 'zh' ? '自带 Key' : 'BYOK'}
            </button>
          </div>
        )}
        <div className="panel-header-actions">
          {usageSummary && usageSummary.totalRequests > 0 && !usageIsCloud && (
            <button className="add-btn" onClick={clearAllUsageStats}
              title={t.settings.usage.clearAll} style={{ color: '#ef4444' }}>
              <Icons.Trash />
            </button>
          )}
        </div>
      </div>


      {/* cloud unreachable banner */}
      {cloudUsageStale && (
        <div className="usage-stale-wrap">
          <UiSlot name="settings.data-stale" props={{
            stale: true,
            lastError: cloudUsageError,
            lastSuccessAt: cloudUsageLastSuccessAt,
            loading: usageLoading,
            onRetry: () => { void loadUsageStats(); },
            scope: language === 'zh' ? '用量' : 'usage',
          }} />
        </div>
      )}

      {/* BYOK: 先看各家还剩多少钱、去哪充 —— 没有本地请求记录时也要在 (刚配好 Key 最想看的就是余额) */}
      {!usageIsCloud && <ByokBalancePanel zh={language === 'zh'} />}

      {usageIsCloud ? (
        <UiSlot name="settings.usage.subscription" props={{ language }} />
      ) : usageLoading && !usageSummary ? (
        <div className="loading-state" style={{ flexDirection: 'column', gap: 8, padding: '40px 0' }}>
          <Icons.Loader />
          <div style={{ fontSize: 13, color: 'var(--neox-fg-secondary)' }}>
            {usageIsCloud
              ? (language === 'zh' ? '正在从云端拉取最近 30 天用量…' : 'Fetching last 30 days from cloud…')
              : (language === 'zh' ? '读取本地用量统计…' : 'Reading local usage…')}
          </div>
          {usageIsCloud && (
            <div style={{ fontSize: 11, color: 'var(--neox-fg-hint)' }}>
              {language === 'zh' ? '最长约 40 秒；超时会自动重试一次' : 'Up to ~40s; one automatic retry on timeout'}
            </div>
          )}
        </div>
      ) : !usageSummary || usageSummary.totalRequests === 0 ? (
        <LocalUsageEmpty
          zh={language === 'zh'}
          hasMembership={usageHasMembership}
          onGoSubscription={() => setUsageSource('cloud')}
        />
      ) : (
        <div className="byok3 byok3-stack">
          {/* ===== 本地统计卡 (UI3 照稿): 标题 + 时间窗 / 分享 + 概览·详情 ===== */}
          <div className="byok3-card byok3-stats">
            <div className="byok3-stats__head">
              <span className="byok3-card__title">{language === 'zh' ? '本地统计' : 'Local stats'}</span>
              <div className="byok3-stats__ctrls">
                {usageViewMode === 'overview' && !usageIsCloud && (
                  <>
                    <div className="byok3-seg" role="group" aria-label={language === 'zh' ? '时间范围' : 'Time range'}>
                      {(['7d', '30d'] as const).map(k => (
                        <button key={k} type="button"
                          className={`byok3-seg__btn ${range.kind === k ? 'is-active' : ''}`}
                          onClick={() => { setRange(presetRange(k)); setRangePickerOpen(false); }}
                        >{k === '7d' ? (language === 'zh' ? '7 天' : '7d') : (language === 'zh' ? '30 天' : '30d')}</button>
                      ))}
                      <button type="button"
                        className={`byok3-seg__btn ${range.kind === 'custom' ? 'is-active' : ''}`}
                        onClick={() => setRangePickerOpen(v => !v)}
                      >{range.kind === 'custom' ? rangeLabel(range, language === 'zh') : (language === 'zh' ? '自定义' : 'Custom')}</button>
                    </div>
                    <button type="button" className="byok3-textbtn"
                      disabled={!shareData || shareData.totalTokens === 0}
                      onClick={() => setShareOpen(true)}
                    >{language === 'zh' ? '分享' : 'Share'}</button>
                  </>
                )}
                <div className="byok3-tabs" role="group" aria-label={language === 'zh' ? '视图' : 'View'}>
                  <button type="button"
                    className={`byok3-textbtn ${usageViewMode === 'overview' ? 'is-active' : ''}`}
                    onClick={() => setUsageViewMode('overview')}
                  >{language === 'zh' ? '概览' : 'Overview'}</button>
                  <button type="button"
                    className={`byok3-textbtn ${usageViewMode === 'distribution' ? 'is-active' : ''}`}
                    onClick={() => setUsageViewMode('distribution')}
                  >{language === 'zh' ? '详情' : 'Details'}</button>
                </div>
              </div>

              {rangePickerOpen && (
                <div className="usg-range__pop" style={{ left: 'auto', right: 0, top: '100%' }}>
                  <div className="usg-range__pop-row">
                    <input type="date" value={draftStart} max={draftEnd} onChange={e => setDraftStart(e.target.value)} />
                    <span style={{ opacity: 0.5 }}>→</span>
                    <input type="date" value={draftEnd} max={presetRange('7d').endDay} onChange={e => setDraftEnd(e.target.value)} />
                  </div>
                  <div className="usg-range__pop-row" style={{ justifyContent: 'space-between' }}>
                    <span className="usg-range__pop-hint">{language === 'zh' ? '最长 366 天' : 'Up to 366 days'}</span>
                    <button type="button" className="usg-range__btn is-active"
                      onClick={() => {
                        const r = customRange(draftStart, draftEnd);
                        if (r) { setRange(r); setRangePickerOpen(false); }
                      }}
                    >{language === 'zh' ? '应用' : 'Apply'}</button>
                  </div>
                </div>
              )}
            </div>

            {usageViewMode === 'overview' && (
              <>
                {!usageIsCloud && (
                  <UsageTrendChart range={range} zh={language === 'zh'} onSeries={setRangeSeries} />
                )}

                {/* 四个指标: 小字标签在上, 数字在下。次要指标 (首响 / 速度 / 缓存) 不再挤在图表下面的一行小字里 */}
                <div className="byok3-metrics">
                  <div className="byok3-metric">
                    <span className="byok3-metric__lbl">{language === 'zh' ? '累计请求' : 'Total requests'}</span>
                    <span className="byok3-metric__val">{formatTokenCount(usageSummary.totalRequests)}</span>
                  </div>
                  {usageSummary.avgFirstTokenMs != null && (
                    <div className="byok3-metric">
                      <span className="byok3-metric__lbl">{language === 'zh' ? '平均首响' : 'Avg TTFT'}</span>
                      <span className="byok3-metric__val">
                        {usageSummary.avgFirstTokenMs >= 1000
                          ? `${(usageSummary.avgFirstTokenMs / 1000).toFixed(1)}s`
                          : `${Math.round(usageSummary.avgFirstTokenMs)}ms`}
                      </span>
                    </div>
                  )}
                  {usageSummary.avgTokensPerSec != null && (
                    <div className="byok3-metric">
                      <span className="byok3-metric__lbl">{language === 'zh' ? '生成速度' : 'Gen speed'}</span>
                      <span className="byok3-metric__val">
                        {Number(usageSummary.avgTokensPerSec).toFixed(1)} tok/s
                      </span>
                    </div>
                  )}
                  {usageSummary.totalCachedTokens > 0 && (
                    <div className="byok3-metric">
                      <span className="byok3-metric__lbl">{language === 'zh' ? '缓存命中' : 'Cache hit'}</span>
                      <span className="byok3-metric__val">
                        {((usageSummary.cacheHitRate || 0) * 100).toFixed(1)}%
                      </span>
                    </div>
                  )}
                </div>

                <div className="byok3-sep" />

                {/* Token 构成: 一条叠起来的横条 + 一行图例 (输入 · 缓存 · 输出) */}
                <div className="byok3-mix">
                  <div className="byok3-mix__head">
                    <span className="byok3-mix__label">{language === 'zh' ? 'Token 构成' : 'Token Mix'}</span>
                    <span className="byok3-mix__total">
                      {formatTokenCount(usageSummary.totalTokens)} {language === 'zh' ? '总计' : 'total'}
                    </span>
                  </div>
                  <div className="byok3-mix__bar" role="img"
                    aria-label={language === 'zh' ? 'Token 构成比例' : 'Token mix ratio'}>
                    <span className="byok3-mix__seg byok3-mix__seg--in" style={{ width: `${mixPct(uncachedInTok)}%` }} />
                    {cachedTok > 0 && (
                      <span className="byok3-mix__seg byok3-mix__seg--cache" style={{ width: `${mixPct(cachedTok)}%` }} />
                    )}
                    <span className="byok3-mix__seg byok3-mix__seg--out" style={{ width: `${mixPct(outTok)}%` }} />
                  </div>
                  <div className="byok3-mix__legend">
                    <span>{language === 'zh' ? '输入' : 'Input'} {formatTokenCount(uncachedInTok)}</span>
                    {cachedTok > 0 && (
                      <span>{language === 'zh' ? '缓存' : 'Cached'} {formatTokenCount(cachedTok)}</span>
                    )}
                    <span>{language === 'zh' ? '输出' : 'Output'} {formatTokenCount(outTok)}</span>
                  </div>
                </div>

                {/* 日均 / 周均 / 月均 —— 只有配了单价才有这一行 */}
                {costEstimate && (
                  <div className="byok3-cost">
                    <span>{language === 'zh' ? '日均' : 'Daily'} <strong>${costEstimate.daily.toFixed(4)}</strong></span>
                    <span>{language === 'zh' ? '周均' : 'Weekly'} <strong>${costEstimate.weekly.toFixed(4)}</strong></span>
                    <span>{language === 'zh' ? '月均' : 'Monthly'} <strong>${costEstimate.monthly.toFixed(2)}</strong></span>
                  </div>
                )}
              </>
            )}
          </div>

          {/* 分享卡 —— 背幕+浮卡两层, 卡本身是一整块 SVG (可直接导出 PNG) */}
          {shareOpen && shareData && (
            <UsageShareCard data={shareData} zh={language === 'zh'} onClose={() => setShareOpen(false)} />
          )}

          {/* ==================== Overview 其余卡 ==================== */}
          {usageViewMode === 'overview' && (
            <>
              {/* P1: Rate Limit window usage */}
              <RateLimitUsagePanel language={language} />

              {/* 按服务商 —— 原来的 Provider 分布, 同一套行式版式 */}
              <div className="byok3-card byok3-dist">
                <div className="byok3-card__head">
                  <span className="byok3-card__title">{language === 'zh' ? '按服务商' : 'By provider'}</span>
                </div>
                {getProviderDistribution().map((item: any) => (
                  <DistRow key={item.name} name={item.name} percent={item.percent} tokens={item.tokens} />
                ))}
              </div>

              {renderModelCard()}

              {/* cache overview */}
              {usageSummary.totalCachedTokens > 0 && (
                <div className="byok3-card byok3-cache">
                  <div className="byok3-card__head">
                    <span className="byok3-card__title">{language === 'zh' ? '缓存' : 'Cache'}</span>
                  </div>
                  <div className="usg-cache-row">
                    <span>{language === 'zh' ? '缓存 Token' : 'Cached'}: <strong>{formatTokenCount(usageSummary.totalCachedTokens)}</strong></span>
                    <span>{language === 'zh' ? '命中率' : 'Hit'}: <strong>{((usageSummary.cacheHitRate || 0) * 100).toFixed(1)}%</strong></span>
                    {usageSummary.totalOpenaiCachedTokens > 0 && (
                      <span>OpenAI: <strong>{formatTokenCount(usageSummary.totalOpenaiCachedTokens)}</strong></span>
                    )}
                    {usageSummary.totalAnthropicCacheReadTokens > 0 && (
                      <span>Anthropic R: <strong>{formatTokenCount(usageSummary.totalAnthropicCacheReadTokens)}</strong></span>
                    )}
                  </div>
                </div>
              )}

              {/* 7-day trend chart deleted -- setUsageChartData was never called, array always [],
               *   conditional render always false. Future trend should group by date from records. */}
            </>
          )}

          {/* ==================== Details Tab ==================== */}
          {usageViewMode === 'distribution' && (
            <>
              <div className="byok3-card byok3-card--flush">
                {providerStats.map((stat: any) => {
                  const isExpanded = expandedProviders.has(stat.provider);
                  const toggleExpand = () => {
                    setExpandedProviders((prev: Set<string>) => {
                      const next = new Set(prev);
                      next.has(stat.provider) ? next.delete(stat.provider) : next.add(stat.provider);
                      return next;
                    });
                  };
                  const modelEntries = Object.entries(stat.models).sort((a: any, b: any) => b[1].totalTokens - a[1].totalTokens);
                  const maxModelTokens = modelEntries.length > 0 ? (modelEntries[0][1] as any).totalTokens : 1;
                  const successRate = stat.totalRequests > 0 ? ((stat.successRequests / stat.totalRequests) * 100) : 100;

                  return (
                  <div key={stat.provider} className="usg-detail-block">
                    {/* Header (clickable) */}
                    <div className="usg-detail-header" onClick={toggleExpand}>
                      <svg className={`usg-chevron ${isExpanded ? 'open' : ''}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                      <span className="usg-pr-name">{stat.provider}</span>
                      <span className="usg-pr-count">{stat.totalRequests} {language === 'zh' ? '次' : 'req'}</span>
                      <span className="usg-detail-sep" />

                      {/* Mini sparkline: model proportion */}
                      <div className="usg-mini-spark">
                        {modelEntries.map(([model, ms]: any, idx: number) => (
                          <div key={model} className="usg-spark-seg"
                            style={{
                              flex: ms.totalTokens,
                              background: `hsl(${(idx * 32 + 150) % 360}, 42%, 46%)`
                            }}
                            title={`${model}: ${formatTokenCount(ms.totalTokens)}`} />
                        ))}
                      </div>

                      <div className="usg-detail-stats">
                        <span>↓{formatTokenCount(stat.totalInputTokens)}</span>
                        <span>↑{formatTokenCount(stat.totalOutputTokens)}</span>
                        {stat.totalCachedTokens > 0 && (
                          <span className="usg-pr-cache">
                            <Icons.Zap />{formatTokenCount(stat.totalCachedTokens)}
                          </span>
                        )}
                      </div>

                      <div className="usg-detail-right">
                        <span className={`usg-success-rate ${successRate >= 99 ? 'good' : successRate >= 90 ? 'warn' : 'bad'}`}>
                          {successRate.toFixed(0)}%
                        </span>
                        {stat.avgTokensPerSec != null && (
                          <span className="usg-pr-time" title={language === 'zh' ? '平均生成速度' : 'Avg generation speed'}>
                            {Number(stat.avgTokensPerSec).toFixed(1)} tok/s
                          </span>
                        )}
                        {/* duration 在 tokenUsageService 里的定义就是"整轮耗时(含工具循环)",
                            不是单次请求耗时。原来直接渲成 `{avgDuration}ms` + label「平均耗时」,
                            于是面板上出现 393779ms 这种读不懂的数字 —— 它其实是"平均每轮 6.6 分钟"。
                            按量级换单位, 并把口径写进 title。 */}
                        <span
                          className="usg-pr-time"
                          title={language === 'zh'
                            ? '平均每轮耗时 (含工具循环, 不是单次请求)'
                            : 'Avg per-turn duration (includes the tool loop, not a single request)'}
                        >
                          {formatTurnDuration(Number(stat.avgDuration) || 0)}/轮
                        </span>
                      </div>
                    </div>

                    {/* Expanded content */}
                    {isExpanded && (
                      <div className="usg-detail-body">
                        {/* Summary row */}
                        <div className="usg-detail-summary">
                          <span>{language === 'zh' ? '总 Token' : 'Total'}: <strong>{formatTokenCount(stat.totalTokens)}</strong></span>
                          <span>{language === 'zh' ? '成功' : 'OK'}: <strong>{stat.successRequests}</strong></span>
                          <span>{language === 'zh' ? '失败' : 'Fail'}: <strong style={{ color: stat.failedRequests > 0 ? '#ef4444' : 'inherit' }}>{stat.failedRequests}</strong></span>
                          {stat.totalBillableInputTokens > 0 && (
                            <span>{language === 'zh' ? '计费' : 'Billable'}: <strong>{formatTokenCount(stat.totalBillableInputTokens)}</strong></span>
                          )}
                          {stat.avgFirstTokenMs != null && (
                            <span>{language === 'zh' ? '平均首响' : 'TTFT'}: <strong>
                              {stat.avgFirstTokenMs >= 1000 ? `${(stat.avgFirstTokenMs / 1000).toFixed(1)}s` : `${stat.avgFirstTokenMs}ms`}
                            </strong></span>
                          )}
                          {stat.lastRequestTime > 0 && (
                            <span className="usg-detail-lasttime">{formatTime(stat.lastRequestTime, language)}</span>
                          )}
                        </div>

                        {/* Model table */}
                        <div className="usg-model-table">
                          <div className="usg-mt-head">
                            <span className="usg-mt-col model">{language === 'zh' ? '模型' : 'Model'}</span>
                            <span className="usg-mt-col num">{language === 'zh' ? '次数' : 'Req'}</span>
                            <span className="usg-mt-col num">{language === 'zh' ? '输入' : 'In'}</span>
                            <span className="usg-mt-col num">{language === 'zh' ? '输出' : 'Out'}</span>
                            <span className="usg-mt-col num">{language === 'zh' ? '缓存' : 'Cache'}</span>
                            <span className="usg-mt-col bar">{language === 'zh' ? '占比' : 'Share'}</span>
                          </div>
                          {modelEntries.map(([model, ms]: any, idx: number) => {
                            const pct = stat.totalTokens > 0 ? (ms.totalTokens / stat.totalTokens * 100) : 0;
                            return (
                            <div key={model} className="usg-mt-row">
                              <span className="usg-mt-col model" title={model}>
                                <span className="usg-mt-dot" style={{ background: `hsl(${(idx * 32 + 150) % 360}, 42%, 46%)` }} />
                                {model}
                              </span>
                              <span className="usg-mt-col num">{ms.requests}</span>
                              <span className="usg-mt-col num">{formatTokenCount(ms.inputTokens)}</span>
                              <span className="usg-mt-col num">{formatTokenCount(ms.outputTokens)}</span>
                              <span className="usg-mt-col num">{ms.cachedTokens > 0 ? formatTokenCount(ms.cachedTokens) : '-'}</span>
                              <span className="usg-mt-col bar">
                                <span className="usg-mt-bar-track">
                                  <span className="usg-mt-bar-fill" style={{
                                    width: `${(ms.totalTokens / maxModelTokens) * 100}%`,
                                    background: `hsl(${(idx * 32 + 150) % 360}, 42%, 46%)`
                                  }} />
                                </span>
                                <span className="usg-mt-bar-pct">{pct.toFixed(1)}%</span>
                              </span>
                            </div>
                            );
                          })}
                        </div>

                        {/* Actions -- cloud mode: records / clear go via cloud read-only, local buttons meaningless -> hide */}
                        {!usageIsCloud && (
                          <div className="usg-detail-actions">
                            <button className="memory-action-btn" onClick={() => loadProviderRecords(stat.provider)}>
                              <Icons.File />
                              <span>{t.settings.usage.viewRecords}</span>
                            </button>
                            <button className="rc-disconnect" onClick={() => clearProviderUsageStats(stat.provider)}>
                              <Icons.Trash />
                              <span>{t.settings.usage.clearProvider}</span>
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>

              {/* Model distribution (Top 10) —— 同「按模型」卡 */}
              {renderModelCard()}
            </>
          )}
        </div>
      )}

      {/* records modal */}
      {selectedProviderRecords && (
        <div className="modal-overlay" onClick={() => setSelectedProviderRecords(null)}>
          <div className="modal-content records-modal" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{selectedProviderRecords.provider} - {t.settings.usage.recentRecords}</h3>
              <button className="close-btn" onClick={() => setSelectedProviderRecords(null)} title={language === 'zh' ? '关闭' : 'Close'} aria-label={language === 'zh' ? '关闭' : 'Close'}>
                <Icons.Close />
              </button>
            </div>
            <div className="records-list">
              {selectedProviderRecords.records.length === 0 ? (
                <div className="empty-records">{t.settings.usage.noRecords}</div>
              ) : (
                <table className="records-table">
                  <thead>
                    <tr>
                      <th>{t.settings.usage.type || '类型'}</th>
                      <th>{t.settings.usage.model}</th>
                      <th>{t.settings.usage.inputTokens}</th>
                      <th>{language === 'zh' ? '计费输入' : 'Billable In'}</th>
                      <th>{t.settings.usage.outputTokens}</th>
                      <th>{language === 'zh' ? '缓存读' : 'Cache Read'}</th>
                      <th>{language === 'zh' ? '缓存写' : 'Cache Write'}</th>
                      <th>{t.settings.usage.duration}</th>
                      <th>{t.settings.usage.status}</th>
                      <th>{t.settings.usage.lastRequest}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedProviderRecords.records.map((record: any) => (
                      <tr key={record.id} className={record.success ? '' : 'error'}>
                        <td>
                          <span className={`type-badge ${record.requestType === 'health-check' ? 'health-check' : 'chat'}`}>
                            {record.requestType === 'health-check' ? (t.settings.usage.healthCheck || '测试') : (t.settings.usage.chat || '对话')}
                          </span>
                        </td>
                        <td title={record.model}>{record.model}</td>
                        <td>{formatTokenCount(record.inputTokens)}</td>
                        <td>{record.billableInputTokens ? formatTokenCount(record.billableInputTokens) : '-'}</td>
                        <td>{formatTokenCount(record.outputTokens)}</td>
                        <td className={(record.cacheReadTokens || record.cachedTokens) ? 'cached-tokens' : ''}>{(record.cacheReadTokens || record.cachedTokens) ? formatTokenCount(record.cacheReadTokens || record.cachedTokens || 0) : '-'}</td>
                        <td className={record.cacheWriteTokens ? 'cached-tokens' : ''}>{record.cacheWriteTokens ? formatTokenCount(record.cacheWriteTokens) : '-'}</td>
                        <td>{record.duration}ms</td>
                        <td>
                          <span className={`status-badge ${record.success ? 'success' : 'failed'}`}>
                            {record.success ? t.settings.usage.success : t.settings.usage.failed}
                          </span>
                        </td>
                        <td>{formatTime(record.timestamp, language)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* pricing config modal */}
      {showPricingConfig && (
        <div className="modal-overlay" onClick={() => setShowPricingConfig(false)}>
          <div className="modal-content pricing-modal" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{language === 'zh' ? '模型定价配置' : 'Model Pricing'}</h3>
              <button className="modal-close" onClick={() => setShowPricingConfig(false)} title={language === 'zh' ? '关闭' : 'Close'} aria-label={language === 'zh' ? '关闭' : 'Close'}>
                <Icons.Close />
              </button>
            </div>
            <div className="modal-body">
              <p className="pricing-hint">
                {language === 'zh'
                  ? '配置模型价格（美元/百万 token），支持通配符如 gpt-4*'
                  : 'Configure price (USD/M tokens), supports wildcards like gpt-4*'}
              </p>

              {/* add new pricing */}
              <div className="pricing-add-form">
                <input
                  type="text"
                  placeholder={language === 'zh' ? '模型名称/模式' : 'Model pattern'}
                  value={newPricing.pattern}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewPricing({ ...newPricing, pattern: e.target.value })}
                  className="pricing-input pattern"
                />
                <input
                  type="number"
                  step="0.01"
                  placeholder={language === 'zh' ? '输入价格' : 'Input'}
                  value={newPricing.inputPrice}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewPricing({ ...newPricing, inputPrice: e.target.value })}
                  className="pricing-input"
                />
                <input
                  type="number"
                  step="0.01"
                  placeholder={language === 'zh' ? '输出价格' : 'Output'}
                  value={newPricing.outputPrice}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewPricing({ ...newPricing, outputPrice: e.target.value })}
                  className="pricing-input"
                />
                <input
                  type="number"
                  step="0.01"
                  placeholder={language === 'zh' ? '缓存价格(可选)' : 'Cache(opt)'}
                  value={newPricing.cachedInputPrice}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewPricing({ ...newPricing, cachedInputPrice: e.target.value })}
                  className="pricing-input"
                />
                <button
                  className="btn-primary"
                  disabled={!newPricing.pattern || !newPricing.inputPrice || !newPricing.outputPrice}
                  onClick={() => {
                    savePricing({
                      pattern: newPricing.pattern,
                      inputPrice: parseFloat(newPricing.inputPrice),
                      outputPrice: parseFloat(newPricing.outputPrice),
                      cachedInputPrice: newPricing.cachedInputPrice ? parseFloat(newPricing.cachedInputPrice) : undefined,
                    });
                    setNewPricing({ pattern: '', inputPrice: '', outputPrice: '', cachedInputPrice: '' });
                  }}
                 title={language === 'zh' ? '添加定价规则' : 'Add pricing rule'} aria-label={language === 'zh' ? '添加定价规则' : 'Add pricing rule'}>
                  <Icons.Plus />
                </button>
              </div>

              {/* pricing list */}
              <div className="pricing-table">
                <div className="pricing-header">
                  <span>{language === 'zh' ? '模型' : 'Model'}</span>
                  <span>{language === 'zh' ? '输入' : 'Input'}</span>
                  <span>{language === 'zh' ? '输出' : 'Output'}</span>
                  <span>{language === 'zh' ? '缓存' : 'Cache'}</span>
                  <span></span>
                </div>
                {pricingLoading ? (
                  <div className="pricing-loading"><Icons.Loader /></div>
                ) : pricingList.length === 0 ? (
                  <div className="pricing-empty">
                    {language === 'zh' ? '暂无定价配置' : 'No pricing configured'}
                  </div>
                ) : (
                  pricingList
                    .filter((p: any) => p && typeof p.pattern === 'string')
                    .map((p: any) => (
                    <div key={p.pattern} className="pricing-row">
                      <span className="pricing-model">{p.pattern}</span>
                      <span className="pricing-value">${p.inputPrice}</span>
                      <span className="pricing-value">${p.outputPrice}</span>
                      <span className="pricing-value">{p.cachedInputPrice ? `$${p.cachedInputPrice}` : '-'}</span>
                      <button className="btn-icon danger" onClick={() => deletePricing(p.pattern)} title={language === 'zh' ? '删除这条定价' : 'Delete pricing rule'} aria-label={language === 'zh' ? '删除这条定价' : 'Delete pricing rule'}>
                        <Icons.Trash />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default UsageTab;
