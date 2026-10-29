
import React from 'react';
import { copyToClipboard } from '../utils/copyToClipboard';
import './neox-cards.css';
import { useI18n } from '../hooks/useI18n';
import { FileTypeIcon } from './FileTypeIcon';
import {
  numOf, shortPath, baseOf, dirOf, normTone, NGlyph, classifyGlyph, TONE_GLYPH,
  NStatusSeal, NCardHead, ratioOf, NBar, type Tone, type GlyphName,
} from './neoxCards/primitives';
import { ChartCard } from './neoxCards/charts';
export { niceDomain } from './neoxCards/charts';

type CardKind = 'restaurant' | 'weather' | 'todo' | 'compare' | 'news' | 'booking' | 'recipe'
  | 'tracking' | 'trip' | 'product' | 'gallery'
  | 'summary' | 'chart' | 'metrics' | 'steps' | 'callout' | 'table' | 'diff'
  | 'report' | 'flow' | 'timeline'
  | 'link' | 'image' | 'video'
  /* 图表子类型被当成种类写 (```neox-card:gauge) —— 按 chart 收, 种类名补成 type */
  | ChartSubtype;

/** 模型会把 chart 的 type 直接写成卡片种类; 这些一律当图表渲染 */
export const CHART_SUBTYPES = ['bar', 'column', 'line', 'area', 'pie', 'donut', 'gauge', 'stacked', 'heatmap'] as const;
type ChartSubtype = typeof CHART_SUBTYPES[number];

function tryParseLenient(body: string): unknown | null {
  const raw = body.trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { /* fall through */ }
  let s = raw;
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  let lastSafeCut = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = false; lastSafeCut = i + 1; }
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') { stack.push(c); lastSafeCut = i + 1; }
    else if (c === '}' && stack[stack.length - 1] === '{') { stack.pop(); lastSafeCut = i + 1; }
    else if (c === ']' && stack[stack.length - 1] === '[') { stack.pop(); lastSafeCut = i + 1; }
    else if (c === ',' || c === ':') { /* skip separators */ }
    else if (!/\s/.test(c)) { /* value chars */ }
  }
  if (inStr) {
    /* 字符串还没关: 截到最近安全点, 再补个 " */
    s = s.slice(0, lastSafeCut);
    /* 尾部残缺的 key "xxx  → 剪掉 */
    s = s.replace(/,?\s*"[^"]*$/, '');
    /* 尾部残缺的 key: "xxx" : → 剪掉 */
    s = s.replace(/,?\s*"[^"]+"\s*:\s*$/, '');
  }
  /* 尾部残缺 value (数字/true/... 未闭合) */
  s = s.replace(/,\s*$/, '');
  s = s.replace(/:\s*(?:tr|tru|fa|fal|fals|nu|nul)\s*$/, ':null');
  /* 按栈补齐 */
  while (stack.length) {
    const open = stack.pop();
    s += open === '{' ? '}' : ']';
  }
  /* 去掉紧贴闭合括号之前的多余逗号 */
  s = s.replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(s); } catch { return null; }
}

export const NeoxCard: React.FC<{ kind: string; body: string }> = ({ kind, body }) => {
  const { isZh } = useI18n();
  const k = kind.toLowerCase().replace(/^neox-card:/, '') as CardKind;
  const lastGoodRef = React.useRef<{ kind: CardKind; data: any } | null>(null);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  /* Word 环绕: float 只绕得了后面的字.
   *   · 卡跟在同一 <li> 的段落后面 → 提到该 li 开头
   *   · 卡夹在列表和后续段落之间 → 塞进上一个列表的最后一项开头
   * 这样第 2 条自己的说明会绕着插图走, 而不是卡在下面当一块孤岛. */
  React.useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (k === 'link') return;
    if (getComputedStyle(el).float === 'none') return;
    const parent = el.parentElement;
    if (!parent) return;
    const prev = el.previousElementSibling;
    if (!prev) return;
    if (prev.tagName === 'P' || prev.classList.contains('md-paragraph')) {
      parent.insertBefore(el, parent.tagName === 'LI' ? parent.firstElementChild : prev);
      return;
    }
    if ((prev.tagName === 'OL' || prev.tagName === 'UL') && parent.classList.contains('markdown-content')) {
      const lis = [...prev.children].filter((c) => c.tagName === 'LI');
      const lastLi = lis[lis.length - 1];
      if (lastLi) lastLi.insertBefore(el, lastLi.firstChild);
    }
  }, []);
  const parsed = tryParseLenient(body);
  let data = parsed;
  if (parsed && typeof parsed === 'object') {
    lastGoodRef.current = { kind: k, data: parsed };
  } else if (lastGoodRef.current && lastGoodRef.current.kind === k) {
    data = lastGoodRef.current.data;
  }
  if (!data || typeof data !== 'object') {
    return (
      <div className="neox-card__pending" aria-hidden="true" title={isZh ? '卡片生成中…' : 'Generating card…'}>
        <span className="neox-card__pending-dot" />
        <span className="neox-card__pending-dot" />
        <span className="neox-card__pending-dot" />
      </div>
    );
  }
  let inner: React.ReactNode = null;
  switch (k) {
    case 'restaurant': inner = <RestaurantCard data={data} />; break;
    case 'weather':    inner = <WeatherCard data={data} />; break;
    case 'todo':       inner = <TodoCard data={data} />; break;
    case 'compare':    inner = <CompareCard data={data} />; break;
    case 'news':       inner = <NewsCard data={data} />; break;
    case 'booking':    inner = <BookingCard data={data} />; break;
    case 'recipe':     inner = <RecipeCard data={data} />; break;
    case 'tracking':   inner = <TrackingCard data={data} />; break;
    case 'trip':       inner = <TripCard data={data} />; break;
    case 'product':    inner = <ProductCard data={data} />; break;
    case 'gallery':    inner = <GalleryCard data={data} />; break;
    /* 工作向 */
    case 'summary':    inner = <SummaryCard data={data} />; break;
    case 'chart':      inner = <ChartCard data={data} />; break;
    case 'metrics':    inner = <MetricsCard data={data} />; break;
    case 'steps':      inner = <StepsCard data={data} />; break;
    case 'callout':    inner = <CalloutCard data={data} />; break;
    case 'diff':       inner = <DiffCard data={data} />; break;
    case 'report':     inner = <ReportCard data={data} />; break;
    case 'flow':       inner = <FlowCard data={data} />; break;
    case 'timeline':   inner = <TimelineCard data={data} />; break;
    /* table 是 compare 的别名 —— 模型写哪个都认 (它记不住是常态) */
    case 'table':      inner = <CompareCard data={data} />; break;
    case 'link':       inner = <LinkCard data={data} />; break;
    case 'image':      inner = <ImageCard data={data} />; break;
    case 'video':      inner = <VideoCard data={data} />; break;
    default:
      if ((CHART_SUBTYPES as readonly string[]).includes(k)) { inner = <ChartCard data={{ ...data, type: (data as { type?: string }).type ?? k }} />; break; }
      return null;
  }
  return (
    <div className="ncard-wrap" ref={wrapRef}>
      {inner}
    </div>
  );
};

/* ---------- Restaurant ---------- */

interface RestaurantItem {
  name?: string; cuisine?: string; priceRange?: string; rating?: number;
  address?: string; phone?: string; highlight?: string; mapUrl?: string;
}

type RestCuisineTheme = 'chinese' | 'japanese' | 'korean' | 'western' | 'dessert' | 'vegan' | 'neutral';
const restCuisineTheme = (items: RestaurantItem[]): RestCuisineTheme => {
  const combined = items.map((r) => (r.cuisine || '')).join(' ').toLowerCase();
  if (/川|湘|粤|中|chinese|dim ?sum|hotpot/.test(combined)) return 'chinese';
  if (/日|寿司|拉面|居酒屋|japanese|sushi|ramen|izakaya/.test(combined)) return 'japanese';
  if (/韩|烤肉|korean|bbq/.test(combined)) return 'korean';
  if (/意|法|美|西|western|italian|french|american|steak|burger|pizza/.test(combined)) return 'western';
  if (/甜|dessert|bakery|cafe|coffee|tea/.test(combined)) return 'dessert';
  if (/素|vegan|vegetarian/.test(combined)) return 'vegan';
  return 'neutral';
};

const RestaurantCard: React.FC<{ data: { items?: RestaurantItem[]; title?: string } }> = ({ data }) => {
  const { isZh } = useI18n();
  const items = Array.isArray(data.items) ? data.items : [];
  const theme = restCuisineTheme(items);
  const ratings = items.map((r) => (typeof r.rating === 'number' && Number.isFinite(r.rating) ? r.rating : null))
    .filter((n): n is number => n !== null);
  const topRating = ratings.length ? Math.max(...ratings) : null;
  const topItem = topRating !== null ? items.find((r) => r.rating === topRating) : null;
  const cuisineChips = Array.from(new Set(items.map((r) => (r.cuisine || '').trim()).filter(Boolean))).slice(0, 3);

  return (
    <div className={`ncard ncard--rest rest rest--${theme}`}>
      <div className="rest__hero">
        <div className="rest__hero-title">{data.title || (items.length > 1
          ? (isZh ? `${items.length} 家推荐` : `${items.length} picks`)
          : (isZh ? '餐厅推荐' : 'Restaurant picks'))}</div>
        <div className="rest__hero-meta">
          {topRating !== null && (
            <span className="rest__hero-rating" title={topItem?.name
              ? (isZh ? `最高分: ${topItem.name}` : `Top rated: ${topItem.name}`)
              : (isZh ? '最高评分' : 'Top rating')}>
              <svg viewBox="0 0 20 20" width="12" height="12" fill="currentColor" aria-hidden><path d="M10 1l2.6 5.6 6.1.9-4.4 4.3 1 6.1L10 15l-5.4 2.9 1-6.1L1.3 7.5l6.1-.9L10 1z"/></svg>
              <span>{topRating.toFixed(1)}</span>
            </span>
          )}
          {cuisineChips.map((c) => (
            <span key={c} className="rest__hero-chip">{c}</span>
          ))}
        </div>
      </div>
      <div className="nrr__list rest__list">
        {items.map((r, i) => {
          const mapHref = r.mapUrl || `https://uri.amap.com/search?keywords=${encodeURIComponent((r.name || '') + ' ' + (r.address || ''))}`;
          return (
            <div key={i} className="nrr">
              <span className="nrr__idx">{i + 1}</span>
              <div className="nrr__main">
                <div className="nrr__l1">
                  <span className="nrr__name">{r.name || '—'}</span>
                  <span className="nrr__meta">
                    {typeof r.rating === 'number' && (
                      <span className="nrr__rating" title={isZh ? `评分 ${r.rating}/5` : `Rated ${r.rating}/5`}>
                        <svg viewBox="0 0 20 20" width="10" height="10" fill="currentColor"><path d="M10 1l2.6 5.6 6.1.9-4.4 4.3 1 6.1L10 15l-5.4 2.9 1-6.1L1.3 7.5l6.1-.9L10 1z"/></svg>
                        {r.rating.toFixed(1)}
                      </span>
                    )}
                    {r.cuisine && <span>{r.cuisine}</span>}
                    {r.priceRange && <span>{r.priceRange}</span>}
                  </span>
                </div>
                <div className="nrr__l2">
                  {r.highlight && <span className="nrr__hl">{r.highlight}</span>}
                  {r.address && <span className="nrr__addr" title={r.address}>{r.address}</span>}
                  {r.phone && <a className="nrr__tel" href={`tel:${r.phone}`}>{r.phone}</a>}
                </div>
              </div>
              <div className="nrr__acts">
                {(r.address || r.mapUrl) && (
                  <a className="nrr__act" href={mapHref} target="_blank" rel="noopener noreferrer" title={isZh ? '在地图打开' : 'Open in Maps'} aria-label={isZh ? '在地图打开' : 'Open in Maps'}>
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10 2c-3 0-5 2.2-5 5 0 4 5 9 5 9s5-5 5-9c0-2.8-2-5-5-5z"/><circle cx="10" cy="7" r="1.8"/>
                    </svg>
                  </a>
                )}
                {r.address && (
                  <button type="button" className="nrr__act" onClick={() => copyToClipboard(r.address!)} title={isZh ? '复制地址' : 'Copy address'} aria-label={isZh ? '复制地址' : 'Copy address'}>
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="6" y="4" width="10" height="12" rx="1.5"/><path d="M4 8h2v10h8"/>
                    </svg>
                  </button>
                )}
                {r.phone && (
                  <a className="nrr__act" href={`tel:${r.phone}`} title={isZh ? '拨号' : 'Call'} aria-label={isZh ? '拨号' : 'Call'}>
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 3h3l2 4-2 1a10 10 0 004 4l1-2 4 2v3a2 2 0 01-2 2A14 14 0 013 5a2 2 0 012-2z"/>
                    </svg>
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};


interface WeatherDayData {
  day?: string;
  high?: number | string;
  low?: number | string;
  text?: string;
  rain_chance?: number | string;
}
interface WeatherData {
  location?: string;
  current?: {
    temp?: number | string;
    feels_like?: number | string;
    text?: string;
    wind?: string;
    humidity?: number | string;
  };
  forecast?: WeatherDayData[];
}

/** "28°" / "83%" / 28 → 28; 解析不出 → null */
const wxNum = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[^\d.+-]/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return null;
};

type WxKind = 'sun' | 'cloud' | 'rain' | 'snow' | 'storm' | 'fog';

/** 状况文本 (WMO 中文短语 / 英文) → 主题。顺序要紧: 雷 > 雪 > 雨 > 雾 > 云 > 晴 */
const wxKind = (text?: string): WxKind => {
  const t = (text || '').toLowerCase();
  if (/雷|storm|thunder/.test(t)) return 'storm';
  if (/雪|snow|flurr/.test(t)) return 'snow';
  if (/雨|rain|drizzle|shower/.test(t)) return 'rain';
  if (/雾|霾|fog|mist|haze/.test(t)) return 'fog';
  if (/云|阴|cloud|overcast/.test(t)) return 'cloud';
  return 'sun';
};

const WxIcon: React.FC<{ kind: WxKind; size?: number }> = ({ kind, size = 18 }) => {
  const p = {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.6,
    strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (kind) {
    case 'sun': return (
      <svg {...p}><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5 5l1.7 1.7M17.3 17.3 19 19M19 5l-1.7 1.7M6.7 17.3 5 19" /></svg>
    );
    case 'cloud': return (
      <svg {...p}><path d="M17.5 18a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.4 11.5 3.75 3.75 0 0 0 7 18h10.5z" /></svg>
    );
    case 'rain': return (
      <svg {...p}><path d="M17.5 15a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.4 8.5 3.75 3.75 0 0 0 7 15h10.5z" /><path d="M8.5 17.5v2.6M12 18.5v2.6M15.5 17.5v2.6" /></svg>
    );
    case 'snow': return (
      <svg {...p}><path d="M17.5 15a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.4 8.5 3.75 3.75 0 0 0 7 15h10.5z" /><path d="M8.5 18.2h.01M12 20h.01M15.5 18.2h.01M10.2 20.6h.01M13.8 17.4h.01" strokeWidth="2.2" /></svg>
    );
    case 'storm': return (
      <svg {...p}><path d="M17.5 14a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.4 7.5 3.75 3.75 0 0 0 7 14h10.5z" /><path d="m12.8 14.5-2.3 3.7h3l-2.3 3.7" /></svg>
    );
    case 'fog': return (
      <svg {...p}><path d="M17.5 13a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.4 6.5 3.75 3.75 0 0 0 7 13h10.5z" /><path d="M5.5 16.5h13M7.5 19.5h9" /></svg>
    );
  }
};

const WeatherCard: React.FC<{ data: WeatherData }> = ({ data }) => {
  const { isZh } = useI18n();
  const cur = data.current || {};
  const kind = wxKind(cur.text);
  const temp = wxNum(cur.temp);
  const feels = wxNum(cur.feels_like);
  const humidity = wxNum(cur.humidity);
  const days = Array.isArray(data.forecast) ? data.forecast.filter(Boolean) : [];
  const todayHigh = wxNum(days[0]?.high);
  const todayLow = wxNum(days[0]?.low);

  /* Apple 式区间条: 全预报共享 min/max 刻度, 每天画自己的区间段 */
  const highs = days.map(d => wxNum(d.high)).filter((n): n is number => n !== null);
  const lows = days.map(d => wxNum(d.low)).filter((n): n is number => n !== null);
  const scaleMin = lows.length ? Math.min(...lows) : null;
  const scaleMax = highs.length ? Math.max(...highs) : null;
  const span = scaleMin !== null && scaleMax !== null ? Math.max(scaleMax - scaleMin, 1) : null;

  return (
    <div className={`ncard ncard--weather wx wx--${kind}`}>
      {(kind === 'rain' || kind === 'storm') && <div className="wx__precip wx__precip--rain" aria-hidden />}
      {kind === 'snow' && <div className="wx__precip wx__precip--snow" aria-hidden />}
      <div className="wx__inner">
        <div className="wx__hero">
          <div className="wx__loc">{data.location || '—'}</div>
          {temp !== null && <div className="wx__temp">{Math.round(temp)}°</div>}
          <div className="wx__cond">
            <WxIcon kind={kind} size={15} />
            <span>{cur.text || ''}</span>
            {todayHigh !== null && todayLow !== null && (
              <span className="wx__hl">{isZh
                ? `最高 ${Math.round(todayHigh)}° 最低 ${Math.round(todayLow)}°`
                : `H ${Math.round(todayHigh)}° L ${Math.round(todayLow)}°`}</span>
            )}
          </div>
        </div>

        {(feels !== null || humidity !== null || cur.wind) && (
          <div className="wx__stats">
            {feels !== null && <div className="wx__stat"><span className="wx__stat-k">{isZh ? '体感' : 'Feels like'}</span><span className="wx__stat-v">{Math.round(feels)}°</span></div>}
            {humidity !== null && <div className="wx__stat"><span className="wx__stat-k">{isZh ? '湿度' : 'Humidity'}</span><span className="wx__stat-v">{Math.round(humidity)}%</span></div>}
            {cur.wind && <div className="wx__stat"><span className="wx__stat-k">{isZh ? '风速' : 'Wind'}</span><span className="wx__stat-v">{cur.wind}</span></div>}
          </div>
        )}

        {days.length > 0 && (
          <div className="wx__forecast">
            {days.map((d, i) => {
              const hi = wxNum(d.high);
              const lo = wxNum(d.low);
              const rain = wxNum(d.rain_chance);
              const left = span !== null && lo !== null && scaleMin !== null ? ((lo - scaleMin) / span) * 100 : null;
              const width = left !== null && hi !== null && lo !== null && span !== null
                ? Math.min(Math.max(((hi - lo) / span) * 100, 6), 100 - left) : null;
              return (
                <div key={i} className="wx__day">
                  <span className="wx__day-name">{d.day || `D${i + 1}`}</span>
                  <span className="wx__day-icon">
                    <WxIcon kind={wxKind(d.text)} size={16} />
                    {rain !== null && rain >= 30 && <span className="wx__day-rain">{Math.round(rain)}%</span>}
                  </span>
                  <span className="wx__day-lo">{lo !== null ? `${Math.round(lo)}°` : '—'}</span>
                  <span className="wx__day-bar">
                    {left !== null && width !== null && (
                      <span className="wx__day-bar-fill" style={{ left: `${left}%`, width: `${width}%` }} />
                    )}
                  </span>
                  <span className="wx__day-hi">{hi !== null ? `${Math.round(hi)}°` : '—'}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

/* ---------- Todo ---------- */

interface TodoItem { text?: string; priority?: 'high' | 'medium' | 'low'; done?: boolean }

const TodoCard: React.FC<{ data: { title?: string; items?: TodoItem[] } }> = ({ data }) => {
  const { isZh } = useI18n();
  const items = Array.isArray(data.items) ? data.items : [];
  const highCount = items.filter((it) => it.priority === 'high').length;
  const doneCount = items.filter((it) => it.done).length;
  const theme = highCount > 0 ? 'urgent' : doneCount === items.length && items.length > 0 ? 'done' : 'plan';
  return (
    <div className={`ncard ncard--todo td td--${theme}`}>
      <div className="td__hero">
        <div className="td__hero-title">{data.title || (isZh ? '待办' : 'To-do')}</div>
        <div className="td__hero-meta">
          <span className="td__hero-chip">{isZh ? `${items.length} 项` : `${items.length} item${items.length === 1 ? '' : 's'}`}</span>
          {highCount > 0 && <span className="td__hero-chip td__hero-chip--warn">{isZh ? `${highCount} 高优` : `${highCount} high`}</span>}
          {doneCount > 0 && <span className="td__hero-chip td__hero-chip--done">{isZh ? `${doneCount} 完成` : `${doneCount} done`}</span>}
        </div>
      </div>
      <ul className="ncard-t td__list">
        {items.map((it, i) => (
          <li key={i} className={`ncard-t__it is-${it.priority || 'medium'}${it.done ? ' is-done' : ''}`}>
            <span className="ncard-t__check" aria-hidden />
            <span className="ncard-t__text">{it.text || '—'}</span>
            {it.priority === 'high' && <span className="ncard-t__badge">{isZh ? '高优' : 'High'}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
};

/* ---------- Compare table ---------- */

/** 单元格语义: 数字右对齐 · PASS/FAIL 上色 · 路径给 mono. 报告表格里这三种占九成 */
const cellClass = (cell: unknown): string => {
  const s = String(cell ?? '').trim();
  if (!s) return '';
  if (/^[+-]?[\d,.]+\s*(%|ms|s|k|kb|mb|次|个|条|行)?$/i.test(s)) return ' is-num';
  if (/^(pass|通过|ok|成功|done|已修)/i.test(s)) return ' is-good';
  if (/^(fail|失败|error|错误|未通过|阻塞|blocked)/i.test(s)) return ' is-bad';
  if (/^(warn|警告|部分|partial|待|todo)/i.test(s)) return ' is-warn';
  if (/[/\\].+\.\w{1,6}$/.test(s)) return ' is-path';
  return '';
};

const CompareCard: React.FC<{ data: { title?: string; columns?: string[]; rows?: any[][] } }> = ({ data }) => {
  const cols = Array.isArray(data.columns) ? data.columns : [];
  const rows = Array.isArray(data.rows) ? data.rows : [];
  return (
    <div className="ncard ncard--table">
      {data.title && <NCardHead glyph="stack" title={data.title} />}
      <div className="ncard-c__wrap">
        <table className="ncard-c">
          <thead>
            <tr>
              {cols.map((c, i) => <th key={i} className={i === 0 ? 'is-first' : undefined}>{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {(Array.isArray(r) ? r : []).map((cell, j) => {
                  const text = typeof cell === 'string' || typeof cell === 'number' ? String(cell) : JSON.stringify(cell);
                  return <td key={j} className={`${j === 0 ? 'is-first' : ''}${cellClass(text)}`}>{text}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/* ---------- News ---------- */

interface NewsItem {
  title?: string;
  source?: string;
  timestamp?: string;   // "2h ago" / ISO
  summary?: string;
  url?: string;
  thumbnail?: string;
  tag?: string;         // "热点" / "科技" / "体育"…
}

const NewsCard: React.FC<{ data: { title?: string; items?: NewsItem[] } }> = ({ data }) => {
  const { isZh } = useI18n();
  const items = Array.isArray(data.items) ? data.items : [];
  const sources = Array.from(new Set(items.map((n) => (n.source || '').trim()).filter(Boolean))).slice(0, 3);
  return (
    <div className="ncard ncard--news nw">
      <div className="nw__hero">
        <div className="nw__hero-title">{data.title || (isZh ? '资讯' : 'News')}</div>
        <div className="nw__hero-meta">
          <span className="nw__hero-chip">{isZh ? `${items.length} 条` : `${items.length} item${items.length === 1 ? '' : 's'}`}</span>
          {sources.map((s) => <span key={s} className="nw__hero-chip">{s}</span>)}
        </div>
      </div>
      <div className="ncard__list ncard__list--news nw__list">
        {items.map((n, i) => (
          <a
            key={i}
            className="ncard-n"
            href={n.url || '#'}
            target="_blank"
            rel="noopener noreferrer"
          >
            {n.thumbnail && (
              <img className="ncard-n__thumb" src={n.thumbnail} alt="" loading="lazy" />
            )}
            <div className="ncard-n__body">
              <div className="ncard-n__title">{n.title || '—'}</div>
              {n.summary && <div className="ncard-n__summary">{n.summary}</div>}
              <div className="ncard-n__meta">
                {n.tag && <span className="ncard-n__tag">{n.tag}</span>}
                {n.source && <span className="ncard-n__source">{n.source}</span>}
                {n.timestamp && <span className="ncard-n__ts">· {n.timestamp}</span>}
              </div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
};

/* ---------- Booking (train / flight / hotel) ---------- */

interface BookingOption {
  time?: string;         // "07:30 → 12:45"
  from?: string;         // 起点站/机场
  to?: string;
  duration?: string;     // "5h 15m"
  price?: string;        // "¥ 553.5"
  tag?: string;          // "有票" / "候补" / "特价"
  detail?: string;       // 车次号 / 航班号 / 酒店级别
  url?: string;          // 预订 URL
}
interface BookingData {
  type?: 'train' | 'flight' | 'hotel';
  title?: string;
  from?: string;
  to?: string;
  date?: string;
  options?: BookingOption[];
}

const BkIcon: React.FC<{ kind: string }> = ({ kind }) => {
  const p = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (kind === 'flight') return <svg {...p}><path d="M10.5 13.5 3 11l1.5-1.5L10 10l4.5-4.5a1.8 1.8 0 0 1 2.5 2.5L12.5 12l.5 5.5L11.5 19l-2.5-6.5z" /></svg>;
  if (kind === 'hotel') return <svg {...p}><path d="M3 20V6M3 16h18v4M7 12h10a4 4 0 0 1 4 4M7 12v4M7 9.5h.01" /></svg>;
  return <svg {...p}><rect x="5" y="4" width="14" height="13" rx="3" /><path d="M5 12h14M9 20l-1.5 2M15 20l1.5 2M9 8.5h6" /><path d="M8.5 15h.01M15.5 15h.01" /></svg>;
};

const BookingCard: React.FC<{ data: BookingData }> = ({ data }) => {
  const { isZh } = useI18n();
  const opts = Array.isArray(data.options) ? data.options : [];
  const kind = data.type ?? 'train';
  return (
    <div className={`ncard ncard--booking bk bk--${kind}`}>
      <div className="bk__inner">
        <div className="bk__top">
          <span className="bk__icon"><BkIcon kind={kind} /></span>
          {data.date && <span className="bk__date">{data.date}</span>}
        </div>
        <div className="bk__route">
          {data.from && data.to ? (
            <>
              <span className="bk__city">{data.from}</span>
              <svg className="bk__arrow" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 12h15m0 0-4-4m4 4-4 4" /></svg>
              <span className="bk__city">{data.to}</span>
            </>
          ) : (
            <span className="bk__city">{data.title || ''}</span>
          )}
        </div>
        {opts.length > 0 && (
          <ul className="bk__list">
            {opts.map((o, i) => (
              <li key={i} className="bk__row">
                <div className="bk__row-main">
                  {o.detail && <span className="bk__no">{o.detail}</span>}
                  <span className="bk__row-sub">
                    {o.time && <span className="bk__time">{o.time}</span>}
                    {o.duration && <span className="bk__dur">{o.duration}</span>}
                    {o.tag && <span className="bk__tag">{o.tag}</span>}
                  </span>
                </div>
                <div className="bk__row-right">
                  {o.price && <span className="bk__price">{o.price}</span>}
                  {o.url && <a className="bk__btn" href={o.url} target="_blank" rel="noopener noreferrer">{isZh ? '预订' : 'Book'}</a>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

/* ---------- Recipe ---------- */

interface RecipeIngredient {
  name?: string;
  amount?: string;
}
interface RecipeStep {
  text?: string;
  time?: string;   // "3 min" / "翻炒 2 分钟"
}
interface RecipeData {
  dish?: string;
  servings?: string;   // "2 人份"
  time?: string;       // "30 分钟"
  difficulty?: string; // "简单" / "中等" / "有难度"
  ingredients?: RecipeIngredient[];
  steps?: RecipeStep[];
  tips?: string[];
  sourceUrl?: string;
}

const RecipeCard: React.FC<{ data: RecipeData }> = ({ data }) => {
  const { isZh } = useI18n();
  const ing = Array.isArray(data.ingredients) ? data.ingredients : [];
  const st = Array.isArray(data.steps) ? data.steps : [];
  const tips = Array.isArray(data.tips) ? data.tips : [];
  const diff = (data.difficulty || '').toLowerCase();
  const theme = /难|hard/.test(diff) ? 'hard' : /中|medium/.test(diff) ? 'medium' : 'easy';
  return (
    <div className={`ncard ncard--recipe rp rp--${theme}`}>
      <div className="rp__hero">
        <div className="rp__hero-title">{data.dish || (isZh ? '菜谱' : 'Recipe')}</div>
        <div className="rp__hero-meta">
          {data.servings && <span className="rp__hero-chip">{data.servings}</span>}
          {data.time && <span className="rp__hero-chip">{data.time}</span>}
          {data.difficulty && <span className="rp__hero-chip">{data.difficulty}</span>}
        </div>
      </div>
      {ing.length > 0 && (
        <div className="ncard-rc__sect">
          <div className="ncard-rc__sect-title">{isZh ? '食材' : 'Ingredients'}</div>
          <ul className="ncard-rc__ing">
            {ing.map((i, k) => (
              <li key={k}>
                <span className="ncard-rc__ing-name">{i.name}</span>
                {i.amount && <span className="ncard-rc__ing-amt">{i.amount}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {st.length > 0 && (
        <div className="ncard-rc__sect">
          <div className="ncard-rc__sect-title">{isZh ? '步骤' : 'Steps'}</div>
          <ol className="ncard-rc__steps">
            {st.map((s, k) => (
              <li key={k}>
                <span className="ncard-rc__step-text">{s.text}</span>
                {s.time && <span className="ncard-rc__step-time">{s.time}</span>}
              </li>
            ))}
          </ol>
        </div>
      )}
      {tips.length > 0 && (
        <div className="ncard-rc__sect">
          <div className="ncard-rc__sect-title">{isZh ? '小贴士' : 'Tips'}</div>
          <ul className="ncard-rc__tips">
            {tips.map((t, k) => (<li key={k}>💡 {t}</li>))}
          </ul>
        </div>
      )}
      {data.sourceUrl && (
        <a className="ncard-rc__source" href={data.sourceUrl} target="_blank" rel="noopener noreferrer">
          {isZh ? '原文' : 'Source'}
        </a>
      )}
    </div>
  );
};

/* ---------- Tracking (物流) ---------- */

interface TrackingStep { time?: string; status?: string; location?: string; }
interface TrackingData {
  title?: string;
  carrier?: string;
  trackingNo?: string;
  status?: string;
  eta?: string;
  steps?: TrackingStep[];
  trackUrl?: string;
}
/* 沉浸重制: 状态定渐变 (在途暮蓝/签收青晨/异常晨橙) + 大字状态 + 进度轴 */
const trackingTheme = (status?: string): 'transit' | 'done' | 'alert' => {
  const t = status || '';
  if (/签收|送达|完成|delivered/i.test(t)) return 'done';
  if (/异常|退回|拦截|失败|exception|failed/i.test(t)) return 'alert';
  return 'transit';
};

const TrackingCard: React.FC<{ data: TrackingData }> = ({ data }) => {
  const { isZh } = useI18n();
  const steps = Array.isArray(data.steps) ? data.steps : [];
  const theme = trackingTheme(data.status);
  return (
    <div className={`ncard ncard--tracking tk tk--${theme}`}>
      <div className="tk__inner">
        <div className="tk__top">
          <span className="tk__icon" aria-hidden>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3 4 6.5v11L12 21l8-3.5v-11L12 3zM4 6.5l8 3.5m0 0 8-3.5M12 10v11" /></svg>
          </span>
          {data.carrier && <span className="tk__carrier">{data.carrier}</span>}
          {data.trackingNo && (
            <button type="button" className="tk__no" onClick={() => copyToClipboard(data.trackingNo!)} title={isZh ? '复制单号' : 'Copy tracking number'}>
              {data.trackingNo}
            </button>
          )}
        </div>
        <div className="tk__status">{data.status || data.title || (isZh ? '物流' : 'Shipment')}</div>
        {data.eta && <div className="tk__eta">{isZh ? `预计 ${data.eta} 送达` : `Estimated delivery ${data.eta}`}</div>}
        {steps.length > 0 && (
          <ol className="tk__steps">
            {steps.map((s, i) => (
              <li key={i} className={`tk__step${i === 0 ? ' is-latest' : ''}`}>
                <span className="tk__dot" aria-hidden />
                <div className="tk__step-body">
                  <div className="tk__step-status">{s.status || '—'}</div>
                  <div className="tk__step-meta">
                    {s.time && <span>{s.time}</span>}
                    {s.location && <span>{s.location}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
        {data.trackUrl && (
          <a className="tk__link" href={data.trackUrl} target="_blank" rel="noopener noreferrer">{isZh ? '在官网查看 ↗' : 'View on carrier site ↗'}</a>
        )}
      </div>
    </div>
  );
};

/* ---------- Trip (机票 / 高铁行程一体化) ---------- */

interface TripLeg {
  type?: 'flight' | 'train' | 'car' | 'ship';
  no?: string;
  from?: string;
  to?: string;
  depTime?: string;
  arrTime?: string;
  duration?: string;
  detail?: string;
  price?: string;
  status?: string;
}
interface TripData { title?: string; date?: string; legs?: TripLeg[]; url?: string; }
const LegGlyph: React.FC<{ type?: string }> = ({ type }) => {
  const p = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  switch (type) {
    case 'train': return <svg {...p}><rect x="5" y="4" width="14" height="13" rx="3" /><path d="M5 12h14M9 20l-1.5 2M15 20l1.5 2" /></svg>;
    case 'car': return <svg {...p}><path d="M5 16 6.5 9.5A2 2 0 0 1 8.4 8h7.2a2 2 0 0 1 1.9 1.5L19 16M4 16h16v4h-2.5M4 20h2.5M7.5 18.5h.01M16.5 18.5h.01" /></svg>;
    case 'ship': return <svg {...p}><path d="M4 18c1.5 1.5 3 1.5 4 0 1.5 1.5 3 1.5 4 0 1.5 1.5 3 1.5 4 0M6 15l-1-4 7-2 7 2-1 4M12 9V5h-2" /></svg>;
    default: return <svg {...p}><path d="M10.5 13.5 3 11l1.5-1.5L10 10l4.5-4.5a1.8 1.8 0 0 1 2.5 2.5L12.5 12l.5 5.5L11.5 19l-2.5-6.5z" /></svg>;
  }
};
const TripCard: React.FC<{ data: TripData }> = ({ data }) => {
  const { isZh } = useI18n();
  const legs = Array.isArray(data.legs) ? data.legs : [];
  return (
    <div className="ncard ncard--trip tp">
      <div className="tp__hero">
        <div className="tp__hero-title">{data.title || (isZh ? '行程' : 'Itinerary')}</div>
        {data.date && <div className="tp__hero-date">{data.date}</div>}
      </div>
      <ul className="tp__list">
        {legs.map((l, i) => (
          <li key={i} className="tp__leg">
            <span className="tp__leg-icon"><LegGlyph type={l.type} /></span>
            <div className="tp__leg-body">
              <div className="tp__leg-route">
                <span className="tp__leg-time">{l.depTime || '—'}</span>
                <span className="tp__leg-city">{l.from || ''}</span>
                <span className="tp__leg-arrow">→</span>
                <span className="tp__leg-time">{l.arrTime || '—'}</span>
                <span className="tp__leg-city">{l.to || ''}</span>
              </div>
              <div className="tp__leg-meta">
                {l.no && <span>{l.no}</span>}
                {l.duration && <span>{l.duration}</span>}
                {l.detail && <span>{l.detail}</span>}
                {l.status && <span className="tp__leg-status">{l.status}</span>}
              </div>
            </div>
            {l.price && <span className="tp__leg-price">{l.price}</span>}
          </li>
        ))}
      </ul>
      {data.url && (
        <div className="tp__actions">
          <a className="tp__action" href={data.url} target="_blank" rel="noopener noreferrer">{isZh ? '查看详情' : 'View details'}</a>
        </div>
      )}
    </div>
  );
};

/* ---------- Product (商品比价) ---------- */

interface ProductItem {
  name?: string;
  brand?: string;
  price?: string;
  originalPrice?: string;
  rating?: number;
  seller?: string;
  image?: string;
  url?: string;
  highlight?: string;
}
interface ProductData { title?: string; items?: ProductItem[]; }
const ProductCard: React.FC<{ data: ProductData }> = ({ data }) => {
  const items = Array.isArray(data.items) ? data.items : [];
  return (
    <div className="ncard">
      {data.title && <div className="ncard__title">{data.title}</div>}
      <div className="ncard-pd__list">
        {items.map((p, i) => (
          <a
            key={i}
            className="ncard-pd"
            href={p.url || '#'}
            target={p.url ? '_blank' : undefined}
            rel="noopener noreferrer"
          >
            {p.image && <img className="ncard-pd__img" src={p.image} alt={p.name || ''} loading="lazy" />}
            <div className="ncard-pd__body">
              <div className="ncard-pd__name">{p.name || '—'}</div>
              <div className="ncard-pd__meta">
                {p.brand && <span>{p.brand}</span>}
                {p.seller && <span>{p.seller}</span>}
                {typeof p.rating === 'number' && (
                  <span className="ncard-r__rating"><span>★</span>{p.rating.toFixed(1)}</span>
                )}
              </div>
              {p.highlight && <div className="ncard-pd__highlight">{p.highlight}</div>}
              <div className="ncard-pd__price-row">
                {p.price && <span className="ncard-pd__price">{p.price}</span>}
                {p.originalPrice && <s className="ncard-pd__orig">{p.originalPrice}</s>}
              </div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
};

/* ---------- Gallery (图片画廊) ---------- */

interface GalleryItem { url?: string; caption?: string; source?: string; sourceUrl?: string; }
interface GalleryData { title?: string; items?: GalleryItem[]; }
const GalleryCell: React.FC<{ item: GalleryItem }> = ({ item }) => {
  const [failed, setFailed] = React.useState(false);
  const showImg = !!item.url && !failed;
  return (
    <a
      className={`gl__cell${showImg ? '' : ' gl__cell--placeholder'}`}
      href={item.sourceUrl || item.url || '#'}
      target="_blank"
      rel="noopener noreferrer"
      title={item.caption || item.source || ''}
    >
      {showImg && (
        <img
          className="gl__img"
          src={item.url}
          alt={item.caption || ''}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      )}
      {!showImg && (
        <span className="gl__cell-fallback" aria-hidden>
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <circle cx="8.5" cy="9.5" r="1.5" />
            <path d="m21 16-5-5-9 9" />
          </svg>
        </span>
      )}
      {(item.caption || item.source) && (
        <span className="gl__caption">
          <span className="gl__caption-text">{item.caption || (item.source ?? '')}</span>
          {item.source && item.caption && <span className="gl__source">{item.source}</span>}
        </span>
      )}
    </a>
  );
};

const GalleryCard: React.FC<{ data: GalleryData }> = ({ data }) => {
  const { isZh } = useI18n();
  const items = Array.isArray(data.items) ? data.items : [];
  const sources = Array.from(new Set(items.map((i) => (i.source || '').trim()).filter(Boolean))).slice(0, 2);
  return (
    <div className="ncard ncard--gallery gl">
      <div className="gl__hero">
        <div className="gl__hero-title">{data.title || (isZh ? '图集' : 'Gallery')}</div>
        <div className="gl__hero-meta">
          <span className="gl__hero-chip">{isZh ? `${items.length} 张` : `${items.length} photo${items.length === 1 ? '' : 's'}`}</span>
          {sources.map((s) => <span key={s} className="gl__hero-chip">{s}</span>)}
        </div>
      </div>
      <div className="gl__grid">
        {items.map((it, i) => <GalleryCell key={i} item={it} />)}
      </div>
    </div>
  );
};

/* ---------- Summary — 任务总结卡 ---------- */

interface SummaryData {
  title?: string;
  status?: 'done' | 'partial' | 'blocked' | string;
  stats?: Array<{ label?: string; value?: string | number; tone?: string }>;
  sections?: Array<{ title?: string; items?: string[] }>;
  files?: Array<{ path?: string; add?: number | string; del?: number | string; note?: string }>;
}

const SUMMARY_STATUS: Record<string, { zh: string; en: string; tone: Tone }> = {
  done:    { zh: '已完成', en: 'Done',    tone: 'good' },
  partial: { zh: '部分完成', en: 'Partial', tone: 'warn' },
  blocked: { zh: '被阻塞', en: 'Blocked', tone: 'bad' },
};

function summarySizeLabel(stats: Array<{ label?: string; value?: string | number }>): string | undefined {
  for (const s of stats) {
    const v = String(s.value ?? '').trim();
    if (/^[\d.]+\s*[KMGT]?B$/i.test(v)) return v.replace(/\s+/g, '');
    if (/大小|size/i.test(String(s.label ?? '')) && /[0-9]/.test(v)) return v;
  }
  return undefined;
}

/* 刻度上限 —— 超过就按比例压缩。读数里报的仍是真数, 只有格子数被压。 */
const VIZ_MAX_TICKS = 44;

const SummaryViz: React.FC<{
  files: NonNullable<SummaryData['files']>;
  tone: Tone;
  /** 下面那行是否已经带了状态印记 —— 带了这里就不能再画一枚 */
  heroHasSeal: boolean;
}> = ({ files, tone, heroHasSeal }) => {
  const add = files.reduce((s, f) => s + numOf(f.add), 0);
  const del = files.reduce((s, f) => s + numOf(f.del), 0);
  const total = add + del;
  /* 压缩只动格子数, 不动读数 —— 读数是真值, 格子是它的形状 */
  const scale = total > VIZ_MAX_TICKS ? VIZ_MAX_TICKS / total : 1;
  const addTicks = Math.round(add * scale);
  const delTicks = Math.max(0, Math.round(total * scale) - addTicks);
  if (total <= 0) {
    if (heroHasSeal) return null;
    return <div className="nrpt__viz-seal" aria-hidden><NStatusSeal tone={tone} size={26} /></div>;
  }
  const ticks = [
    ...Array.from({ length: addTicks }, (_, i) => `a${i}`),
    ...Array.from({ length: delTicks }, (_, i) => `d${i}`),
  ];
  return (
    <div className="nrpt__viz-ticks" aria-hidden>
      {ticks.map((k) => <i key={k} className={k[0] === 'a' ? 'is-add' : 'is-del'} />)}
    </div>
  );
};

/** 统计条 — 数字 + 标签 + (能算出比例时) 细进度条. 卡片里复用 */
const NStatStrip: React.FC<{ items: Array<{ label?: string; value?: string | number; tone?: string; delta?: string | number }> }> = ({ items }) => (
  <div className="nstats">
    {items.map((s, i) => {
      const tone = normTone(s.tone);
      const r = ratioOf(s.value);
      const delta = s.delta != null && String(s.delta) !== '' ? String(s.delta) : null;
      const up = delta ? /^\+|↑|up/i.test(delta) : false;
      const down = delta ? /^-|↓|down/i.test(delta) : false;
      return (
        <div key={i} className={`nstats__cell is-${tone}`}>
          <div className="nstats__val">
            <span>{String(s.value ?? '—')}</span>
            {delta && (
              <span className={`nstats__delta${up ? ' is-up' : down ? ' is-down' : ''}`}>
                {up ? '▲' : down ? '▼' : ''}{delta.replace(/^[+-]/, '')}
              </span>
            )}
          </div>
          <div className="nstats__lbl">{s.label || '—'}</div>
          {r !== null && <NBar ratio={r} tone={tone} />}
        </div>
      );
    })}
  </div>
);

/** 超过这个条数, 章节默认收成一行折叠头 —— 2 条以内直接铺开, 不为省 2 行让人多点一次 */
const NSEC_COLLAPSE_AT = 2;

const NSectionList: React.FC<{ title?: string; items: string[]; glyph?: GlyphName }> = ({ title, items, glyph }) => {
  const headGlyph = glyph ?? classifyGlyph(title || '', 'stack');
  const collapsible = !!title && items.length > NSEC_COLLAPSE_AT;
  const [open, setOpen] = React.useState(false);
  const shown = collapsible && !open ? [] : items;
  return (
    <div className="nsec">
      {title && (
        <div
          className={`nsec__title${collapsible ? ' is-toggle' : ''}${open ? ' is-open' : ''}`}
          role={collapsible ? 'button' : undefined}
          tabIndex={collapsible ? 0 : undefined}
          aria-expanded={collapsible ? open : undefined}
          onClick={collapsible ? () => setOpen(v => !v) : undefined}
          onKeyDown={collapsible ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(v => !v); } } : undefined}
        >
          <NGlyph name={headGlyph} size={12} />
          <span>{title}</span>
          {collapsible && <span className="nsec__count">{items.length}</span>}
          {collapsible && <span className="nsec__chev" aria-hidden>›</span>}
        </div>
      )}
      <ul className="nsec__list">
        {shown.map((it, j) => {
          const text = typeof it === 'string' ? it : JSON.stringify(it);
          const g = classifyGlyph(text, headGlyph === 'stack' ? 'chevron' : headGlyph);
          return (
            <li key={j} className={`nsec__it is-${g}`}>
              <span className="nsec__it-glyph" aria-hidden><NGlyph name={g} size={13} /></span>
              <span className="nsec__it-text">{text}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};


/** 从一行文本里认出"路径 — 说明" (交付物那一段就是这个形状) */
function splitPathNote(text: string): { path?: string; note: string } {
  const m = /^([\w./@-]+\.[a-zA-Z0-9]+)\s*[—\-–:]\s*(.+)$/.exec(text.trim());
  if (m) return { path: m[1], note: m[2] };
  return { note: text };
}
const looksLikeFileSection = (items: string[]) =>
  items.length > 0 && items.filter((t) => splitPathNote(String(t)).path).length / items.length >= 0.6;

/** 一段: 默认一行 (标题 + 计数 + ›), 点开才铺内容 */
const RptSection: React.FC<{ title: string; items: string[]; defaultOpen?: boolean }> = ({ title, items, defaultOpen }) => {
  const [open, setOpen] = React.useState(!!defaultOpen);
  const isFiles = looksLikeFileSection(items);
  return (
    <div className={`nrpt__sec${open ? ' is-open' : ''}`}>
      <button type="button" className="nrpt__sec-h" onClick={() => setOpen((v) => !v)} aria-expanded={open} title={title}>
        <span className="nrpt__sec-t">{title}</span>
        <span className="nrpt__sec-n">{items.length}</span>
        <span className="nrpt__sec-c" aria-hidden>{open ? '▾' : '›'}</span>
      </button>
      {open && (isFiles ? (
        <div className="nrpt__files">
          {items.map((t, j) => {
            const { path, note } = splitPathNote(String(t));
            return path ? (
              <button key={j} type="button" className="nrpt__file" title={`${path}${note ? ` — ${note}` : ''}`} onClick={() => openPath(path)}>
                {path}
              </button>
            ) : (
              <span key={j} className="nrpt__file is-plain" title={note}>{note}</span>
            );
          })}
        </div>
      ) : (
        <ul className="nrpt__lines">
          {items.map((t, j) => <li key={j}>{String(t)}</li>)}
        </ul>
      ))}
    </div>
  );
};

const SummaryCard: React.FC<{ data: SummaryData }> = ({ data }) => {
  const { isZh } = useI18n();
  const stats = Array.isArray(data.stats) ? data.stats : [];
  const sections = (Array.isArray(data.sections) ? data.sections : [])
    .map((sec) => ({ title: String(sec.title ?? (isZh ? '明细' : 'Details')), items: (Array.isArray(sec.items) ? sec.items : []).map(String) }))
    .filter((sec) => sec.items.length > 0);
  const files = Array.isArray(data.files) ? data.files : [];
  const st = SUMMARY_STATUS[String(data.status ?? '').toLowerCase()];
  const tone: Tone = st?.tone ?? 'info';
  const sizeLabel = summarySizeLabel(stats);
  const footFiles = files.length > 1 ? files : [];

  const changeTotal = files.reduce((s, f) => s + numOf(f.add) + numOf(f.del), 0);
  const hasVisualPayload = files.length > 1 || changeTotal > 0 || !!sizeLabel;
  if (!hasVisualPayload) return null;
  /* 单文件时它的图标和增删数并进标题行; 多文件时标题行只报总数, 明细留给底栏 */
  const heroPath = files.length === 1 ? String(files[0]?.path ?? '') : '';
  const heroAdd = files.reduce((s, f) => s + numOf(f.add), 0);
  const heroDel = files.reduce((s, f) => s + numOf(f.del), 0);
  const openHeroFile = () => {
    if (heroPath) window.dispatchEvent(new CustomEvent('neox:open-path', { detail: { path: heroPath } }));
  };

  return (
    <div className={`ncard ncard--summary nrpt is-${tone}`}>
      {/* 插图在上、说明在下 —— 这才是 Word 里那块"对象", 不是又一行字. */}
      <SummaryViz files={files} tone={tone} heroHasSeal={!!st} />
      <div className="nrpt__hero">
        {heroPath && (
          <span
            className="nrpt__hero-icon"
            role="button"
            tabIndex={0}
            title={heroPath}
            onClick={openHeroFile}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openHeroFile(); } }}
          >
            <FileTypeIcon path={heroPath} size={15} />
          </span>
        )}
        <span className="nrpt__title">{data.title || (isZh ? '交付报告' : 'Delivery')}</span>
        {st && (
          <span className={`nrpt__status is-${tone}`}>
            <NStatusSeal tone={tone} />
            {isZh ? st.zh : st.en}
          </span>
        )}
        {(heroAdd > 0 || heroDel > 0 || sizeLabel) && (
          <span className="nrpt__nums">
            {heroAdd > 0 && <b className="is-add">+{heroAdd}</b>}
            {heroDel > 0 && <b className="is-del">−{heroDel}</b>}
            {sizeLabel && <span className="nrpt__size">{sizeLabel}</span>}
          </span>
        )}
        {sections.length > 0 && (
          <span className="nrpt__secs">
            {sections.map((sec, i) => <RptSection key={i} title={sec.title} items={sec.items} />)}
          </span>
        )}
      </div>

      {footFiles.length > 0 && (
        <div className="nrpt__foot">
          <div className="nrpt__files">
          {footFiles.map((f, i) => {
            const add = numOf(f.add); const del = numOf(f.del);
            const path = String(f.path ?? '—');
            const open = () => window.dispatchEvent(new CustomEvent('neox:open-path', { detail: { path } }));
            return (
              <button
                key={i}
                type="button"
                className="nrpt__f"
                title={f.note ? `${path} — ${f.note}` : path}
                onClick={open}
              >
                <span className="nrpt__f-icon" aria-hidden><FileTypeIcon path={path} size={13} /></span>
                <span className="nrpt__f-path">
                  <span className="nrpt__f-dir">{dirOf(path)}</span>
                  <span className="nrpt__f-name">{baseOf(path)}</span>
                </span>
                <span className="nrpt__f-num">
                  <i className="is-add">{add > 0 ? `+${add}` : ''}</i>
                  <i className="is-del">{del > 0 ? `−${del}` : ''}</i>
                  {add === 0 && del === 0 && <i className="is-none">—</i>}
                </span>
              </button>
            );
          })}
          </div>
        </div>
      )}
    </div>
  );
};

/* ---------- Diff — 文件改动清单 (summary 内复用) ---------- */

const FileChangeList: React.FC<{ files: NonNullable<SummaryData['files']> }> = ({ files }) => {
  const max = Math.max(1, ...files.map((f) => numOf(f.add) + numOf(f.del)));
  return (
    <div className="nsum__files">
      {files.map((f, i) => {
        const add = numOf(f.add);
        const del = numOf(f.del);
        const path = String(f.path ?? '—');
        return (
          <div
            key={i}
            className="nsum__file"
            role="button"
            tabIndex={0}
            title={path}
            /* 复用 Markdown inline code 那条链路: 上层 NeoxRuntimeBridge 监听后在右栏打开 */
            onClick={() => window.dispatchEvent(new CustomEvent('neox:open-path', { detail: { path } }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                window.dispatchEvent(new CustomEvent('neox:open-path', { detail: { path } }));
              }
            }}
          >
            <span className="nsum__file-icon" aria-hidden><FileTypeIcon path={path} size={13} /></span>
            <span className="nsum__file-path">
              <span className="nsum__file-dir">{dirOf(path)}</span>
              <span className="nsum__file-name">{baseOf(path)}</span>
            </span>
            {f.note && <span className="nsum__file-note">{f.note}</span>}
            <span className="nsum__file-bar" aria-hidden>
              <i className="nsum__file-bar-add" style={{ flexGrow: add }} />
              <i className="nsum__file-bar-del" style={{ flexGrow: del }} />
              {/* 占位: add/del 都是 0 时 flexGrow 全 0, 条会塌成 0 宽 */}
              <i className="nsum__file-bar-pad" style={{ flexGrow: Math.max(0, max - add - del) }} />
            </span>
            <span className="nsum__file-num">
              {add > 0 && <span className="is-add">+{add}</span>}
              {del > 0 && <span className="is-del">-{del}</span>}
              {add === 0 && del === 0 && <span className="is-none">—</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
};

const DiffCard: React.FC<{ data: { title?: string; files?: SummaryData['files'] } }> = ({ data }) => {
  const { isZh } = useI18n();
  const files = Array.isArray(data.files) ? data.files : [];
  return (
    <div className="ncard ncard--summary nsum">
      <NCardHead
        glyph="git"
        title={data.title || (isZh ? '改动' : 'Changes')}
        right={<span className="npill is-info">{isZh ? `${files.length} 个文件` : `${files.length} file${files.length === 1 ? '' : 's'}`}</span>}
      />
      {files.length > 0 && <FileChangeList files={files} />}
    </div>
  );
};

/* ---------- Metrics — KPI 数字条 ---------- */

const MetricsCard: React.FC<{ data: { title?: string; items?: Array<{ label?: string; value?: string | number; delta?: string | number; tone?: string }> } }> = ({ data }) => {
  const items = Array.isArray(data.items) ? data.items : [];
  return (
    <div className="ncard ncard--metrics nmet">
      {data.title && <NCardHead glyph="chart" title={data.title} />}
      {items.length > 0 && <NStatStrip items={items} />}
    </div>
  );
};

/* ---------- Steps — 步骤 / 流程 ---------- */

const STEP_STATUS = ['done', 'active', 'todo', 'failed'] as const;
type StepStatus = typeof STEP_STATUS[number];
const normStep = (v: unknown): StepStatus => {
  const s = String(v ?? '').toLowerCase();
  return (STEP_STATUS as readonly string[]).includes(s) ? (s as StepStatus) : 'todo';
};

const StepsCard: React.FC<{ data: { title?: string; items?: Array<{ title?: string; desc?: string; status?: string }> } }> = ({ data }) => {
  const items = Array.isArray(data.items) ? data.items : [];
  const doneN = items.filter((it) => normStep(it.status) === 'done').length;
  return (
    <div className="ncard ncard--steps nstep">
      {data.title && (
        <NCardHead
          glyph="flow"
          title={data.title}
          right={items.length ? <span className="npill is-info">{doneN}/{items.length}</span> : null}
        />
      )}
      <ol className="nstep__list">
        {items.map((it, i) => {
          const st = normStep(it.status);
          return (
            <li key={i} className={`nstep__it is-${st}`}>
              <span className="nstep__marker" aria-hidden>
                {st === 'done' ? <NGlyph name="check" size={11} strokeWidth={2} />
                  : st === 'failed' ? <NGlyph name="cross" size={11} strokeWidth={2} />
                  : <span className="nstep__marker-n">{i + 1}</span>}
              </span>
              <div className="nstep__body">
                <div className="nstep__title">{it.title || '—'}</div>
                {it.desc && <div className="nstep__desc">{it.desc}</div>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
};

/* ---------- Callout — 提示 / 警告框 ---------- */

const CalloutCard: React.FC<{ data: { tone?: string; title?: string; text?: string } }> = ({ data }) => {
  const tone = normTone(data.tone);
  return (
    <div className={`ncard ncard--callout ncall is-${tone}`}>
      <span className="ncall__icon" aria-hidden><NGlyph name={TONE_GLYPH[tone]} size={15} /></span>
      <div className="ncall__body">
        {data.title && <div className="ncall__title">{data.title}</div>}
        {data.text && <div className="ncall__text">{data.text}</div>}
      </div>
    </div>
  );
};

interface FlowNode { id?: string; label?: string; tone?: string; note?: string }
interface FlowEdge { from?: string; to?: string; label?: string }

const FlowCard: React.FC<{ data: { title?: string; nodes?: FlowNode[]; edges?: FlowEdge[] } }> = ({ data }) => {
  const { isZh } = useI18n();
  const nodes = (Array.isArray(data.nodes) ? data.nodes : []).map((n, i) => ({
    id: String(n.id ?? i),
    label: String(n.label ?? n.id ?? ''),
    tone: normTone(n.tone),
    note: n.note ? String(n.note) : '',
  }));
  const edges = (Array.isArray(data.edges) ? data.edges : []).map((e) => ({
    from: String(e.from ?? ''), to: String(e.to ?? ''), label: e.label ? String(e.label) : '',
  }));
  if (!nodes.length) return null;

  /* 按边分层 (拓扑深度) —— 没有边就当一条线 */
  const depth = new Map<string, number>();
  nodes.forEach((n) => depth.set(n.id, 0));
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false;
    for (const e of edges) {
      const d = (depth.get(e.from) ?? 0) + 1;
      if (depth.has(e.to) && d > (depth.get(e.to) ?? 0)) { depth.set(e.to, d); moved = true; }
    }
    if (!moved) break;
  }
  const layers: typeof nodes[] = [];
  nodes.forEach((n, i) => {
    const d = edges.length ? (depth.get(n.id) ?? 0) : i;
    (layers[d] ||= []).push(n);
  });
  const used = layers.filter(Boolean);
  const linear = used.length > 1 && used.every((l) => l.length === 1);

  return (
    <div className="ncard ncard--flow nflow">
      {data.title && <NCardHead glyph="flow" title={data.title} />}
      <div className={`nflow__body${linear ? ' is-linear' : ''}`}>
        {used.map((layer, li) => (
          <React.Fragment key={li}>
            <div className="nflow__layer">
              {layer.map((n) => (
                <div key={n.id} className={`nflow__node is-${n.tone}`} title={n.note || n.label}>
                  <span className="nflow__node-glyph" aria-hidden><NGlyph name={classifyGlyph(n.label, 'target')} size={13} /></span>
                  <span className="nflow__node-text">
                    <span className="nflow__node-label">{n.label || '—'}</span>
                    {n.note && <span className="nflow__node-note">{n.note}</span>}
                  </span>
                </div>
              ))}
            </div>
            {li < used.length - 1 && (
              <div className="nflow__arrow" aria-hidden>
                {/* 竖排时箭头朝下, 横排时朝右 —— 同一枚图形转 -90°, 不另画一个 */}
                <svg viewBox="0 0 24 16" width="20" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 1.5v9M12 14.5 8.5 10.5M12 14.5l3.5-4" />
                </svg>
              </div>
            )}
          </React.Fragment>
        ))}
      </div>
      {edges.some((e) => e.label) && (
        <div className="nflow__edges">
          {edges.filter((e) => e.label).map((e, i) => (
            <span key={i} className="nflow__edge">{e.from} → {e.to}: {e.label}</span>
          ))}
        </div>
      )}
      {!used.length && <div className="nchart__empty">{isZh ? '暂无节点' : 'No nodes'}</div>}
    </div>
  );
};

/* ---------- Timeline — 事件轴 (审计/排障复盘常用) ---------- */
const TimelineCard: React.FC<{
  data: { title?: string; size?: string; items?: Array<{ time?: string; title?: string; desc?: string; tone?: string }> };
}> = ({ data }) => {
  const items = Array.isArray(data.items) ? data.items : [];
  const report = String(data.size ?? '') === 'report';
  return (
    <div className={`ncard ncard--tl ntl${report ? ' ntl--rail' : ''}`}>
      {data.title && <NCardHead glyph="clock" title={data.title} />}
      <ol className="ntl__list">
        {items.map((it, i) => {
          const tone = normTone(it.tone);
          const title = String(it.title ?? '');
          const edge = report && (i === 0 || i === items.length - 1);
          return (
            <li key={i} className={`ntl__it is-${tone}${edge ? ' is-edge' : ''}`}>
              {report && <span className="ntl__when">{it.time || ''}</span>}
              <span className="ntl__glyph" aria-hidden><NGlyph name={classifyGlyph(title, TONE_GLYPH[tone])} size={12} /></span>
              <div className="ntl__body">
                <div className="ntl__l1">
                  <span className="ntl__title">{title || '—'}</span>
                  {!report && it.time && <span className="ntl__time">{it.time}</span>}
                </div>
                {it.desc && <div className="ntl__desc">{it.desc}</div>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
};

interface ReportData {
  title?: string;
  path?: string;
  summary?: string;
  kind?: string;                 // audit / test / research / release …
  meta?: Array<{ label?: string; value?: string | number }>;
  stats?: Array<{ label?: string; value?: string | number; tone?: string }>;
  highlights?: string[];
  files?: Array<{ path?: string; note?: string }>;
}

const REPORT_KIND_GLYPH: Record<string, GlyphName> = {
  audit: 'search', security: 'shield', test: 'test', perf: 'bolt', research: 'search',
  release: 'rocket', design: 'stack', analysis: 'chart', incident: 'alert', review: 'eye',
};

const openPath = (path: string) => {
  if (!path || typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('neox:open-path', { detail: { path } }));
};

const autoOpened = new Set<string>();
function useAutoOpenReport(path: string) {
  React.useEffect(() => {
    if (!path || autoOpened.has(path)) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    autoOpened.add(path);
    const t = window.setTimeout(() => openPath(path), 700);
    return () => window.clearTimeout(t);
  }, [path]);
}

const ReportCard: React.FC<{ data: ReportData }> = ({ data }) => {
  const { isZh } = useI18n();
  const path = String(data.path ?? '');
  const stats = Array.isArray(data.stats) ? data.stats : [];
  const highlights = (Array.isArray(data.highlights) ? data.highlights : []).map(String);
  const meta = Array.isArray(data.meta) ? data.meta : [];
  const files = Array.isArray(data.files) ? data.files : [];
  const glyph = REPORT_KIND_GLYPH[String(data.kind ?? '').toLowerCase()] ?? 'report';
  const open = () => openPath(path);
  useAutoOpenReport(path);

  return (
    <div className="ncard ncard--report nrep">
      <div
        className={`nrep__main${path ? ' is-clickable' : ''}`}
        role={path ? 'button' : undefined}
        tabIndex={path ? 0 : undefined}
        title={path ? (isZh ? `打开报告: ${path}` : `Open report: ${path}`) : undefined}
        onClick={path ? open : undefined}
        onKeyDown={path ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } } : undefined}
      >
        <span className="nrep__mark" aria-hidden>
          <NGlyph name={glyph} size={20} strokeWidth={1.4} />
        </span>
        <div className="nrep__text">
          <div className="nrep__title">{data.title || (isZh ? '报告' : 'Report')}</div>
          {data.summary && <div className="nrep__summary">{data.summary}</div>}
          <div className="nrep__meta">
            {path && (
              <span className="nrep__path">
                <FileTypeIcon path={path} size={11} />
                <span>{shortPath(path)}</span>
              </span>
            )}
            {meta.map((m, i) => (
              <span key={i} className="nrep__meta-it"><b>{m.label}</b>{String(m.value ?? '')}</span>
            ))}
          </div>
        </div>
        {path && (
          <span className="nrep__open" aria-hidden>
            {isZh ? '打开' : 'Open'}
            <NGlyph name="chevron" size={12} />
          </span>
        )}
      </div>

      {stats.length > 0 && <NStatStrip items={stats} />}

      {highlights.length > 0 && <NSectionList title={isZh ? '关键结论' : 'Key findings'} items={highlights} glyph="spark" />}

      {files.length > 0 && (
        <div className="nrep__files">
          {files.map((f, i) => {
            const p = String(f.path ?? '');
            return (
              <button
                key={i}
                type="button"
                className="nrep__file"
                onClick={() => openPath(p)}
                title={p}
              >
                <FileTypeIcon path={p} size={12} />
                <span className="nrep__file-name">{baseOf(p)}</span>
                {f.note && <span className="nrep__file-note">{f.note}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};


/** 从 URL 里取出可读的站点名: `www.` 剥掉, 只留 host */
function hostOf(url: string): string {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return url.replace(/^https?:\/\//, '').split('/')[0]; }
}
/** URL 路径末段当兜底标题 (`/docs/hooks-reference` → `hooks-reference`) */
function pathTitleOf(url: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean);
    /* 代码托管站: owner/repo 才是这个地址的名字, 不是最后一段 (`next.js` → `vercel/next.js`) */
    if (/^(github\.com|gitlab\.com|gitee\.com|bitbucket\.org)$/.test(u.host.replace(/^www\./, '')) && segs.length >= 2) {
      return `${segs[0]}/${segs[1]}`;
    }
    const seg = segs.pop() ?? '';
    return decodeURIComponent(seg).replace(/[-_]+/g, ' ').replace(/\.[a-z0-9]{1,5}$/i, '');
  } catch { return ''; }
}

/** 站点图标: 先试 favicon 服务, 挂了就落到字母印记 —— 印记是确定的, 服务是尽力的 */
const SiteMark: React.FC<{ url: string; host: string; icon?: string }> = ({ url, host, icon }) => {
  const [broken, setBroken] = React.useState(false);
  const letter = (host[0] || '?').toUpperCase();
  if (broken || !/^https?:/.test(url)) return <span className="ninset__mark ninset__mark--letter" aria-hidden>{letter}</span>;
  return (
    <img
      className="ninset__mark"
      src={icon || `https://icons.duckduckgo.com/ip3/${host}.ico`}
      alt=""
      width={16} height={16}
      loading="lazy"
      onError={() => setBroken(true)}
    />
  );
};

interface LinkData { url?: string; title?: string; desc?: string; description?: string; image?: string; site?: string; icon?: string; wide?: boolean }

interface LinkPreviewLite { ok: boolean; title?: string; description?: string; image?: string; icon?: string; site?: string }

/* 渲染层的预览缓存: 同一个链接在流式重排里会被渲染很多次, IPC 那边有缓存, 这边也别每次 invoke */
const linkPreviewCache = new Map<string, LinkPreviewLite | Promise<LinkPreviewLite>>();
function loadLinkPreview(url: string): Promise<LinkPreviewLite> {
  const hit = linkPreviewCache.get(url);
  if (hit) return Promise.resolve(hit);
  const api = (typeof window !== 'undefined' ? (window as any).neox : null) as { linkPreview?: (u: string) => Promise<LinkPreviewLite> } | null;
  if (!api?.linkPreview) return Promise.resolve({ ok: false });
  const p = api.linkPreview(url).then((v) => { linkPreviewCache.set(url, v ?? { ok: false }); return v ?? { ok: false }; })
    .catch(() => { const v = { ok: false }; linkPreviewCache.set(url, v); return v; });
  linkPreviewCache.set(url, p);
  return p;
}

const LinkCard: React.FC<{ data: LinkData }> = ({ data }) => {
  const url = String(data.url ?? '').trim();
  const host = hostOf(url);
  const [pv, setPv] = React.useState<LinkPreviewLite | null>(() => {
    const c = linkPreviewCache.get(url);
    return c && !(c instanceof Promise) ? c : null;
  });
  const needFetch = !!url && /^https?:/.test(url) && !(data.title && data.image);
  React.useEffect(() => {
    if (!needFetch) return;
    let alive = true;
    void loadLinkPreview(url).then((v) => { if (alive) setPv(v); });
    return () => { alive = false; };
  }, [url, needFetch]);

  const asPlain = (v: unknown, max: number): string => String(v ?? '')
    /* eslint-disable-next-line no-control-regex */
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

  const title = asPlain(data.title, 120) || asPlain(pv?.title, 120) || pathTitleOf(url) || host;
  const desc = asPlain(data.desc ?? data.description, 200) || asPlain(pv?.description, 200);
  const okImg = (s: unknown) => typeof s === 'string' && /^(https?:|data:|neox-asset:)/.test(s) ? s : '';
  const image = okImg(data.image) || okImg(pv?.image);
  const icon = okImg(data.icon) || okImg(pv?.icon);
  /* 站点名: 真实 host 优先 —— 对方声明的名字只在算不出 host 时才用 (见上面第 1 条) */
  const site = host || asPlain(data.site, 60) || asPlain(pv?.site, 60);
  const [imgBroken, setImgBroken] = React.useState(false);
  const hasImage = !!image && !imgBroken;

  if (!hasImage && !data.wide) {
    return (
      <a className="ncard ncard--link ninset is-strip" href={url || undefined} target="_blank" rel="noopener noreferrer" title={url}>
        <SiteMark url={url} host={host} icon={icon} />
        <span className="ninset__strip-site">{site}</span>
        <span className="ninset__strip-title">{title}</span>
        {desc && <span className="ninset__strip-desc">{desc}</span>}
      </a>
    );
  }
  /* 有预览图: 无边框、有质感的小卡 —— 图在上, 站点 / 标题 / 一句描述在下, 浮在正文旁 */
  return (
    <a
      className={`ncard ncard--link ninset has-image${data.wide ? ' is-wide' : ''}`}
      href={url || undefined}
      target="_blank"
      rel="noopener noreferrer"
      title={url}
    >
      <span className="ninset__thumb"><img src={image} alt="" loading="lazy" onError={() => setImgBroken(true)} /></span>
      <span className="ninset__body">
        <span className="ninset__site"><SiteMark url={url} host={host} icon={icon} /><span className="ninset__site-name">{site}</span></span>
        <span className="ninset__title">{title}</span>
        {desc && <span className="ninset__desc">{desc}</span>}
      </span>
    </a>
  );
};

interface ImageData { src?: string; alt?: string; caption?: string; href?: string; wide?: boolean; w?: number; h?: number }

const ImageCard: React.FC<{ data: ImageData }> = ({ data }) => {
  const { isZh } = useI18n();
  const src = String(data.src ?? '').trim();
  const ok = /^(https?:|data:|neox-asset:|blob:)/.test(src);
  const caption = String(data.caption ?? '').trim();
  const alt = String(data.alt ?? caption ?? '').trim();
  const href = typeof data.href === 'string' && /^https?:/.test(data.href) ? data.href : (/^https?:/.test(src) ? src : undefined);
  const [failed, setFailed] = React.useState(false);
  /* 已知宽高就先占位, 图片到达时版面不跳 (绕排的正文行框会随高度重排, 跳一下很刺眼) */
  const w0 = numOf(data.w), h0 = numOf(data.h);
  const [natural, setNatural] = React.useState<{ w: number; h: number } | null>(null);
  const ratio = w0 > 0 && h0 > 0 ? `${w0} / ${h0}` : undefined;
  const aspect = w0 > 0 && h0 > 0 ? w0 / h0 : natural ? natural.w / natural.h : 0;
  const wide = !!data.wide || aspect >= 1.7;
  const Frame: React.ElementType = href ? 'a' : 'span';
  return (
    <figure className={`ncard ncard--image ninset${wide ? ' is-wide' : ''}`}>
      <Frame className="ninset__pic" {...(href ? { href, target: '_blank', rel: 'noopener noreferrer' } : {})} style={ratio && !wide ? { aspectRatio: ratio } : undefined}>
        {ok && !failed
          ? (
            <img
              src={src} alt={alt} loading="lazy"
              onError={() => setFailed(true)}
              onLoad={(e) => { const im = e.currentTarget; if (im.naturalWidth && im.naturalHeight) setNatural({ w: im.naturalWidth, h: im.naturalHeight }); }}
            />
          )
          : <span className="ninset__pic-empty">{isZh ? '图片加载失败' : 'Image unavailable'}</span>}
      </Frame>
      {caption && <figcaption className="ninset__cap">{caption}</figcaption>}
    </figure>
  );
};

interface VideoData { src?: string; poster?: string; title?: string; duration?: string; wide?: boolean }

/** 直链 (mp4/webm/mov/m3u8) 内嵌播放; 站点视频 (YouTube / B 站 / Vimeo) 只能开外部 */
function isDirectVideo(src: string): boolean {
  return /\.(mp4|webm|mov|m4v|ogv)(\?|$)/i.test(src) || /^(data:video|blob:|neox-asset:)/.test(src);
}

const VideoCard: React.FC<{ data: VideoData }> = ({ data }) => {
  const src = String(data.src ?? '').trim();
  const poster = typeof data.poster === 'string' && /^(https?:|data:|neox-asset:)/.test(data.poster) ? data.poster : undefined;
  const title = String(data.title ?? '').trim() || pathTitleOf(src) || hostOf(src);
  const duration = String(data.duration ?? '').trim();
  const [playing, setPlaying] = React.useState(false);
  const direct = isDirectVideo(src);
  const host = hostOf(src);
  return (
    <figure className={`ncard ncard--video ninset${data.wide ? ' is-wide' : ''}`}>
      {direct && playing ? (
        <video className="ninset__video" src={src} poster={poster} controls autoPlay playsInline />
      ) : (
        <a
          className="ninset__pic ninset__pic--video"
          href={direct ? undefined : (src || undefined)}
          {...(direct ? {} : { target: '_blank', rel: 'noopener noreferrer' })}
          onClick={direct ? (e) => { e.preventDefault(); setPlaying(true); } : undefined}
          title={src}
        >
          {poster ? <img src={poster} alt="" loading="lazy" /> : <span className="ninset__pic-void" aria-hidden />}
          <span className="ninset__play" aria-hidden>
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></svg>
          </span>
          {duration && <span className="ninset__dur">{duration}</span>}
        </a>
      )}
      <figcaption className="ninset__cap">
        <span className="ninset__cap-title">{title}</span>
        {!direct && host && <span className="ninset__cap-site">{host}</span>}
      </figcaption>
    </figure>
  );
};

export default NeoxCard;
