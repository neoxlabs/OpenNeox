import React, { useEffect, useMemo, useState } from 'react';
import { formatSessionTime } from '../../../app/sessionItemMapping';
import * as S from '../../shell/shellIcons';
import { ART, weatherArt } from './art';
import {
  dataApi, fileBadge, fmtSize, savePlace, tileAt, timezoneCityGuess, weatherWord,
  type MadeFile, type PhoneState, type PilotFile, type Place, type Weather,
} from './boardData';

const tr = (isZh: boolean) => (zh: string, en: string) => (isZh ? zh : en);

function useNow(stepMs = 15_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const h = window.setInterval(() => setNow(Date.now()), stepMs); return () => window.clearInterval(h); }, [stepMs]);
  return now;
}

/* ───────── 今天: 时钟 + 日期 + 天气 + 下一件事 ───────── */
export const TodayWidget: React.FC<{
  isZh: boolean;
  place: Place | null;
  weather: Weather | null;
  busy: boolean;
  statusLine: string;
  next?: { when: string; title: string } | null;
  onWeather: () => void;
}> = ({ isZh, place, weather, busy, statusLine, next, onWeather }) => {
  const t = tr(isZh);
  const now = new Date(useNow());
  const hm = now.toLocaleTimeString(isZh ? 'zh-CN' : undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  const date = isZh
    ? `${now.getMonth() + 1}月${now.getDate()}日 ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()]}`
    : now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return (
    <section className="pw pw--today">
      <div className="pw-today__main">
        <div className="pw-today__clock">
          <div className="pw-today__time">{hm}</div>
          <div className="pw-today__date">{date}</div>
          <div className={`pw-today__status${busy ? ' is-busy' : ''}`}><i aria-hidden />{statusLine}</div>
        </div>
        <button type="button" className="pw-today__wx" onClick={onWeather} title={t('天气', 'Weather')}>
          {weather ? (
            <>
              <img className="pw-today__wx-art" src={weatherArt(weather.code, weather.isDay)} alt="" draggable={false} />
              <span className="pw-today__wx-temp">{weather.temp}°</span>
              <span className="pw-today__wx-word">{weatherWord(weather.code, isZh)} · {weather.high}°/{weather.low}°</span>
              <span className="pw-today__wx-place"><S.IconMapPin size={11} />{place?.name}</span>
            </>
          ) : (
            <>
              <img className="pw-today__wx-art" src={weatherArt(1, now.getHours() >= 6 && now.getHours() < 19)} alt="" draggable={false} />
              <span className={`pw-today__wx-set${place ? ' neox-text-shimmer' : ''}`}>{place ? t('天气加载中…', 'Loading…') : t('选城市看天气', 'Set your city')}</span>
            </>
          )}
        </button>
      </div>
      {next && (
        <div className="pw-today__next">
          <img src={ART.calendar} alt="" draggable={false} />
          <span className="pw-today__next-when">{next.when}</span>
          <span className="pw-today__next-what">{next.title}</span>
        </div>
      )}
    </section>
  );
};

/* ───────── 选城市 ───────── */
export const PlacePicker: React.FC<{ isZh: boolean; onDone: () => void }> = ({ isZh, onDone }) => {
  const t = tr(isZh);
  const [q, setQ] = useState('');
  const [list, setList] = useState<Place[]>([]);
  const [busy, setBusy] = useState(false);
  const guess = useMemo(() => timezoneCityGuess(), []);
  useEffect(() => {
    const query = q.trim() || guess;
    if (!query) { setList([]); return undefined; }
    let alive = true;
    setBusy(true);
    const h = window.setTimeout(() => {
      void dataApi().pilotPlaces?.(query, isZh ? 'zh' : 'en').then((r) => { if (alive) setList(r?.places ?? []); }).finally(() => { if (alive) setBusy(false); });
    }, 250);
    return () => { alive = false; window.clearTimeout(h); };
  }, [q, guess, isZh]);
  return (
    <div className="pw-picker">
      <input className="pb-input" autoFocus placeholder={t('搜城市，例：上海 / Tokyo', 'Search a city')} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="pw-picker__list">
        {list.map((p) => (
          <button key={`${p.lat},${p.lng}`} type="button" className="pw-picker__item" onClick={() => { savePlace(p); onDone(); }}>
            <S.IconMapPin size={14} />
            <b>{p.name}</b>
            <span>{[p.region, p.country].filter(Boolean).join(' · ')}</span>
          </button>
        ))}
        {!busy && list.length === 0 && q.trim() && <div className="pw-picker__none">{t('没找到这个地方', 'No match')}</div>}
      </div>
    </div>
  );
};

/* ───────── 天气详情 ───────── */
export const WeatherDetail: React.FC<{ isZh: boolean; place: Place | null; weather: Weather | null; ask: ((s: string) => void) | null }> = ({ isZh, place, weather, ask }) => {
  const t = tr(isZh);
  const [picking, setPicking] = useState(!place);
  if (picking || !place) return <PlacePicker isZh={isZh} onDone={() => setPicking(false)} />;
  const hourFmt = (at: number) => new Date(at).toLocaleTimeString(isZh ? 'zh-CN' : undefined, { hour: '2-digit', hour12: false }).replace(/时$/, '') + (isZh ? '时' : '');
  const dayFmt = (d: string, i: number) => {
    if (i === 0) return t('今天', 'Today');
    const dt = new Date(`${d}T12:00:00`);
    return isZh ? ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][dt.getDay()] : dt.toLocaleDateString(undefined, { weekday: 'short' });
  };
  return (
    <div className="pw-wx">
      {weather && (
        <>
          <div className="pw-wx__now">
            <img src={weatherArt(weather.code, weather.isDay)} alt="" draggable={false} />
            <div>
              <div className="pw-wx__temp">{weather.temp}°</div>
              <div className="pw-wx__word">{weatherWord(weather.code, isZh)}</div>
              <div className="pw-wx__meta">{t(`体感 ${weather.feels}° · 湿度 ${weather.humidity}% · 风 ${weather.wind} km/h`, `Feels ${weather.feels}° · ${weather.humidity}% · ${weather.wind} km/h`)}</div>
            </div>
          </div>
          <div className="pw-wx__hours">
            {weather.hours.map((h) => (
              <div key={h.at} className="pw-wx__hour">
                <span>{hourFmt(h.at)}</span>
                <img src={weatherArt(h.code, h.isDay)} alt="" draggable={false} />
                <b>{h.temp}°</b>
              </div>
            ))}
          </div>
          <div className="pw-wx__days">
            {weather.days.map((d, i) => (
              <div key={d.date} className="pw-wx__day">
                <span className="pw-wx__day-name">{dayFmt(d.date, i)}</span>
                <img src={weatherArt(d.code, true)} alt="" draggable={false} />
                <span className="pw-wx__day-rain">{d.rain >= 20 ? `${d.rain}%` : ''}</span>
                <span className="pw-wx__day-range">{d.low}° <i style={{ ['--lo' as string]: `${Math.max(0, Math.min(100, (d.low + 10) * 2))}%`, ['--hi' as string]: `${Math.max(0, Math.min(100, (d.high + 10) * 2))}%` }} /> {d.high}°</span>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="pb-form__row pb-form__row--start">
        {ask && <button type="button" className="pb-btn" onClick={() => ask(t(`我在${place.name}，明天出门要带伞吗？穿什么合适？`, `I'm in ${place.name}. Do I need an umbrella tomorrow, and what should I wear?`))}>{t('明天穿什么', 'What to wear')}</button>}
        <button type="button" className="pb-btn" onClick={() => setPicking(true)}><S.IconMapPin size={13} />{place.name} · {t('换城市', 'Change')}</button>
      </div>
    </div>
  );
};

/* ───────── 地图 ───────── */
const Z = 12;
export const MapTiles: React.FC<{ place: Place; height: number }> = ({ place, height }) => {
  const { x, y } = tileAt(place.lat, place.lng, Z);
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  const size = 256;
  /* 中心点落在容器正中: 以 (tx-1, ty-1) 为左上的 3x3 瓦片, 平移 (fx, fy) */
  const fx = (x - tx + 1) * size;
  const fy = (y - ty + 1) * size;
  const tiles: Array<{ k: string; src: string; left: number; top: number }> = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      tiles.push({ k: `${dx},${dy}`, src: `https://tile.openstreetmap.org/${Z}/${tx + dx}/${ty + dy}.png`, left: (dx + 1) * size, top: (dy + 1) * size });
    }
  }
  return (
    <div className="pw-map" style={{ height }}>
      {/* translate 的百分比按自己 (768px 瓦片层) 算, 不是按卡片 —— 所以用 left/top 50% 定到卡片中心, 再减去点在瓦片层里的偏移 */}
      <div className="pw-map__tiles" style={{ left: '50%', top: '50%', transform: `translate(${-fx}px, ${-fy}px)` }}>
        {tiles.map((t) => <img key={t.k} src={t.src} alt="" draggable={false} style={{ left: t.left, top: t.top }} />)}
      </div>
      <span className="pw-map__pin" aria-hidden><i /></span>
      <span className="pw-map__credit">© OpenStreetMap</span>
    </div>
  );
};

export const MapWidget: React.FC<{ isZh: boolean; place: Place | null; onOpen: () => void }> = ({ isZh, place, onOpen }) => {
  const t = tr(isZh);
  return (
    <button type="button" className="pw pw--small pw--map" onClick={onOpen}>
      {place ? <MapTiles place={place} height={150} /> : <img className="pw-small__art pw-small__art--big" src={ART.map} alt="" draggable={false} />}
      <span className="pw-map__label"><S.IconMapPin size={11} />{place ? place.name : t('设置位置', 'Set location')}</span>
    </button>
  );
};

export const MapDetail: React.FC<{ isZh: boolean; place: Place | null; ask: ((s: string) => void) | null }> = ({ isZh, place, ask }) => {
  const t = tr(isZh);
  const [picking, setPicking] = useState(!place);
  if (picking || !place) return <PlacePicker isZh={isZh} onDone={() => setPicking(false)} />;
  const asks = [
    { art: ART.lunch, zh: '附近找吃的', en: 'Food nearby', pzh: `我在${place.name}，帮我在附近找几家好吃的，给我选。`, pen: `I'm in ${place.name}. Find a few good places to eat nearby.` },
    { art: ART.map, zh: '附近好玩的', en: 'Things to do', pzh: `我在${place.name}，这个周末附近有什么好玩的？`, pen: `I'm in ${place.name}. What's fun to do nearby this weekend?` },
  ];
  return (
    <div className="pw-mapd">
      <MapTiles place={place} height={220} />
      <div className="pw-mapd__asks">
        {ask && asks.map((a) => (
          <button key={a.zh} type="button" className="pw-ask" onClick={() => ask(isZh ? a.pzh : a.pen)}>
            <img src={a.art} alt="" draggable={false} />{isZh ? a.zh : a.en}
          </button>
        ))}
      </div>
      <div className="pb-form__row pb-form__row--start">
        <button type="button" className="pb-btn" onClick={() => setPicking(true)}><S.IconMapPin size={13} />{place.name} · {t('换城市', 'Change')}</button>
      </div>
    </div>
  );
};

/* ───────── 手机 ───────── */
export const PhoneWidget: React.FC<{ isZh: boolean; phone: PhoneState | null | undefined }> = ({ isZh, phone }) => {
  const t = tr(isZh);
  if (phone === undefined) return null;
  const openPairing = () => {
    try { localStorage.setItem('neox-settings-initial-tab', 'mobile'); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('neox:open-settings', { detail: { tab: 'mobile', from: 'pilot-board' } }));
  };
  return (
    <button type="button" className="pw pw--small" onClick={openPairing}>
      <img className="pw-small__art" src={ART.phone} alt="" draggable={false} />
      {phone ? (
        <>
          <span className={`pw-small__big pw-phone__state${phone.online ? ' is-on' : ''}`}>{phone.online ? t('在线', 'Online') : t('离线', 'Offline')}</span>
          <span className="pw-small__label">{phone.name}</span>
          <span className="pw-small__sub">{phone.online ? t('能打电话、能推送', 'Calls & pushes on') : phone.lastSeen ? t(`上次 ${formatSessionTime(phone.lastSeen)}`, `Seen ${formatSessionTime(phone.lastSeen)}`) : ''}</span>
        </>
      ) : (
        <>
          <span className="pw-small__big">{t('连手机', 'Link phone')}</span>
          <span className="pw-small__sub">{t('到点打电话、推送提醒', 'For calls & reminders')}</span>
        </>
      )}
    </button>
  );
};

/* ───────── 通用小方块: 汇报 / 它记得 / 通话 ───────── */
export const StatWidget: React.FC<{ art: string; big: string; label: string; sub?: string; dot?: boolean; onClick: () => void }> = ({ art, big, label, sub, dot, onClick }) => (
  <button type="button" className="pw pw--small" onClick={onClick}>
    <img className="pw-small__art" src={art} alt="" draggable={false} />
    {dot && <span className="pw-small__dot" aria-hidden />}
    <span className="pw-small__big">{big}</span>
    <span className="pw-small__label">{label}</span>
    {sub && <span className="pw-small__sub">{sub}</span>}
  </button>
);

/* ───────── 文件: 它最近做的 + 文件柜 ───────── */
function useOpenFile(sessionId: string | null) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async (path: string, mode: 'open' | 'save') => {
    if (!sessionId || busy) return;
    setBusy(`${mode}:${path}`);
    setErr(null);
    const r = await dataApi().pilotOpenFile?.(sessionId, path, mode).catch((e: Error) => ({ ok: false, error: e.message }));
    setBusy(null);
    if (!r?.ok) setErr((r as { error?: string })?.error ?? 'failed');
  };
  return { busy, err, run };
}

const FileRow: React.FC<{ name: string; path: string; meta: string; busy: boolean; isZh: boolean; onOpen: () => void; onSave: () => void }> = ({ name, path, meta, busy, isZh, onOpen, onSave }) => {
  const b = fileBadge(name);
  return (
    <div className={`pw-file${busy ? ' is-busy' : ''}`}>
      <button type="button" className="pw-file__main" onClick={onOpen} title={path}>
        <span className="pw-file__badge" style={{ ['--fc' as string]: b.color }}>{b.label}</span>
        <span className="pw-file__name">{name}</span>
        <span className="pw-file__meta">{busy ? (isZh ? '打开中…' : 'Opening…') : meta}</span>
      </button>
      <button type="button" className="pw-file__save" onClick={onSave} title={isZh ? '存到「下载」' : 'Save to Downloads'} aria-label={isZh ? '存到下载' : 'Save'}>
        <S.IconCloudDown size={13} />
      </button>
    </div>
  );
};

export const FilesWidget: React.FC<{ isZh: boolean; sessionId: string | null; files: MadeFile[]; onBrowse: () => void }> = ({ isZh, sessionId, files, onBrowse }) => {
  const t = tr(isZh);
  const op = useOpenFile(sessionId);
  if (files.length === 0) {
    return (
      <StatWidget art={ART.files} big={t('文件柜', 'Files')} label={t('它工作区里的文件', 'Its workspace')} onClick={onBrowse} />
    );
  }
  return (
    <section className="pw pw--files">
      <h3 className="pb-head">
        <img className="pb-head__art" src={ART.files} alt="" aria-hidden draggable={false} />
        <span className="pb-head__title">{t('它做的文件', 'Made for you')}</span>
        <button type="button" className="pb-head__link" onClick={onBrowse}>{t('文件柜', 'All files')} <S.IconChevronRight size={12} /></button>
      </h3>
      {files.slice(0, 4).map((f) => (
        <FileRow key={f.path} name={f.name} path={f.path} meta={formatSessionTime(f.at)} isZh={isZh}
          busy={op.busy === `open:${f.path}` || op.busy === `save:${f.path}`}
          onOpen={() => void op.run(f.path, 'open')} onSave={() => void op.run(f.path, 'save')} />
      ))}
      {op.err && <div className="pw-err">{op.err}</div>}
    </section>
  );
};

export const FilesDetail: React.FC<{ isZh: boolean; sessionId: string | null }> = ({ isZh, sessionId }) => {
  const t = tr(isZh);
  const [dir, setDir] = useState('.');
  const [items, setItems] = useState<PilotFile[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const op = useOpenFile(sessionId);
  useEffect(() => {
    if (!sessionId) return undefined;
    let alive = true;
    setItems(null);
    setErr(null);
    void dataApi().pilotFiles?.(sessionId, dir).then((r) => {
      if (!alive) return;
      if (r?.ok) setItems((r.items ?? []).filter((i) => !i.name.startsWith('.')).sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || b.mtime - a.mtime || a.name.localeCompare(b.name)));
      else setErr(r?.error ?? 'failed');
    });
    return () => { alive = false; };
  }, [sessionId, dir]);
  const crumbs = dir === '.' ? [] : dir.split('/');
  return (
    <div className="pw-cab">
      <div className="pw-cab__crumbs">
        <button type="button" onClick={() => setDir('.')}>{t('全部', 'All')}</button>
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            <S.IconChevronRight size={11} />
            <button type="button" onClick={() => setDir(crumbs.slice(0, i + 1).join('/'))}>{c}</button>
          </React.Fragment>
        ))}
      </div>
      {items === null && !err && <div className="pw-cab__loading">{t('正在连它的工作区…', 'Connecting…')}</div>}
      {err && <div className="pw-err">{err}</div>}
      {items?.map((f) => f.type === 'dir' ? (
        <button key={f.path} type="button" className="pw-dir" onClick={() => setDir(f.path)}>
          <span className="pw-dir__icon"><S.IconFolder size={15} /></span>
          <span className="pw-file__name">{f.name}</span>
          <S.IconChevronRight size={12} />
        </button>
      ) : (
        <FileRow key={f.path} name={f.name} path={f.path} isZh={isZh}
          meta={[fmtSize(f.size), f.mtime ? formatSessionTime(f.mtime) : ''].filter(Boolean).join(' · ')}
          busy={op.busy === `open:${f.path}` || op.busy === `save:${f.path}`}
          onOpen={() => void op.run(f.path, 'open')} onSave={() => void op.run(f.path, 'save')} />
      ))}
      {items && items.length === 0 && <div className="pw-cab__loading">{t('这里还是空的', 'Empty')}</div>}
      {op.err && <div className="pw-err">{op.err}</div>}
    </div>
  );
};

/* ───────── 详情页外壳: 返回 + 标题 ───────── */
export const Detail: React.FC<{ isZh: boolean; art: string; title: string; onBack: () => void; children: React.ReactNode }> = ({ isZh, art, title, onBack, children }) => (
  <div className="pw-detail">
    <div className="pw-detail__bar">
      <button type="button" className="pw-detail__back" onClick={onBack} aria-label={isZh ? '返回' : 'Back'}><S.IconChevronLeft size={16} /></button>
      <img src={art} alt="" draggable={false} />
      <span>{title}</span>
    </div>
    {children}
  </div>
);
