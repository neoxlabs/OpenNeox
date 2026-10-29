import { useSyncExternalStore } from 'react';

export type PilotAvatarKind = 'cat' | 'corgi';

export interface PilotProfile {
  name: string;
  avatar: PilotAvatarKind;
  /** 分身卡上的造型 (v3/pilotLooks.ts), 不填 = 素的 */
  look?: string;
  voice?: string;
  /** 到点提醒打不打电话; false = 只弹通知 */
  ringReminders?: boolean;
  persona?: string;
  patrolMinutes?: number;
  lastPatrolAt?: number;
  createdAt: number;
}

export interface PilotCall {
  id: string;
  sessionId: string | null;
  pilotName: string;
  avatar: PilotAvatarKind;
  reason: string;
  opening: string;
  urgency: string;
  direction: 'incoming' | 'outgoing';
  source: string;
  phase: 'ringing' | 'active' | 'ended';
  ringingAt: number;
  answeredAt?: number;
  ringSeconds: number;
  muted: boolean;
}

export interface CallLogEntry {
  id: string;
  sessionId: string | null;
  pilotName: string;
  reason: string;
  direction: 'incoming' | 'outgoing';
  source: string;
  outcome: 'answered' | 'declined' | 'missed' | 'busy' | 'blocked' | 'snoozed';
  detail?: string;
  at: number;
  durationMs?: number;
}

export type PilotView = 'chat' | 'board';

interface PilotApi {
  pilotProfiles?: () => Promise<Record<string, PilotProfile>>;
  pilotSaveProfile?: (sessionId: string, patch: Partial<PilotProfile>) => Promise<{ ok: boolean; profile?: PilotProfile }>;
  pilotCallCurrent?: () => Promise<PilotCall | null>;
  pilotCallLog?: () => Promise<CallLogEntry[]>;
  pilotCallAction?: (a: string) => Promise<unknown>;
  pilotCallStartOutgoing?: (sessionId: string) => Promise<{ ok: boolean; call?: PilotCall; error?: string }>;
  pilotCallTestRing?: (req: { sessionId?: string; reason?: string; opening?: string; device?: 'phone' }) => Promise<{ status: string; detail?: string }>;
  onPilotCall?: (ev: string, cb: (p: any) => void) => () => void;
}
export const pilotApi = (): PilotApi => ((window as unknown as { neox?: PilotApi }).neox ?? {});

interface Snapshot {
  profiles: Record<string, PilotProfile>;
  call: PilotCall | null;
  log: CallLogEntry[];
  view: PilotView;
  /** 对话区显示: 文字 (消息流) / 形象 (3D 角色 + 对白框) */
  stage: boolean;
  loaded: boolean;
}

const VIEW_KEY = 'neox-pilot-view';
const STAGE_KEY = 'neox-pilot-stage';
function readView(): PilotView {
  try { return window.localStorage.getItem(VIEW_KEY) === 'board' ? 'board' : 'chat'; } catch { return 'chat'; }
}
/** 默认看形象 (它站在你面前), 切到记录才是一列消息 */
function readStage(): boolean {
  try { return window.localStorage.getItem(STAGE_KEY) !== '0'; } catch { return true; }
}

let snap: Snapshot = { profiles: {}, call: null, log: [], view: readView(), stage: readStage(), loaded: false };
const listeners = new Set<() => void>();
function set(patch: Partial<Snapshot>): void {
  snap = { ...snap, ...patch };
  for (const l of listeners) l();
}

let started = false;
function start(): void {
  if (started) return;
  started = true;
  void refreshPilots();
  const api = pilotApi();
  api.onPilotCall?.('state', (c: PilotCall | null) => set({ call: c }));
  api.onPilotCall?.('log-changed', () => { void api.pilotCallLog?.().then((log) => set({ log: log ?? [] })).catch(() => {}); });
}

export async function refreshPilots(): Promise<void> {
  const api = pilotApi();
  const [profiles, call, log] = await Promise.all([
    api.pilotProfiles?.().catch(() => ({})) ?? {},
    api.pilotCallCurrent?.().catch(() => null) ?? null,
    api.pilotCallLog?.().catch(() => []) ?? [],
  ]);
  set({ profiles: (profiles ?? {}) as Record<string, PilotProfile>, call: (call ?? null) as PilotCall | null, log: (log ?? []) as CallLogEntry[], loaded: true });
}

export async function savePilotProfile(sessionId: string, patch: Partial<PilotProfile>): Promise<PilotProfile | null> {
  const r = await pilotApi().pilotSaveProfile?.(sessionId, patch).catch(() => null);
  if (r?.ok && r.profile) {
    set({ profiles: { ...snap.profiles, [sessionId]: r.profile } });
    return r.profile;
  }
  return null;
}

export function setPilotView(view: PilotView): void {
  try { window.localStorage.setItem(VIEW_KEY, view); } catch { /* 记不住就每次回默认 */ }
  set({ view });
}

export function setPilotStage(stage: boolean): void {
  try { window.localStorage.setItem(STAGE_KEY, stage ? '1' : '0'); } catch { /* 记不住就每次回文字 */ }
  set({ stage });
}

function subscribe(fn: () => void): () => void {
  start();
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function usePilotState(): Snapshot {
  return useSyncExternalStore(subscribe, () => snap, () => snap);
}

/** 这个分身的声音 (档案 voice); 没选 = undefined = 跟设置里的 */
export function pilotVoice(sessionId: string | null | undefined): string | undefined {
  return (sessionId && snap.profiles[sessionId]?.voice) || undefined;
}

/** 一个 Pilot 的显示名: 档案名 > 会话名 */
export function pilotDisplayName(sessionId: string, fallback: string): string {
  return snap.profiles[sessionId]?.name || fallback || 'Pilot';
}
