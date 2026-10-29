
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { loadConfig } from '@neoxlabs/platform/utils/config.js';

const HOST = 'https://api.map.baidu.com';

function baiduAk(): string {
  try {
    const ak = (loadConfig() as { maps?: { baiduAk?: string } }).maps?.baiduAk;
    if (ak?.trim()) return ak.trim();
  } catch { /* 读不到配置就看环境变量 */ }
  return (process.env.NEOX_BAIDU_AK ?? '').trim();
}

// ───────────────────────── 坐标 ─────────────────────────

const PI = Math.PI;
const X_PI = (PI * 3000) / 180;
const EE = 0.00669342162296594323;
const A = 6378245.0;

const outOfChina = (lat: number, lng: number) => lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
function tLat(x: number, y: number): number {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  r += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3;
  r += ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3;
  return r;
}
function tLng(x: number, y: number): number {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  r += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3;
  r += ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3;
  return r;
}
/** WGS84 → BD09 (境外不偏) */
export function wgs84ToBd09(lat: number, lng: number): [number, number] {
  let gLat = lat;
  let gLng = lng;
  if (!outOfChina(lat, lng)) {
    let dLat = tLat(lng - 105, lat - 35);
    let dLng = tLng(lng - 105, lat - 35);
    const rad = (lat / 180) * PI;
    let magic = Math.sin(rad);
    magic = 1 - EE * magic * magic;
    const sq = Math.sqrt(magic);
    dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sq)) * PI);
    dLng = (dLng * 180) / ((A / sq) * Math.cos(rad) * PI);
    gLat = lat + dLat;
    gLng = lng + dLng;
  }
  const z = Math.sqrt(gLng * gLng + gLat * gLat) + 0.00002 * Math.sin(gLat * X_PI);
  const th = Math.atan2(gLat, gLng) + 0.000003 * Math.cos(gLng * X_PI);
  return [z * Math.sin(th) + 0.006, z * Math.cos(th) + 0.0065];
}

// ───────────────────────── 百度 ─────────────────────────

function baiduError(service: string, status: number, msg: string): string {
  if (status === 240 || status === 101) return `地图 key 用不了(${status}): 建应用时类型要选「服务端」, 并勾上「${service}」`;
  if (status === 210 || status === 211 || status === 102) return `地图 key 拒绝了这台机器(${status}): key 绑了 IP 白名单或 SN 校验`;
  if (status === 302 || status === 4 || (status >= 300 && status < 400)) return `地图${service}今天的配额用完了(${status}), 别编一个数`;
  if (status === 401) return '地图接口并发超了(401), 过几秒再问';
  return `${service}说: ${msg} (status ${status})`;
}

async function baidu<T>(path: string, service: string, params: Record<string, string>): Promise<T> {
  const ak = baiduAk();
  if (!ak) throw new Error('没配地图 key: 在 ~/.neox/config.json 的 maps.baiduAk 填百度地图「服务端」应用的 AK (或环境变量 NEOX_BAIDU_AK)');
  const q = new URLSearchParams({ ...params, ak, output: 'json' });
  const res = await fetch(`${HOST}${path}?${q}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${service}回了 HTTP ${res.status}`);
  const j = (await res.json()) as { status?: number; message?: string; msg?: string } & T;
  if (j.status && j.status !== 0) throw new Error(baiduError(service, j.status, j.message || j.msg || ''));
  return j;
}

const LATLNG = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

/** 「lat,lng」(WGS84, 手机定位给的) 或地址 → BD09 坐标 */
async function toBd09(place: string, city?: string): Promise<{ lat: number; lng: number; label: string }> {
  const m = LATLNG.exec(place);
  if (m) {
    const [lat, lng] = wgs84ToBd09(Number(m[1]), Number(m[2]));
    return { lat, lng, label: place };
  }
  const r = await baidu<{ result?: { location?: { lat: number; lng: number }; confidence?: number } }>(
    '/geocoding/v3/', '地理编码', { address: place, ...(city ? { city } : {}) });
  const loc = r.result?.location;
  if (!loc) throw new Error(`找不到这个地方: ${place}`);
  return { lat: loc.lat, lng: loc.lng, label: place };
}

const fmtMin = (sec: number) => (sec >= 3600 ? `${Math.floor(sec / 3600)} 小时 ${Math.round((sec % 3600) / 60)} 分钟` : `${Math.max(1, Math.round(sec / 60))} 分钟`);
const fmtKm = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} 公里` : `${m} 米`);
const JAM = ['', '畅通', '缓行', '拥堵', '严重拥堵'];

async function route(from: string, to: string, mode: string, city?: string): Promise<string> {
  const [a, b] = await Promise.all([toBd09(from, city), toBd09(to, city)]);
  const base = { origin: `${a.lat},${a.lng}`, destination: `${b.lat},${b.lng}`, coord_type: 'bd09ll' };
  if (mode === 'drive') {
    type Step = { road_name?: string; distance: number; traffic_condition?: Array<{ status: number; distance: number }> };
    const r = await baidu<{ result?: { routes?: Array<{ distance: number; duration: number; traffic_light?: number; toll?: number; steps?: Step[] }> } }>(
      '/direction/v2/driving', '驾车路线规划', { ...base, alternatives: '1' });
    const routes = r.result?.routes ?? [];
    if (!routes.length) return '这两点之间没算出驾车路线';
    return routes.slice(0, 2).map((rt, i) => {
      const jams: string[] = [];
      for (const s of rt.steps ?? []) {
        const worst = Math.max(0, ...(s.traffic_condition ?? []).map((c) => c.status));
        if (worst >= 2 && s.road_name) jams.push(`${s.road_name}${JAM[worst]}`);
      }
      const roads = [...new Set((rt.steps ?? []).map((s) => s.road_name).filter((x): x is string => !!x && x !== '无名路'))].slice(0, 4);
      return `${i === 0 ? '推荐' : '备选'}: 开车约 ${fmtMin(rt.duration)}, ${fmtKm(rt.distance)}`
        + (roads.length ? `, 走 ${roads.join('→')}` : '')
        + (jams.length ? `; 路况: ${[...new Set(jams)].slice(0, 4).join('、')}` : '; 一路基本畅通')
        + (rt.toll ? '; 有收费' : '');
    }).join('\n') + '\n(时间已按实时路况算)';
  }
  const path = mode === 'transit' ? '/directionlite/v1/transit' : mode === 'walk' ? '/directionlite/v1/walking' : '/directionlite/v1/riding';
  const name = mode === 'transit' ? '公交路线规划' : mode === 'walk' ? '步行路线规划' : '骑行路线规划';
  type V = { name?: string; start_name?: string; end_name?: string; stop_num?: number };
  type S = { distance: number; vehicle?: V };
  const r = await baidu<{ result?: { routes?: Array<{ distance: number; duration: number; price?: number; steps?: Array<S | S[]> }> } }>(path, name, base);
  const rt = r.result?.routes?.[0];
  if (!rt) return `这两点之间没算出${name.replace('规划', '')}`;
  const head = `${mode === 'transit' ? '公交地铁' : mode === 'walk' ? '走路' : '骑车'}约 ${fmtMin(rt.duration)}, ${fmtKm(rt.distance)}${rt.price ? `, 票价约 ${rt.price} 元` : ''}`;
  if (mode !== 'transit') return head;
  const rides = (rt.steps ?? []).map((s) => (Array.isArray(s) ? s[0] : s)).filter((s) => s?.vehicle?.name)
    .map((s) => `${s.vehicle!.start_name} 上 ${s.vehicle!.name}${s.vehicle!.stop_num ? ` 坐 ${s.vehicle!.stop_num} 站` : ''}到 ${s.vehicle!.end_name}`);
  return rides.length ? `${head}\n${rides.join('\n')}` : head;
}

async function nearby(query: string, near: string, radius: number, city?: string): Promise<string> {
  const c = await toBd09(near, city);
  type P = { name: string; address?: string; detail_info?: { distance?: number; overall_rating?: string; price?: string; tag?: string } };
  const r = await baidu<{ results?: P[] }>('/place/v2/search', '地点检索', {
    query, location: `${c.lat},${c.lng}`, radius: String(radius), scope: '2', page_size: '8', coord_type: '3', filter: 'sort_name:distance|sort_rule:1',
  });
  const list = r.results ?? [];
  if (!list.length) return `附近 ${fmtKm(radius)} 内没找到「${query}」`;
  return list.map((p) => {
    const d = p.detail_info ?? {};
    return [p.name, d.distance != null ? fmtKm(d.distance) : '', d.overall_rating ? `${d.overall_rating} 分` : '', d.price ? `人均 ${d.price}` : '', p.address ?? '']
      .filter(Boolean).join(' · ');
  }).join('\n');
}

async function traffic(road: string, city: string): Promise<string> {
  const r = await baidu<{ description?: string; evaluation?: { status_desc?: string } }>('/traffic/v1/road', '实时路况', { road_name: road, city });
  return r.description || r.evaluation?.status_desc || `${road} 暂无路况描述`;
}

export const mapsTool: Tool = {
  name: 'maps',
  description:
    'Maps for real-world errands (China: Baidu Maps). Times include live traffic.\n'
    + '- route {from, to, mode: drive|transit|walk|ride}: how long it takes right now, which roads, where it jams. Use it to tell the user when to leave.\n'
    + '- nearby {query, near, radius?}: places around a point, nearest first (food, pharmacy, gas...). Shows distance, rating, price per person.\n'
    + '- traffic {road, city}: live traffic on one road.\n'
    + 'A place is an address/landmark ("国贸", "北京南站") or "lat,lng" straight from the phone tool get_location. '
    + 'For "here"/"near me", get the location from the phone first. city helps disambiguate addresses.',
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  isReadOnly: true,
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['route', 'nearby', 'traffic'] },
      from: { type: 'string' },
      to: { type: 'string' },
      mode: { type: 'string', enum: ['drive', 'transit', 'walk', 'ride'] },
      query: { type: 'string' },
      near: { type: 'string' },
      radius: { type: 'number', description: 'meters, default 2000' },
      road: { type: 'string' },
      city: { type: 'string' },
    },
    required: ['action'],
  },
  function: async (args: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string).trim() : '');
    try {
      switch (a.action) {
        case 'route':
          if (!s('from') || !s('to')) return JSON.stringify({ success: false, error: 'route needs from and to' });
          return JSON.stringify({ success: true, result: await route(s('from'), s('to'), s('mode') || 'drive', s('city') || undefined) });
        case 'nearby':
          if (!s('query') || !s('near')) return JSON.stringify({ success: false, error: 'nearby needs query and near' });
          return JSON.stringify({ success: true, result: await nearby(s('query'), s('near'), Math.min(50_000, Math.max(200, Number(a.radius) || 2000)), s('city') || undefined) });
        case 'traffic':
          if (!s('road') || !s('city')) return JSON.stringify({ success: false, error: 'traffic needs road and city' });
          return JSON.stringify({ success: true, result: await traffic(s('road'), s('city')) });
      }
      return JSON.stringify({ success: false, error: 'action must be route / nearby / traffic' });
    } catch (err) {
      return JSON.stringify({ success: false, error: String((err as Error)?.message ?? err) });
    }
  },
};

export const MAPS_TOOLS: Tool[] = [mapsTool];
