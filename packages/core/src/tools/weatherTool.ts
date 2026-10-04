/**
 * get_weather — 真天气数据 (Open-Meteo, 免 key 免注册).
 *
 * Life 场景最高频问题之一。此前 weather 卡的数据靠 web_search 搜出来再填,
 * 时效/精度全看搜索摘要脸色; 现在直接打 Open-Meteo:
 *   1. geocoding-api.open-meteo.com — 城市名(中英皆可) → 经纬度
 *   2. api.open-meteo.com/v1/forecast — 当前天气 + 7 日预报
 * 返回结构对齐 assistant-mode prompt 里的 weather 卡 schema, agent 拿来即填卡。
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';

/** WMO weather interpretation codes → 中文短语 (Open-Meteo 官方码表) */
const WMO_TEXT: Record<number, string> = {
  0: '晴', 1: '基本晴', 2: '多云', 3: '阴',
  45: '雾', 48: '冻雾',
  51: '毛毛雨', 53: '小雨', 55: '中雨',
  56: '冻毛毛雨', 57: '冻雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
  80: '阵雨', 81: '强阵雨', 82: '暴雨',
  85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷暴伴冰雹',
};

function wmoText(code: unknown): string {
  const n = typeof code === 'number' ? code : Number(code);
  return WMO_TEXT[n] ?? '未知';
}

const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function dayLabel(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00`);
  if (Number.isNaN(d.getTime())) return isoDate;
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const diffDays = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  const wd = WEEKDAY_ZH[d.getDay()];
  if (diffDays === 0) return `今天 (${wd})`;
  if (diffDays === 1) return `明天 (${wd})`;
  if (diffDays === 2) return `后天 (${wd})`;
  return `${isoDate.slice(5).replace('-', '/')} ${wd}`;
}

interface GetWeatherArgs {
  location: string;
  days?: number;
}

interface GeoResult {
  name?: string;
  latitude?: number;
  longitude?: number;
  country?: string;
  admin1?: string;
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export const getWeatherTool: Tool = {
  name: 'get_weather',
  description:
    'Get REAL current weather + multi-day forecast for any city (Open-Meteo, no key). ' +
    'Chinese or English city names both work ("上海", "徐汇", "Tokyo"). ' +
    'ALWAYS use this instead of web_search for weather questions — it is faster and accurate. ' +
    'The returned JSON is shaped to drop straight into a weather card.',
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  isReadOnly: true,

  parameters: {
    type: 'object',
    properties: {
      location: {
        type: 'string',
        description: 'City / district name, Chinese or English. e.g. "上海" / "北京朝阳" / "Tokyo". Use the most specific place the user mentioned.',
      },
      days: {
        type: 'number',
        description: 'Forecast days 1-7 (default 3). Use 1 for "现在/今天", 7 for "这周".',
      },
    },
    required: ['location'],
  },

  async function(args: GetWeatherArgs): Promise<string> {
    const q = args?.location?.trim();
    if (!q) return JSON.stringify({ error: 'location is required' });
    const days = Math.max(1, Math.min(7, Math.round(args?.days ?? 3)));
    try {
      const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=zh&format=json`;
      const geo = await fetchJson(geoUrl, 8000) as { results?: GeoResult[] };
      const hit = geo?.results?.[0];
      if (!hit || typeof hit.latitude !== 'number' || typeof hit.longitude !== 'number') {
        return JSON.stringify({ error: `找不到地点 "${q}" — 试试更常规的城市名 (如 "上海" / "杭州")` });
      }
      const fcUrl = 'https://api.open-meteo.com/v1/forecast'
        + `?latitude=${hit.latitude}&longitude=${hit.longitude}`
        + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m'
        + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
        + `&timezone=auto&forecast_days=${days}`;
      const fc = await fetchJson(fcUrl, 8000) as {
        current?: {
          temperature_2m?: number; apparent_temperature?: number;
          relative_humidity_2m?: number; weather_code?: number; wind_speed_10m?: number;
        };
        daily?: {
          time?: string[]; weather_code?: number[];
          temperature_2m_max?: number[]; temperature_2m_min?: number[];
          precipitation_probability_max?: Array<number | null>;
        };
      };
      const cur = fc.current ?? {};
      const daily = fc.daily ?? {};
      const placeName = [hit.name, hit.admin1 && hit.admin1 !== hit.name ? hit.admin1 : null]
        .filter(Boolean).join(', ');
      const forecast = (daily.time ?? []).map((date, i) => ({
        day: dayLabel(date),
        high: `${Math.round(daily.temperature_2m_max?.[i] ?? NaN)}°`,
        low: `${Math.round(daily.temperature_2m_min?.[i] ?? NaN)}°`,
        text: wmoText(daily.weather_code?.[i]),
        rain_chance: daily.precipitation_probability_max?.[i] != null
          ? `${daily.precipitation_probability_max[i]}%` : undefined,
      }));
      return JSON.stringify({
        location: placeName || q,
        current: {
          temp: `${Math.round(cur.temperature_2m ?? NaN)}°`,
          feels_like: `${Math.round(cur.apparent_temperature ?? NaN)}°`,
          text: wmoText(cur.weather_code),
          wind: `${Math.round(cur.wind_speed_10m ?? 0)} km/h`,
          humidity: cur.relative_humidity_2m != null ? `${cur.relative_humidity_2m}%` : undefined,
        },
        forecast,
        source: 'open-meteo.com',
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const hint = msg.includes('abort') ? ' (网络超时 — 可退回 web_search 兜底)' : '';
      return JSON.stringify({ error: `get_weather failed: ${msg}${hint}` });
    }
  },
};
