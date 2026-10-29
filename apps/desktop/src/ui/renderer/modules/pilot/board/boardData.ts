/**
 * 小组件的数据: 所在城市 / 天气 / 它做的文件 / 手机。
 * 城市只认用户自己选的 (存本机); 不做 IP 定位 —— 走代理的机器 IP 库给的城市是错的 (见 electron/services/pilotBoardData.ts)。
 */
import { useEffect, useMemo, useState } from 'react';
import { extractWriteDeclarationsFromTimelineEntries } from '../../agent-timeline/turnWriteDeclarations';
import type { TimelineEntry } from '../../../utils/workspaceUtils';

export interface Place { name: string; region?: string; country?: string; lat: number; lng: number }
export interface Weather {
  temp: number; feels: number; code: number; isDay: boolean; humidity: number; wind: number;
  high: number; low: number; rain: number;
  hours: Array<{ at: number; temp: number; code: number; isDay: boolean; rain: number }>;
  days: Array<{ date: string; high: number; low: number; code: number; rain: number }>;
  at: number;
}
export interface PilotFile { name: string; path: string; type: string; size: number; mtime: number }

interface DataApi {
  pilotPlaces?: (q: string, lang: string) => Promise<{ ok: boolean; places: Place[] }>;
  pilotWeather?: (lat: number, lng: number) => Promise<{ ok: boolean; weather?: Weather; error?: string }>;
  pilotFiles?: (sessionId: string, path: string) => Promise<{ ok: boolean; items?: PilotFile[]; error?: string }>;
  pilotOpenFile?: (sessionId: string, path: string, mode: 'open' | 'save') => Promise<{ ok: boolean; local?: string; error?: string }>;
  mobileBridge?: { listPaired?: () => Promise<Array<{ id: string; device_name: string; last_seen_at: number | null; active_transport: 'lan' | 'cloud' | null }>> };
}
export const dataApi = (): DataApi => ((window as unknown as { neox?: DataApi }).neox ?? {});

/* ── 城市: 本机记住 (一台电脑一个) ── */
const PLACE_KEY = 'neox-pilot-place';
const placeListeners = new Set<() => void>();
function readPlace(): Place | null {
  try { const v = JSON.parse(localStorage.getItem(PLACE_KEY) || 'null'); return v && Number.isFinite(v.lat) ? v : null; } catch { return null; }
}
export function savePlace(p: Place): void {
  try { localStorage.setItem(PLACE_KEY, JSON.stringify(p)); } catch { /* 记不住就这一次 */ }
  placeListeners.forEach((f) => f());
}
export function usePlace(): Place | null {
  const [p, setP] = useState<Place | null>(readPlace);
  useEffect(() => { const f = () => setP(readPlace()); placeListeners.add(f); return () => { placeListeners.delete(f); }; }, []);
  return p;
}

/** 时区里的城市名 (America/Los_Angeles → Los Angeles), 只拿来当「是不是在这」的建议, 用户点了才算 */
export function timezoneCityGuess(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const city = tz.split('/').pop() || '';
    return city.replace(/_/g, ' ');
  } catch { return ''; }
}

/* ── 天气: 15 分钟一刷 ── */
export function useWeather(place: Place | null): { weather: Weather | null; error: string | null } {
  const [state, setState] = useState<{ weather: Weather | null; error: string | null }>({ weather: null, error: null });
  useEffect(() => {
    if (!place) { setState({ weather: null, error: null }); return undefined; }
    let alive = true;
    const load = async () => {
      const r = await dataApi().pilotWeather?.(place.lat, place.lng).catch((e: Error) => ({ ok: false, error: e.message }));
      if (!alive || !r) return;
      setState(r.ok && 'weather' in r && r.weather ? { weather: r.weather, error: null } : { weather: null, error: (r as { error?: string }).error ?? 'weather failed' });
    };
    void load();
    const h = window.setInterval(load, 15 * 60_000);
    return () => { alive = false; window.clearInterval(h); };
  }, [place?.lat, place?.lng]);
  return state;
}

/** WMO 码 → 一个词 */
export function weatherWord(code: number, isZh: boolean): string {
  const zh: Record<number, string> = { 0: '晴', 1: '晴间多云', 2: '多云', 3: '阴', 45: '雾', 48: '雾', 51: '毛毛雨', 53: '小雨', 55: '中雨', 56: '冻雨', 57: '冻雨', 61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨', 71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒', 80: '阵雨', 81: '阵雨', 82: '暴雨', 85: '阵雪', 86: '阵雪', 95: '雷阵雨', 96: '雷阵雨', 99: '雷暴' };
  const en: Record<number, string> = { 0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Fog', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 80: 'Showers', 81: 'Showers', 82: 'Downpour', 95: 'Thunderstorm' };
  return (isZh ? zh : en)[code] ?? (isZh ? '多云' : 'Cloudy');
}

/* ── 它做的文件: 从这条对话的时间线里抽写过的路径 (重启也在), 新的在前 ── */
export interface MadeFile { path: string; name: string; at: number }
const DELIVERABLE = /\.(docx?|pdf|pptx?|xlsx?|csv|md|txt|html?|png|jpe?g|webp|gif|svg|mp4|mov|mp3|wav|zip|json)$/i;
export function useMadeFiles(feed: TimelineEntry[] | null | undefined, sessionId: string | null): MadeFile[] {
  return useMemo(() => {
    if (!feed || !sessionId) return [];
    const decls = extractWriteDeclarationsFromTimelineEntries(feed, sessionId);
    const seen = new Map<string, MadeFile>();
    for (const d of decls) {
      if (d.op === 'delete') { for (const p of d.paths) seen.delete(p); continue; }
      if (d.op === 'rename' && d.from) seen.delete(d.from);
      for (const p of d.paths) {
        const name = p.split(/[/\\]/).pop() || p;
        if (!DELIVERABLE.test(name) || name.startsWith('.')) continue;
        const prev = seen.get(p);
        if (!prev || prev.at < d.ts) seen.set(p, { path: p, name, at: d.ts });
      }
    }
    return [...seen.values()].sort((a, b) => b.at - a.at);
  }, [feed, sessionId]);
}

/** 文件类型 → 角标字 + 颜色 */
export function fileBadge(name: string): { label: string; color: string } {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'doc' || ext === 'docx') return { label: 'W', color: '#2f6bd8' };
  if (ext === 'pdf') return { label: 'PDF', color: '#e5484d' };
  if (ext === 'ppt' || ext === 'pptx') return { label: 'P', color: '#e8692c' };
  if (ext === 'xls' || ext === 'xlsx' || ext === 'csv') return { label: 'X', color: '#1f9d55' };
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext)) return { label: 'IMG', color: '#8b5cf6' };
  if (['mp4', 'mov'].includes(ext)) return { label: '▶', color: '#0ea5e9' };
  if (['mp3', 'wav'].includes(ext)) return { label: '♪', color: '#ec4899' };
  if (ext === 'md' || ext === 'txt') return { label: 'TXT', color: '#64748b' };
  if (ext === 'html' || ext === 'htm') return { label: '</>', color: '#f59e0b' };
  return { label: ext.slice(0, 3).toUpperCase() || '·', color: '#64748b' };
}

export function fmtSize(n: number): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* ── 手机: 配对的那台在不在线 ── */
export interface PhoneState { name: string; online: boolean; lastSeen: number | null }
export function usePhone(): PhoneState | null | undefined {
  const [s, setS] = useState<PhoneState | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const list = await dataApi().mobileBridge?.listPaired?.().catch(() => null);
      if (!alive) return;
      if (!list || list.length === 0) { setS(null); return; }
      const best = [...list].sort((a, b) => (b.active_transport ? 1 : 0) - (a.active_transport ? 1 : 0) || (b.last_seen_at ?? 0) - (a.last_seen_at ?? 0))[0];
      setS({ name: best.device_name, online: !!best.active_transport, lastSeen: best.last_seen_at });
    };
    void load();
    const h = window.setInterval(load, 30_000);
    return () => { alive = false; window.clearInterval(h); };
  }, []);
  return s;
}

/* ── 地图瓦片 (CARTO Voyager, 免 key; 只用 <img>, CSP 的 img-src 放了 https:) ── */
export function tileAt(lat: number, lng: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = ((lng + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return { x, y };
}
