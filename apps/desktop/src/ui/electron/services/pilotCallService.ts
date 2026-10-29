
import { BrowserWindow, Notification } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@neoxlabs/platform/utils/config.js';
import { DEFAULT_QUIET_HOURS, inQuietWindow, normalizeQuietHours } from '@neoxlabs/pilot-data-sdk';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { getPilotProfile, type CallUserRequest, type CallUserResult, type CallUrgency } from '@neoxlabs/core';
import { closeCallWindow, getCallWindow, openCallWindow, setCallWindowLayout, type CallWindowOpts } from './pilotCallWindow.js';

export type CallDirection = 'incoming' | 'outgoing';
export type CallSource = 'agent' | 'reminder' | 'snooze' | 'user';

/** 发给小窗 / 主窗口的通话快照 */
export interface PilotCall {
  id: string;
  sessionId: string | null;
  pilotName: string;
  avatar: 'cat' | 'corgi';
  reason: string;
  opening: string;
  urgency: CallUrgency;
  direction: CallDirection;
  source: CallSource;
  phase: 'ringing' | 'active' | 'ended';
  ringingAt: number;
  answeredAt?: number;
  ringSeconds: number;
  muted: boolean;
  /** 界面语言 —— 小窗是独立页面, 拿不到主窗口的 i18n, 跟着通话快照带过去 */
  lang: 'zh' | 'en';
  /** 响在哪: 电脑小窗, 还是手机 (你不在电脑前时, 见 pilotPhoneLink) */
  device?: 'desktop' | 'phone';
}

/** 手机那一头 —— 由 pilotPhoneLink 在手机连接起来后挂上, 这里不依赖手机连接的实现 */
interface PhoneRinger {
  shouldRingPhone(): boolean;
  /** 有手机连着 (不管人在不在电脑前) —— 「试打到手机」用 */
  phoneConnected(): boolean;
  ring(call: PilotCall): void;
  stop(callId: string, reason: string): void;
}
let phoneRinger: PhoneRinger | null = null;
export function setPhoneRinger(r: PhoneRinger | null): void {
  phoneRinger = r;
}

function uiLang(): 'zh' | 'en' {
  try {
    return (loadConfig() as { language?: string }).language === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

/** 通话里的实时状态 (主窗口渲染层上报, 转给小窗) */
export interface CallLiveReport {
  callId: string;
  voice: 'connecting' | 'listening' | 'thinking' | 'speaking' | 'paused' | 'error';
  caption?: string;
  level?: number;
}

export interface CallLogEntry {
  id: string;
  sessionId: string | null;
  pilotName: string;
  reason: string;
  direction: CallDirection;
  source: CallSource;
  outcome: 'answered' | 'declined' | 'missed' | 'busy' | 'blocked' | 'snoozed';
  detail?: string;
  at: number;
  durationMs?: number;
}

const DEFAULT_RING_SECONDS = 25;
/* host-call 在 worker 侧 30s 超时, 响铃必须比它短, 否则工具先超时、电话还在响 */
const MAX_RING_SECONDS = 27;
const SNOOZE_MS = 10 * 60_000;
const LOG_KEEP = 200;

let windowOpts: CallWindowOpts | null = null;
let current: PilotCall | null = null;
let settle: ((r: CallUserResult) => void) | null = null;
let ringTimer: NodeJS.Timeout | null = null;
const unaskedHistory: number[] = [];

export function configurePilotCalls(opts: CallWindowOpts): void {
  windowOpts = opts;
}

export function getCurrentCall(): PilotCall | null {
  return current;
}

// ───────────────────────── 通话记录 ─────────────────────────

function logPath(): string {
  return join(homedir(), NEOX_HOME_DIRNAME, 'pilot-calls.json');
}

export function readCallLog(): CallLogEntry[] {
  try {
    const raw = JSON.parse(readFileSync(logPath(), 'utf8'));
    return Array.isArray(raw) ? raw as CallLogEntry[] : [];
  } catch {
    return [];
  }
}

function appendCallLog(entry: CallLogEntry): void {
  try {
    const list = [entry, ...readCallLog()].slice(0, LOG_KEEP);
    const file = logPath();
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(list, null, 2), 'utf8');
    renameSync(`${file}.tmp`, file);
  } catch (err) {
    console.warn('[PilotCall] 写通话记录失败:', (err as Error)?.message);
  }
  broadcastToMain('pilot-call:log-changed', { entry });
}

/** 删 Pilot 时连它的通话记录一起删 */
export function removeCallLogFor(sessionId: string): void {
  const list = readCallLog().filter((e) => e.sessionId !== sessionId);
  try {
    writeFileSync(logPath(), JSON.stringify(list, null, 2), 'utf8');
  } catch { /* 文件不在 = 本来就没有 */ }
}

// ───────────────────────── 放不放行 ─────────────────────────

/** 勿扰: 没存过就是统一口径 22:30–07:30, 跟通知 / 手机 / 触发引擎同一份 (pilot:P-03) */
export function inQuietHours(now: Date): boolean {
  const raw = (loadConfig() as { lifeQuietHours?: { enabled?: boolean; start?: string; end?: string } }).lifeQuietHours;
  const q = normalizeQuietHours({ ...DEFAULT_QUIET_HOURS, ...(raw ?? {}) });
  if (!q.enabled) return false;
  return inQuietWindow(now, q);
}

/** 为什么不能打; null = 可以 */
function refusal(urgency: CallUrgency, source: CallSource, sessionId?: string): { status: CallUserResult['status']; detail: string } | null {
  if (current) return { status: 'busy', detail: 'already in a call' };
  const pilot = (loadConfig() as { pilot?: { callOn?: Record<string, boolean>; maxUnaskedPerHour?: number } }).pilot ?? {};
  const callOn = pilot.callOn ?? {};
  /* 用户亲口让打的 (含到点叫醒 / 稍后再打) 不受勿扰和上限限制 —— 那就是他要的 */
  const asked = urgency === 'asked' || source === 'snooze';
  if (asked) return null;
  if (source === 'reminder' && callOn.reminders === false) return { status: 'blocked', detail: 'reminder calls are turned off' };
  if (source === 'reminder' && sessionId && getPilotProfile(sessionId)?.ringReminders === false) {
    return { status: 'blocked', detail: 'this pilot is set to not call for reminders' };
  }
  if (urgency === 'decision' && callOn.decisions === false) return { status: 'blocked', detail: 'decision calls are turned off' };
  if (urgency === 'alert' && callOn.alerts === false) return { status: 'blocked', detail: 'alert calls are turned off' };
  /* agent 自己觉得要紧 (normal) 默认不打, 用户在 Pilot 设置里打开才打 */
  if (urgency === 'normal' && callOn.agent !== true) return { status: 'blocked', detail: 'the user only takes calls they asked for, decisions and alerts' };
  if (inQuietHours(new Date())) return { status: 'busy', detail: 'quiet hours' };
  const cap = Math.max(0, pilot.maxUnaskedPerHour ?? 3);
  const hourAgo = Date.now() - 3_600_000;
  while (unaskedHistory.length && unaskedHistory[0] < hourAgo) unaskedHistory.shift();
  if (unaskedHistory.length >= cap) return { status: 'busy', detail: `already called ${cap} times this hour` };
  return null;
}

// ───────────────────────── 窗口 / 广播 ─────────────────────────

const AUX_PAGES = ['/call.html', '/pet.html', '/pet3d.html', '/overlay.html'];

/** 主窗口 = 加载的不是这几个辅助页面的窗口 */
export function mainWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((w) => {
    if (w.isDestroyed() || w.webContents.isDestroyed()) return false;
    const url = w.webContents.getURL();
    return !AUX_PAGES.some((p) => url.includes(p));
  });
}

function broadcastToMain(channel: string, payload: unknown): void {
  for (const w of mainWindows()) {
    try { w.webContents.send(channel, payload); } catch { /* 窗口正在关 */ }
  }
}

function pushToCallWindow(channel: string, payload: unknown): void {
  const win = getCallWindow();
  if (!win) return;
  try { win.webContents.send(channel, payload); } catch { /* ignore */ }
}

function publish(): void {
  pushToCallWindow('pilot-call:state', current);
  broadcastToMain('pilot-call:state', current);
}

/** 通话期间主窗口哪怕藏着也不许节流 —— 语义收口靠 400ms 计时器, 节流成 1s 一跳就会抢话 */
function setMainThrottling(allow: boolean): void {
  for (const w of mainWindows()) {
    try { w.webContents.setBackgroundThrottling(allow); } catch { /* ignore */ }
  }
  if (allow) unwatchMain();
  else watchMain();
}

let unwatchers: Array<() => void> = [];
function watchMain(): void {
  unwatchMain();
  for (const w of mainWindows()) {
    const wc = w.webContents;
    const onNav = (_e: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
      if (isMainFrame && !isInPlace) hangupCall('error');
    };
    const onGone = () => hangupCall('error');
    wc.on('did-start-navigation', onNav);
    wc.on('render-process-gone', onGone);
    w.on('closed', onGone);
    unwatchers.push(() => {
      try { wc.off('did-start-navigation', onNav); wc.off('render-process-gone', onGone); } catch { /* 已销毁 */ }
      try { w.off('closed', onGone); } catch { /* 已销毁 */ }
    });
  }
}
function unwatchMain(): void {
  const list = unwatchers;
  unwatchers = [];
  for (const off of list) off();
}

function describePilot(sessionId: string | null): { name: string; avatar: 'cat' | 'corgi' } {
  const profile = getPilotProfile(sessionId);
  if (profile) return { name: profile.name, avatar: profile.avatar };
  let name = 'Neox';
  try {
    const s = sessionId ? getDatabase().getSession(sessionId) : null;
    if (s?.name) name = s.name;
  } catch { /* 库不可用就叫 Neox */ }
  return { name, avatar: 'cat' };
}

// ───────────────────────── 来电 ─────────────────────────

/** 最近一通响完没接 / 拒接的电话 —— ringUser 据此决定要不要转手机、发未接通知 */
let lastEnded: PilotCall | null = null;

export async function ringUser(req: CallUserRequest, source: CallSource = 'agent', opts: { device?: 'phone' } = {}): Promise<CallUserResult> {
  lastEnded = null;
  let result = await ringOnce(req, source, opts);
  let ended = lastEnded as PilotCall | null;
  if (result.status === 'missed' && ended?.device === 'desktop' && phoneRinger?.phoneConnected()) {
    lastEnded = null;
    const onPhone = await ringOnce(req, source, { device: 'phone', followUp: true });
    if (onPhone.status !== 'blocked' && onPhone.status !== 'busy') {
      result = onPhone.status === 'missed'
        ? { status: 'missed', detail: 'rang the desktop, then the phone; nobody picked up' }
        : onPhone;
      ended = lastEnded;
    }
  }
  if (result.status === 'missed' && ended) notifyMissed(ended);
  return result;
}

async function ringOnce(
  req: CallUserRequest,
  source: CallSource,
  opts: { device?: 'phone'; followUp?: boolean },
): Promise<CallUserResult> {
  /* 转手机那一段是同一通电话的延续: 不再过一遍闸, 也不再记一次「主动来电」 */
  const no = opts.followUp ? (current ? { status: 'busy' as const, detail: 'already in a call' } : null) : refusal(req.urgency, source, req.sessionId);
  if (no) {
    appendCallLog({
      id: randomUUID(), sessionId: req.sessionId ?? null, pilotName: describePilot(req.sessionId ?? null).name,
      reason: req.reason, direction: 'incoming', source, outcome: no.status, detail: no.detail, at: Date.now(),
    });
    return no;
  }
  if (!windowOpts) return { status: 'blocked', detail: 'call window not configured' };

  const ringSeconds = Math.min(MAX_RING_SECONDS, Math.max(8,
    (loadConfig() as { pilot?: { ringSeconds?: number } }).pilot?.ringSeconds ?? DEFAULT_RING_SECONDS));
  const pilot = describePilot(req.sessionId ?? null);
  current = {
    id: randomUUID(),
    sessionId: req.sessionId ?? null,
    pilotName: pilot.name,
    avatar: pilot.avatar,
    reason: req.reason,
    opening: req.opening,
    urgency: req.urgency,
    direction: 'incoming',
    source,
    phase: 'ringing',
    ringingAt: Date.now(),
    ringSeconds,
    muted: false,
    lang: uiLang(),
  };
  if (req.urgency !== 'asked' && source !== 'snooze' && !opts.followUp) unaskedHistory.push(Date.now());

  /* 你不在电脑前、手机连着 → 响手机, 电脑不弹小窗 */
  if (opts.device === 'phone' && !phoneRinger?.phoneConnected()) {
    current = null;
    return { status: 'blocked', detail: 'no phone connected' };
  }
  if (phoneRinger && (opts.device === 'phone' || phoneRinger.shouldRingPhone())) {
    current.device = 'phone';
    phoneRinger.ring(current);
    publish();
    return new Promise<CallUserResult>((resolve) => {
      settle = resolve;
      ringTimer = setTimeout(() => endRinging('missed'), ringSeconds * 1000);
    });
  }
  current.device = 'desktop';

  try {
    await openCallWindow(windowOpts);
    setCallWindowLayout('ringing');
  } catch (err) {
    console.error('[PilotCall] 来电窗口打不开:', err);
    const failed = current;
    current = null;
    appendCallLog({ id: failed.id, sessionId: failed.sessionId, pilotName: failed.pilotName, reason: failed.reason,
      direction: 'incoming', source, outcome: 'blocked', detail: 'call window failed', at: Date.now() });
    return { status: 'blocked', detail: 'call window failed to open' };
  }
  publish();
  /* 主窗口趁响铃把开场白合成好, 接起即播 */
  broadcastToMain('pilot-call:incoming', current);

  return new Promise<CallUserResult>((resolve) => {
    settle = resolve;
    ringTimer = setTimeout(() => endRinging('missed'), ringSeconds * 1000);
  });
}

function finishRing(result: CallUserResult): void {
  if (ringTimer) { clearTimeout(ringTimer); ringTimer = null; }
  const done = settle;
  settle = null;
  done?.(result);
}

function endRinging(outcome: 'declined' | 'missed' | 'snoozed'): void {
  const call = current;
  if (!call || call.phase !== 'ringing') return;
  current = null;
  closeCallWindow();
  if (call.device === 'phone') phoneRinger?.stop(call.id, outcome);
  broadcastToMain('pilot-call:state', null);
  appendCallLog({ id: call.id, sessionId: call.sessionId, pilotName: call.pilotName, reason: call.reason,
    direction: 'incoming', source: call.source, outcome, at: Date.now() });

  /* 未接通知不在这里发: 电脑没接还要转手机, 由 ringUser 在最后一段之后发一次 */
  if (outcome === 'missed') lastEnded = call;
  if (outcome === 'snoozed') {
    setTimeout(() => {
      void ringUser({ sessionId: call.sessionId ?? undefined, reason: call.reason, opening: call.opening, urgency: 'asked' }, 'snooze');
    }, SNOOZE_MS);
  }
  finishRing(outcome === 'snoozed'
    ? { status: 'declined', detail: 'the user asked to be called back in 10 minutes; Neox will ring again by itself' }
    : { status: outcome });
}

/** 未接来电的外部去处 (Telegram 等), 由各自模块挂上来 —— 这里不依赖它们 */
const missedListeners = new Set<(call: PilotCall) => void>();
export function onMissedCall(fn: (call: PilotCall) => void): () => void {
  missedListeners.add(fn);
  return () => { missedListeners.delete(fn); };
}

function notifyMissed(call: PilotCall): void {
  for (const fn of missedListeners) {
    try { fn(call); } catch (err) { console.warn('[PilotCall] missed listener failed:', (err as Error)?.message); }
  }
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: `未接来电 · ${call.pilotName}`, body: call.reason, silent: true });
    n.on('click', () => {
      const w = mainWindows()[0];
      if (!w) return;
      if (w.isMinimized()) w.restore();
      w.show(); w.focus();
      w.webContents.send('pilot-call:open-session', { sessionId: call.sessionId });
    });
    n.show();
  } catch { /* 通知失败不影响记录 */ }
}

// ───────────────────────── 按钮 ─────────────────────────

export function acceptCall(): void {
  const call = current;
  if (!call || call.phase !== 'ringing') return;
  call.phase = 'active';
  call.answeredAt = Date.now();
  if (call.device === 'phone') {
    /* 手机上接的: 对话在手机上进行, 电脑这边只记状态, 不起语音 */
    publish();
    finishRing({ status: 'answered', detail: 'answered on the phone; keep talking in this conversation' });
    return;
  }
  setCallWindowLayout('active');
  setMainThrottling(false);
  publish();
  broadcastToMain('pilot-call:connect', call);
  finishRing({ status: 'answered' });
}

export function declineCall(): void {
  endRinging('declined');
}

export function snoozeCall(): void {
  endRinging('snoozed');
}

/** 通话中挂断 (小窗按钮 / 主窗口里的挂断 / 渲染层出错都走这里) */
export function hangupCall(reason: 'user' | 'error' = 'user'): void {
  const call = current;
  if (!call) return;
  if (call.phase === 'ringing') { declineCall(); return; }
  current = null;
  closeCallWindow();
  if (call.device === 'phone') phoneRinger?.stop(call.id, 'hangup');
  setMainThrottling(true);
  broadcastToMain('pilot-call:state', null);
  broadcastToMain('pilot-call:end', { callId: call.id, reason });
  appendCallLog({ id: call.id, sessionId: call.sessionId, pilotName: call.pilotName, reason: call.reason,
    direction: call.direction, source: call.source, outcome: 'answered', at: call.ringingAt,
    durationMs: call.answeredAt ? Date.now() - call.answeredAt : undefined });
}

/** 手机上接 / 挂 / 通话结束 (pilot.call_event)。对不上当前这通电话就忽略 (迟到的、别的手机的) */
export function phoneCallEvent(callId: string, event: 'accepted' | 'declined' | 'ended'): boolean {
  const call = current;
  if (!call || call.id !== callId || call.device !== 'phone') return false;
  if (event === 'accepted') acceptCall();
  else if (event === 'declined') declineCall();
  else hangupCall('user');
  return true;
}

export function setCallMuted(muted: boolean): void {
  if (!current) return;
  current.muted = muted;
  publish();
}

/** 用户主动打给 Pilot: 没有响铃, 直接进通话态 */
export async function startOutgoingCall(sessionId: string): Promise<PilotCall | null> {
  if (current) return null;
  const pilot = describePilot(sessionId);
  current = {
    id: randomUUID(), sessionId, pilotName: pilot.name, avatar: pilot.avatar,
    reason: '', opening: '', urgency: 'asked', direction: 'outgoing', source: 'user',
    phase: 'active', ringingAt: Date.now(), answeredAt: Date.now(), ringSeconds: 0, muted: false, lang: uiLang(),
  };
  setMainThrottling(false);
  if (windowOpts) {
    try {
      await openCallWindow(windowOpts);
      setCallWindowLayout('active');
    } catch (err) {
      console.warn('[PilotCall] 通话条窗口打不开 (通话照常):', (err as Error)?.message);
    }
  }
  publish();
  return current;
}

/** 渲染层上报的实时状态 (听 / 想 / 说 + 字幕 + 电平) 转给小窗 */
export function relayLiveReport(report: CallLiveReport): void {
  if (!current || report.callId !== current.id) return;
  pushToCallWindow('pilot-call:live', report);
}

/** 退出前: 还在响的当没接, 通话中的直接挂 */
export function shutdownPilotCalls(): void {
  if (current?.phase === 'ringing') endRinging('missed');
  else if (current) hangupCall('error');
}
