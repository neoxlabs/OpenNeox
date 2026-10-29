/**
 * Pilot · 足迹 (稿 pl4)。地方都来自 pilot-data 的 place.visit (手机定位 / 它记下的到访)。
 *
 *   头: 足迹 · 这周去了几个地方 · 走了多少公里
 *   左: 一张压成奶油色的地图 (OSM 瓦片) —— 去过的地方一个个点, 最近几次连成蓝色虚线, 家和最常去的挂大气泡
 *   右: 今天 (到过哪, 按时间一条竖线串起来) · 它看着的 (家 / 常去 / 车)
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { dispatchHint, dispatchOpFailed } from '../../../components/notifyEvents';
import { tileAt } from '../board/boardData';
import { putPilotRecords, useDesktopPosition, usePilotOverview, usePilotRecords } from './pilotData';

type Pt = { lat: number; lng: number };
const S = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const I = {
  home: <svg {...S}><path d="M4 11 12 4l8 7M6 9.5V20h12V9.5M10 20v-5h4v5" /></svg>,
  work: <svg {...S}><rect x="4" y="5" width="16" height="11" rx="1.5" /><path d="M2.5 19h19" /></svg>,
  food: <svg {...S}><path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M17 21V3c-2 1.5-3 4-3 7v3h3" /></svg>,
  gym: <svg {...S}><path d="M6.5 7v10M17.5 7v10M3.5 9.5v5M20.5 9.5v5M6.5 12h11" /></svg>,
  car: <svg {...S}><path d="M5 16.5V12l2-5h10l2 5v4.5M5 16.5h14M5 16.5V18M19 16.5V18M7.5 13.5h.01M16.5 13.5h.01" /></svg>,
  pin: <svg {...S}><path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11Z" /><circle cx="12" cy="10" r="2.2" /></svg>,
};
/** 是不是「家」本身 —— 只认整名, 「外婆家」是饭馆不是家 */
const isHome = (name: string) => /^(家|我家|home)$/i.test(name.trim());

function placeIcon(name: string): React.ReactNode {
  if (isHome(name)) return I.home;
  if (/公司|办公|科技园|office|work/i.test(name)) return I.work;
  if (/饭|餐|火锅|海底捞|咖啡|面|食堂|restaurant|cafe/i.test(name)) return I.food;
  if (/健身|游泳|球|gym/i.test(name)) return I.gym;
  return I.pin;
}

/** 两点距离 (公里) */
function km(a: Pt, b: Pt): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ───────── 坐标系: 手机 / 电脑给的是 WGS-84, 高德瓦片是 GCJ-02 (国内偏移几百米), 画到高德上之前要转 ───────── */
function outOfChina(p: Pt): boolean {
  return p.lng < 72.004 || p.lng > 137.8347 || p.lat < 0.8293 || p.lat > 55.8271;
}
function wgsToGcj(p: Pt): Pt {
  if (outOfChina(p)) return p;
  const a = 6378245.0; const ee = 0.00669342162296594323;
  const x = p.lng - 105.0; const y = p.lat - 35.0;
  let dLat = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  dLat += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  dLat += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  dLat += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  let dLng = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  dLng += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  dLng += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  dLng += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  const radLat = (p.lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { lat: p.lat + dLat, lng: p.lng + dLng };
}

/* ───────── 地图: 按点的范围挑缩放, 铺满容器的瓦片 + 一层 SVG 画点和线 ─────────
 * 国内用高德底图 (路名中文、比 OSM 新), 国外用 OSM。瓦片一块块淡入, 第一块到之前底下一层呼吸的奶油色, 不闪白 */
interface MapPin extends Pt { name: string; big: boolean; recent: boolean }

const PlaceMap: React.FC<{ pins: MapPin[]; route: Pt[]; me: Pt | null; zh: boolean }> = ({ pins: rawPins, route: rawRoute, me: rawMe, zh }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 600, h: 520 });
  const [dz, setDz] = useState(0);
  const [loaded, setLoaded] = useState<Set<string>>(() => new Set());
  const ref0: Pt | undefined = rawPins[0] ?? rawRoute[0] ?? rawMe ?? undefined;
  const amap = !!ref0 && !outOfChina(ref0);
  const conv = (p: Pt): Pt => (amap ? wgsToGcj(p) : p);
  const pins = rawPins.map((p) => ({ ...p, ...conv(p) }));
  const route = rawRoute.map(conv);
  const me = rawMe ? conv(rawMe) : null;
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* 取景只看日常那一片: 以家 (没有就最常去的那个) 为心, 30 公里内的点 —— 出过一趟差的城市不该把地图拉成全国 */
  const anchor: Pt | undefined = pins.find((p) => p.big) ?? pins[0] ?? route[0] ?? me ?? undefined;
  const near = [...pins, ...route, ...(me ? [me] : [])].filter((p) => !anchor || km(anchor, p) <= 30);
  const all: Pt[] = near.length ? near : [...pins, ...route];
  const lat0 = Math.min(...all.map((p) => p.lat)); const lat1 = Math.max(...all.map((p) => p.lat));
  const lng0 = Math.min(...all.map((p) => p.lng)); const lng1 = Math.max(...all.map((p) => p.lng));
  const center = { lat: (lat0 + lat1) / 2, lng: (lng0 + lng1) / 2 };
  /* 最大的、所有点都放得进 (四边各留 70px 给气泡) 的缩放级 */
  let z = 16;
  for (; z > 3; z--) {
    const a = tileAt(lat1, lng0, z); const b = tileAt(lat0, lng1, z);
    if ((b.x - a.x) * 256 <= box.w - 140 && (b.y - a.y) * 256 <= box.h - 140) break;
  }
  z = Math.max(3, Math.min(17, z + dz));
  const c = tileAt(center.lat, center.lng, z);
  /* 屏幕坐标: 中心点落在容器正中 */
  const toXY = (p: Pt) => { const t = tileAt(p.lat, p.lng, z); return { x: box.w / 2 + (t.x - c.x) * 256, y: box.h / 2 + (t.y - c.y) * 256 }; };
  const tx0 = Math.floor(c.x - box.w / 512) ; const tx1 = Math.floor(c.x + box.w / 512);
  const ty0 = Math.floor(c.y - box.h / 512) ; const ty1 = Math.floor(c.y + box.h / 512);
  const tiles: Array<{ k: string; src: string; left: number; top: number }> = [];
  const n = 2 ** z;
  for (let ty = ty0; ty <= ty1; ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = tx0; tx <= tx1; tx++) {
      const wx = ((tx % n) + n) % n;
      const src = amap
        ? `https://webrd0${1 + ((wx + ty) % 4)}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=2&style=8&x=${wx}&y=${ty}&z=${z}`
        : `https://tile.openstreetmap.org/${z}/${wx}/${ty}.png`;
      tiles.push({ k: `${z}/${tx}/${ty}`, src, left: box.w / 2 + (tx - c.x) * 256, top: box.h / 2 + (ty - c.y) * 256 });
    }
  }
  const line = route.map((p, i) => { const q = toXY(p); return `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`; }).join(' ');
  /* 两个大气泡在屏幕上挨得太近 (< 80px) 会叠成一团: 先来的 (家排第一) 留着, 后面的退成小点 */
  const bubbles: MapPin[] = [];
  const dots: MapPin[] = pins.filter((p) => !p.big);
  for (const p of pins.filter((x) => x.big)) {
    const q = toXY(p);
    if (bubbles.some((b) => { const r = toXY(b); return Math.hypot(r.x - q.x, r.y - q.y) < 80; })) dots.push(p);
    else bubbles.push(p);
  }

  return (
    <div className={`pv3-map${loaded.size ? '' : ' is-loading'}${amap ? ' is-amap' : ''}`} ref={ref}>
      <div className="pv3-map__tiles">
        {tiles.map((t) => (
          <img
            key={t.k}
            src={t.src}
            alt=""
            draggable={false}
            className={loaded.has(t.k) ? 'is-in' : undefined}
            style={{ left: t.left, top: t.top }}
            onLoad={() => setLoaded((s) => (s.has(t.k) ? s : new Set(s).add(t.k)))}
          />
        ))}
      </div>
      <svg className="pv3-map__svg" width={box.w} height={box.h} aria-hidden>
        {route.length > 1 && <path d={line} className="pv3-map__route" />}
        {route.map((p, i) => { const q = toXY(p); return <circle key={i} cx={q.x} cy={q.y} r="5" className="pv3-map__stop" />; })}
        {dots.map((p) => { const q = toXY(p); return <circle key={p.name} cx={q.x} cy={q.y} r="6" className={`pv3-map__dot${p.recent ? ' is-recent' : ''}`} />; })}
      </svg>
      {me && (() => { const q = toXY(me); return <span className="pv3-map__me" style={{ left: q.x, top: q.y }} title={zh ? '你现在在这' : 'You are here'} />; })()}
      {bubbles.map((p) => {
        const q = toXY(p);
        return (
          <span key={p.name} className="pv3-map__bubble" style={{ left: q.x, top: q.y }}>
            <span className="pv3-map__bubble-ic">{placeIcon(p.name)}</span>
            <span className="pv3-map__bubble-name">{p.name}</span>
          </span>
        );
      })}
      <div className="pv3-map__zoom">
        <button type="button" aria-label={zh ? '放大' : 'Zoom in'} onClick={() => setDz((d) => d + 1)}>+</button>
        <button type="button" aria-label={zh ? '缩小' : 'Zoom out'} onClick={() => setDz((d) => d - 1)}>−</button>
      </div>
      <span className="pv3-map__credit">{amap ? '© 高德地图' : '© OpenStreetMap'}</span>
    </div>
  );
};

interface Props { onGoChat: () => void }

export const PilotPlacesPage: React.FC<Props> = () => {
  const { isZh } = useI18n();
  const { data, reload: reloadOverview } = usePilotOverview();
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekAgo = dayStart - 6 * 86_400_000;
  const visits = usePilotRecords(['place.visit'], { from: weekAgo, limit: 300 });
  const p = data?.rooms.place;
  const scene = p?.scene;

  const week = useMemo(() => {
    const rows = [...(visits.data?.records ?? [])].sort((a, b) => a.occurred_at - b.occurred_at);
    const names = new Set(rows.map((r) => String(r.data.name ?? r.title)));
    let dist = 0;
    let prev: Pt | null = null;
    for (const r of rows) {
      const lat = Number(r.data.lat); const lng = Number(r.data.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      if (prev) dist += km(prev, { lat, lng });
      prev = { lat, lng };
    }
    const today = rows.filter((r) => r.occurred_at >= dayStart);
    /* 到访记录这周没拉到 (老数据 / 手机没传) 时, 退回汇总里「7 天内去过」的点数 */
    const fromPins = (scene?.pins ?? []).filter((x) => x.lastDays < 7).length;
    return { places: Math.max(names.size, fromPins), km: dist, today };
  }, [visits.data, dayStart, scene]);

  /* 地图上的点: 去得最多的两处 + 家 挂大气泡, 其余小点; 一周内去过的点亮一点 */
  const pins = useMemo<MapPin[]>(() => {
    const list = scene?.pins ?? [];
    const top = [...list].sort((a, b) => b.count - a.count).slice(0, 2).map((x) => x.name);
    const out: MapPin[] = list.map((x) => ({ name: x.name, lat: x.lat, lng: x.lng, big: top.includes(x.name), recent: x.lastDays < 7 }));
    if (scene?.home && !out.some((x) => isHome(x.name))) {
      /* 家排第一个: 地图取景以它为心 */
      out.unshift({ name: isZh ? '家' : 'Home', ...scene.home, big: true, recent: true });
    }
    return out;
  }, [scene, isZh]);

  const desk = useDesktopPosition();
  const [savingHome, setSavingHome] = useState(false);
  const setHomeHere = async () => {
    if (!desk.pos || savingHome) return;
    setSavingHome(true);
    try {
      const r = await putPilotRecords([{
        type: 'fact.assert', occurred_at: Date.now(), source: 'desktop',
        data: { key: 'home.geo', value: `${desk.pos.lat.toFixed(5)},${desk.pos.lng.toFixed(5)}` },
      }]);
      if (r[0] && r[0].status === 'invalid') throw new Error(r[0].error || 'invalid');
      dispatchHint(isZh ? '记住了，这里是家' : 'Got it — this is home', 'success');
      reloadOverview();
    } catch (e) {
      dispatchOpFailed({ op: isZh ? '设成家' : 'Set home', message: (e as Error).message });
    } finally {
      setSavingHome(false);
    }
  };
  const homeHint = scene?.home || p?.places.length
    ? (isZh ? '到家、出门它都知道' : 'Knows when you leave and get home')
    : desk.error
      ? (isZh ? '电脑定位没开：系统设置 → 隐私与安全性 → 定位服务' : 'Turn on Location Services for Neox in System Settings')
      : (isZh ? '在家的时候点「这里是家」' : 'Tap "This is home" when you are home');

  const often = [...(p?.places ?? [])].sort((a, b) => b.count - a.count).filter((x) => !isHome(x.name)).slice(0, 2);
  const vehicles = data?.rooms.home?.vehicles ?? [];
  const hm = (ms: number) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

  return (
    <div className="pv3-room pv3-places" data-loading={data ? undefined : ''}>
      <div className="pv3-places__main">
        <header>
          <h1 className="pv3-pagehead">{isZh ? '足迹' : 'Places'}</h1>
          <p className="pv3-pagesub">
            {isZh ? `这周去了 ${week.places} 个地方` : `${week.places} places this week`}
            {week.km >= 1 ? (isZh ? ` · 走了 ${Math.round(week.km)} 公里` : ` · ${Math.round(week.km)} km`) : ''}
          </p>
        </header>
        {pins.length + (scene?.route.length ?? 0) > 0 || desk.pos ? (
          <PlaceMap pins={pins} route={scene?.route ?? []} me={desk.pos} zh={isZh} />
        ) : !data ? (
          <div className="pv3-map is-loading" />
        ) : (
          <div className="pv3-map pv3-map--empty">{isZh ? '开了定位（电脑或手机都行），去过的地方会画在这里' : 'Turn on location on this computer or your phone and places will show up here'}</div>
        )}
      </div>

      <div className="pv3-places__side">
        <section className="pv3-box">
          <h2 className="pv3-box__title">{isZh ? '今天' : 'Today'}</h2>
          {week.today.length === 0 ? (
            <p className="pv3-box__empty">{isZh ? '今天还没记到去了哪' : 'Nowhere logged yet today'}</p>
          ) : (
            <ol className="pv3-trail">
              {week.today.map((r) => {
                const name = String(r.data.name ?? r.title.replace(/^在\s*/, ''));
                return (
                  <li key={r.id}>
                    <span className="pv3-trail__ic">{placeIcon(name)}</span>
                    <span className="pv3-trail__txt"><small>{hm(r.occurred_at)}</small><b>{name}</b></span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <section className="pv3-box">
          <h2 className="pv3-box__title">{isZh ? '它看着的' : 'Watching'}</h2>
          <ul className="pv3-list pv3-list--ruled">
            <li>
              <span className="pv3-list__ic">{I.home}</span>
              <span className="pv3-list__main">
                <b>{isZh ? '家' : 'Home'}</b>
                <small>{homeHint}</small>
              </span>
              <span className={`pv3-tag${scene?.home ? '' : ' is-off'}`}>{scene?.home ? (isZh ? '已设' : 'Set') : (isZh ? '没设' : 'Not set')}</span>
            </li>
            {often.map((x) => (
              <li key={x.name}>
                <span className="pv3-list__ic">{placeIcon(x.name)}</span>
                <span className="pv3-list__main"><b>{x.name}</b><small>{isZh ? `去过 ${x.count} 次 · 上次 ${x.last.slice(5).replace('-', '/')}` : `${x.count} visits · last ${x.last.slice(5).replace('-', '/')}`}</small></span>
              </li>
            ))}
            {vehicles.map((v) => (
              <li key={v.name}>
                <span className="pv3-list__ic">{I.car}</span>
                <span className="pv3-list__main"><b>{v.name}</b><small>{v.model ?? (isZh ? '蓝牙一连就算上车' : 'Bluetooth connect = in the car')}</small></span>
              </li>
            ))}
          </ul>
          {desk.pos && (
            <button type="button" className="pv3-wide pv3-wide--ic" disabled={savingHome} onClick={() => void setHomeHere()}>
              {I.home}{isZh ? '这里是家' : 'This is home'}
            </button>
          )}
        </section>
      </div>
    </div>
  );
};

export default PilotPlacesPage;
