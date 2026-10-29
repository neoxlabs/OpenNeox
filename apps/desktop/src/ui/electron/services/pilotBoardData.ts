import { app, shell } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import os from 'node:os';

async function getJson<T>(url: string, timeoutMs = 8000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json() as T;
  } finally {
    clearTimeout(t);
  }
}

export interface PilotPlace { name: string; region: string; country: string; lat: number; lng: number }

export async function searchPlaces(q: string, lang: string): Promise<PilotPlace[]> {
  const query = q.trim();
  if (!query) return [];
  const j = await getJson<{ results?: Array<{ name: string; admin1?: string; country?: string; latitude: number; longitude: number }> }>(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=6&language=${lang === 'zh' ? 'zh' : 'en'}&format=json`,
  );
  return (j.results ?? []).map((r) => ({ name: r.name, region: r.admin1 ?? '', country: r.country ?? '', lat: r.latitude, lng: r.longitude }));
}

export interface PilotWeather {
  temp: number; feels: number; code: number; isDay: boolean; humidity: number; wind: number;
  high: number; low: number; rain: number;
  hours: Array<{ at: number; temp: number; code: number; isDay: boolean; rain: number }>;
  days: Array<{ date: string; high: number; low: number; code: number; rain: number }>;
  at: number;
}

export async function fetchWeather(lat: number, lng: number): Promise<PilotWeather> {
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${lat}&longitude=${lng}`
    + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day'
    + '&hourly=temperature_2m,weather_code,precipitation_probability,is_day'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
    + '&timezone=auto&forecast_days=5&timeformat=unixtime';
  const j = await getJson<any>(url);
  const now = Date.now();
  const hours: PilotWeather['hours'] = [];
  const ht: number[] = j.hourly?.time ?? [];
  for (let i = 0; i < ht.length && hours.length < 6; i++) {
    const at = ht[i] * 1000;
    if (at < now - 30 * 60_000) continue;
    hours.push({ at, temp: Math.round(j.hourly.temperature_2m[i]), code: j.hourly.weather_code[i], isDay: !!j.hourly.is_day[i], rain: j.hourly.precipitation_probability?.[i] ?? 0 });
  }
  const days: PilotWeather['days'] = (j.daily?.time ?? []).map((t: number, i: number) => ({
    date: new Date(t * 1000).toISOString().slice(0, 10),
    high: Math.round(j.daily.temperature_2m_max[i]),
    low: Math.round(j.daily.temperature_2m_min[i]),
    code: j.daily.weather_code[i],
    rain: j.daily.precipitation_probability_max?.[i] ?? 0,
  }));
  const c = j.current ?? {};
  return {
    temp: Math.round(c.temperature_2m), feels: Math.round(c.apparent_temperature), code: c.weather_code, isDay: !!c.is_day,
    humidity: c.relative_humidity_2m ?? 0, wind: Math.round(c.wind_speed_10m ?? 0),
    high: days[0]?.high ?? Math.round(c.temperature_2m), low: days[0]?.low ?? Math.round(c.temperature_2m), rain: days[0]?.rain ?? 0,
    hours, days, at: now,
  };
}

/**
 * 把它容器里的文件落到这台电脑:
 *   open → <userData>/pilot-files/<pilot>/ 再用系统默认程序打开 (Word / 预览 / Keynote)
 *   save → 存进「下载」, 重名加 (1)(2), 在访达里选中
 */
export async function landPilotFile(
  pilotId: string,
  relPath: string,
  file: { encoding: 'utf8' | 'base64'; content: string; truncated: boolean },
  mode: 'open' | 'save',
): Promise<string> {
  if (file.truncated) throw new Error('文件超过 4MB, 暂时只能在对话里让它发给你');
  const buf = file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : Buffer.from(file.content, 'utf8');
  const name = basename(relPath) || 'file';
  let dest: string;
  if (mode === 'open') {
    const dir = join(app.getPath('userData'), 'pilot-files', pilotId.replace(/[^\w.-]/g, '_'));
    await mkdir(dir, { recursive: true });
    dest = join(dir, name);
  } else {
    const dir = app.getPath('downloads') || join(os.homedir(), 'Downloads');
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    dest = join(dir, name);
    for (let i = 1; existsSync(dest); i++) dest = join(dir, `${stem} (${i})${ext}`);
  }
  await writeFile(dest, buf);
  if (mode === 'open') {
    const err = await shell.openPath(dest);
    if (err) throw new Error(err);
  } else {
    shell.showItemInFolder(dest);
  }
  return dest;
}
