import { useCallback, useEffect, useState } from 'react';
import { ulid } from '@neoxlabs/pilot-data-sdk';
import { getEditionHook } from '../../shell/editionHooks';

const BASE = '/api/v1/pilot/data';

export type InsightAction =
  | { kind: 'remind'; label: string; at: string; title: string }
  | { kind: 'checkin'; label: string; habit: string }
  | { kind: 'ask'; label: string; prompt: string };

export interface Insight {
  id: string;
  domain: string;
  tone: 'good' | 'watch' | 'info';
  score: number;
  title: string;
  detail: string;
  suggestion?: string;
  action?: InsightAction;
  numbers?: Record<string, number | string>;
}

export interface RoomsSummary {
  body?: {
    weight: number | null; weightDelta30: number | null; sleepMin: number | null; workoutsWeek: number; workoutMinWeek: number;
    scene?: { goal: number | null; start: number | null; weights: Array<{ day: string; kg: number }>; sleep7: Array<{ day: string; min: number }>; workout7: Array<{ day: string; min: number }> };
  };
  money?: {
    monthSpent: number; spent7: number; netWorth: number | null; netWorthDelta30: number | null;
    accounts: Array<{ name: string; kind: string; value: number }>;
    subscriptions: Array<{ name: string; amount: number; nextDay: string }>;
    monthByCategory: Array<{ category: string; amount: number }>;
    scene?: { months: Array<{ ym: string; amount: number }>; usualMonth: number | null; pace: number | null; savingsRate: number | null; netWorth: Array<{ ym: string; value: number }> };
  };
  home?: {
    city: string | null; address: string | null; monthBills: number;
    bills: Array<{ kind: string; label: string; amount: number; period: string; due: string | null; paid: boolean | null }>;
    vehicles: Array<{ name: string; model: string | null; items: Array<{ what: string; due: string; days: number }> }>;
  };
  people?: { list: Array<{ name: string; relation: string | null; likes: string | null; birthday: string | null; birthdayInDays: number | null; lastContactDays: number | null }> };
  work?: { job: string | null; deliverables: Array<{ title: string; day: string }> };
  place?: {
    places: Array<{ name: string; last: string; count: number }>; newThisMonth: number;
    scene?: { pins: Array<{ name: string; lat: number; lng: number; count: number; lastDays: number }>; route: Array<{ name: string; lat: number; lng: number; day: string }>; home: { lat: number; lng: number } | null };
  };
  me?: { facts: Array<{ key: string; value: string }>; focus: string[]; knowledge: Array<{ title: string; kind: string; day: string }> };
}

export interface Overview { insights: Insight[]; rooms: RoomsSummary }

/** 用户当地的今天 'YYYY-MM-DD' (服务端按它算「这周 / 这个月」) */
export function localToday(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function getJson<T>(path: string): Promise<T> {
  const fetchWithAuth = getEditionHook('fetchWithAuth');
  const res = await fetchWithAuth(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${res.status}`);
  return (await res.json()) as T;
}

type Load<T> = { data: T | null; loading: boolean; error: string | null; reload: () => void };

const lastByPath = new Map<string, unknown>();

function useJson<T>(path: string | null, refreshMs = 5 * 60_000): Load<T> {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null }>(() => {
    const cached = path ? (lastByPath.get(path) as T | undefined) : undefined;
    return { data: cached ?? null, loading: !!path && cached === undefined, error: null };
  });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    if (!path) return undefined;
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    getJson<T>(path)
      .then((data) => { lastByPath.set(path, data); if (alive) setState({ data, loading: false, error: null }); })
      .catch((e: Error) => { if (alive) setState((s) => ({ data: s.data, loading: false, error: e.message })); });
    const h = refreshMs > 0 ? window.setInterval(reload, refreshMs) : 0;
    return () => { alive = false; if (h) window.clearInterval(h); };
  }, [path, tick, refreshMs, reload]);
  return { ...state, reload };
}

/** 洞察 + 房间汇总: 今天页和各房间页共用一份 */
export function usePilotOverview(): Load<Overview> {
  return useJson<Overview>(`/overview?today=${localToday()}`);
}

/** 某个指标近 N 天按天的序列 (体重 90 天这种) */
export function usePilotMetricSeries(metric: string, days: number): Array<{ day: string; value: number }> {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1).getTime();
  /* to 取到今天结束, 一天内反复渲染 path 不变 —— 不然每次 render 都是新 URL, 请求打不停 */
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const { data } = useJson<{ points: Array<{ day: string; value: number }> }>(
    `/metrics/${encodeURIComponent(metric)}?from=${from}&to=${to}&bucket=day`,
  );
  return data?.points ?? [];
}

/** 某个指标今天的值 (步数这类按天求和的) */
export function usePilotMetricToday(metric: string): number | null {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  /* to 是今天结束 (不是此刻): path 一天内不变, 否则每次 render 一个新 URL 就会反复请求 */
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const { data } = useJson<{ points: Array<{ day: string; value: number }> }>(
    `/metrics/${encodeURIComponent(metric)}?from=${from}&to=${to}&bucket=day`,
  );
  const p = data?.points?.find((x) => x.day === localToday(now)) ?? data?.points?.[data.points.length - 1];
  return p ? p.value : null;
}

export interface PilotRecordRow {
  id: string;
  type: string;
  occurred_at: number;
  title: string;
  value: number | null;
  unit: string | null;
  source: string;
  data: Record<string, unknown>;
}

/** 写几条记录 (跟手机同一个 /records/batch, ndjson 一行一条); 返回每条的结果 */
export async function putPilotRecords(records: Array<Record<string, unknown>>): Promise<Array<{ status: string; error?: string }>> {
  const fetchWithAuth = getEditionHook('fetchWithAuth');
  const withIds = records.map((r) => (typeof r.id === 'string' ? r : { ...r, id: ulid(typeof r.occurred_at === 'number' ? r.occurred_at : Date.now()) }));
  const res = await fetchWithAuth(`${BASE}/records/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-ndjson' },
    body: withIds.map((r) => JSON.stringify(r)).join('\n'),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return ((await res.json()) as { results: Array<{ status: string; error?: string }> }).results;
}

/** 软删一条记录 (自动化页删规则) */
export async function deletePilotRecord(id: string): Promise<void> {
  const fetchWithAuth = getEditionHook('fetchWithAuth');
  const res = await fetchWithAuth(`${BASE}/records/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`${res.status}`);
}

/** 记一条档案 (同 key 新的取代旧的): 简报 / 专员定时这些开关就存在这 */
export async function setPilotFact(key: string, value: unknown): Promise<void> {
  const r = await putPilotRecords([{ type: 'fact.assert', occurred_at: Date.now(), source: 'desktop', data: { key, value } }]);
  if (r[0]?.status === 'invalid') throw new Error(r[0].error || 'invalid');
}

/** 档案 (key → value) */
export function usePilotFacts(): Load<{ facts: Array<{ key: string; value: unknown }> }> {
  return useJson<{ facts: Array<{ key: string; value: unknown }> }>('/facts', 60_000);
}

/** 电脑自己的定位 (macOS 定位服务)。拿不到 (没授权 / 定位服务关着) 就给 error, 页面提示去系统设置打开 */
export function useDesktopPosition(): { pos: { lat: number; lng: number; acc: number } | null; error: string | null; locate: () => void } {
  const [pos, setPos] = useState<{ lat: number; lng: number; acc: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const locate = useCallback(() => {
    if (!navigator.geolocation) { setError('unsupported'); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => { setPos({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }); setError(null); },
      (e) => setError(e.code === 1 ? 'denied' : 'unavailable'),
      { timeout: 15_000, maximumAge: 10 * 60_000 },
    );
  }, []);
  useEffect(() => { locate(); }, [locate]);
  return { pos, error, locate };
}

/** 存的类型带版本号 ('finance.expense@1'), 比较前去掉 */
export const baseType = (t: string): string => t.split('@')[0];

/** 按类型取记录 (新的在前), from = 毫秒; 钱页的「最近」和这个月记了几笔都从这来 */
export function usePilotRecords(types: string[], opts: { from?: number; limit?: number } = {}): Load<{ records: PilotRecordRow[] }> {
  /* 钱 / 身体这些是 sensitive, 服务端默认不给, 要显式要 (房间页就是给本人看的) */
  const q = new URLSearchParams({ types: types.join(','), limit: String(opts.limit ?? 50), includeSensitive: 'true' });
  if (opts.from != null) q.set('from', String(opts.from));
  return useJson<{ records: PilotRecordRow[] }>(`/records?${q.toString()}`);
}

/** 金额: ¥1,240 / −¥15 (货币符号不跟语言走) */
export function yuan(n: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.round(Math.abs(n)).toLocaleString('en-US');
  if (opts.sign) return `${n < 0 ? '−' : '+'}¥${abs}`;
  return `${n < 0 ? '−' : ''}¥${abs}`;
}
