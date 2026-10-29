
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import { readPilotProfiles } from '@neoxlabs/core';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { getCurrentCall, inQuietHours } from './pilotCallService.js';
import { awaitSessionReply, enqueueToSessionRuntime } from './runtimeEnqueue.js';
import { pushFromPilot } from './pilotTelegram.js';

export interface PhoneSignal {
  app: string;
  package: string;
  title: string;
  text: string;
  at: number;
  category?: string;
  /** wake | ledger | drop */
  cls?: SignalClass;
  /** 给模型看的种类 */
  kind?: 'missed_call' | 'sms' | 'chat' | 'code' | 'other';
}
type SignalClass = 'wake' | 'ledger' | 'drop';

const KEEP = 300;
const KEEP_MS = 3 * 24 * 3_600_000;
const BATCH_MS = 60_000;
const MAX_WAKES_PER_HOUR = 6;

const SMS_PKG = /(messaging|mms|\.sms|message)/i;
const DIALER_PKG = /(dialer|incallui|\.phone$|contacts|telecom)/i;
const CHAT_PKG = /^(com\.tencent\.mm|com\.tencent\.mobileqq|com\.tencent\.tim|com\.whatsapp|org\.telegram|com\.alibaba\.android\.rimet|com\.ss\.android\.lark|com\.slack|com\.discord|jp\.naver\.line|com\.facebook\.orca|com\.tencent\.wework)/;
const SYSTEM_PKG = /^(android|com\.android\.systemui|com\.android\.settings|com\.android\.vending|com\.google\.android\.gms|com\.android\.providers\.downloads)$/;
const PROMO = /(退订|回T|回TD|拒收请回|促销|优惠券|限时|特惠|广告|抽奖|会员日|unsubscribe|promo)/i;
const CODE = /(验证码|校验码|动态码|verification code|security code|\bOTP\b|one-time)/i;
const MISSED = /(未接|missed call|missed)/i;

export function classify(s: PhoneSignal): PhoneSignal {
  const body = `${s.title} ${s.text}`;
  if (SYSTEM_PKG.test(s.package) || s.category === 'progress' || s.category === 'transport' || s.category === 'service') return { ...s, cls: 'drop', kind: 'other' };
  if (PROMO.test(body) || s.category === 'promo') return { ...s, cls: 'drop', kind: 'other' };
  if (CODE.test(body)) return { ...s, cls: 'ledger', kind: 'code' };
  if ((DIALER_PKG.test(s.package) || s.category === 'missed_call') && MISSED.test(body)) return { ...s, cls: 'wake', kind: 'missed_call' };
  if (s.category === 'call') return { ...s, cls: 'drop', kind: 'other' }; // 正在响的来电本身, 手机自己会响
  if (SMS_PKG.test(s.package)) return { ...s, cls: 'wake', kind: 'sms' };
  if (CHAT_PKG.test(s.package) || s.category === 'msg') return { ...s, cls: 'wake', kind: 'chat' };
  return { ...s, cls: 'ledger', kind: 'other' };
}

// ───────────────────────── 账本 ─────────────────────────

function filePath(): string {
  return join(homedir(), NEOX_HOME_DIRNAME, 'pilot-signals.json');
}

export function readSignals(): PhoneSignal[] {
  try {
    const raw = JSON.parse(readFileSync(filePath(), 'utf8'));
    return Array.isArray(raw) ? (raw as PhoneSignal[]) : [];
  } catch {
    return [];
  }
}

function writeSignals(list: PhoneSignal[]): void {
  try {
    const file = filePath();
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
    const floor = Date.now() - KEEP_MS;
    writeFileSync(`${file}.tmp`, JSON.stringify(list.filter((s) => s.at > floor).slice(0, KEEP)), 'utf8');
    renameSync(`${file}.tmp`, file);
  } catch (err) {
    console.warn('[PilotSignals] 写账本失败:', (err as Error)?.message);
  }
}

/** 巡检 ledger 用: 某个时间之后手机上值得一看的 (不含被丢掉的) */
export function signalsSince(ms: number, limit = 12): PhoneSignal[] {
  return readSignals().filter((s) => s.at > ms && s.cls !== 'drop').slice(0, limit);
}

// ───────────────────────── 叫醒 ─────────────────────────

let pending: PhoneSignal[] = [];
let batchTimer: NodeJS.Timeout | null = null;
const wakeHistory: number[] = [];

/** 分工里写着管手机 / 消息的那个 Pilot (手机上的 pilot_local.dart 用同一个词表) */
export const PHONE_DUTY = /(手机|消息|短信|电话|通知|微信|phone|message|sms|call)/i;

/** 叫醒哪个 Pilot: 分工里管手机消息的那个; 没有就最近说过话的那个 */
function targetPilot(): { sessionId: string; name: string } | null {
  const profiles = readPilotProfiles();
  const duty = Object.entries(profiles).find(([, p]) => PHONE_DUTY.test(p.persona ?? ''));
  if (duty) return { sessionId: duty[0], name: duty[1].name };
  let best: { sessionId: string; name: string; at: number } | null = null;
  for (const [sessionId, p] of Object.entries(profiles)) {
    let at = p.createdAt ?? 0;
    try {
      const s = getDatabase().getSession(sessionId) as { updatedAt?: number; updated_at?: number } | null;
      at = Number(s?.updatedAt ?? s?.updated_at ?? at) || at;
    } catch { /* 库读不到用建档时间 */ }
    if (!best || at > best.at) best = { sessionId, name: p.name, at };
  }
  return best ? { sessionId: best.sessionId, name: best.name } : null;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const hm = (ms: number) => new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

function signalXml(batch: PhoneSignal[]): string {
  const items = batch.map((s) =>
    `<n kind="${s.kind}" app="${esc(s.app)}" at="${hm(s.at)}">${esc(s.title)}${s.text ? `: ${esc(s.text.slice(0, 300))}` : ''}</n>`).join('');
  const instruction =
    '手机上刚来了这些 (用户现在没在跟你说话)。按你的分工判断要不要管: '
    + '要他马上知道或拍板的 (重要的人找他、未接来电可能要回、出了状况) → report_to_user, 急的用 urgent (会打电话), 该尽快知道用 attention; '
    + '能只读查一下就说清楚的先查 (比如快递到哪了、这个号码是谁); '
    + '不替他回消息、不回拨、不下单。没什么要紧 → 只回复 [quiet], 别的字一个都不要写。'
    + '要开口时, 第一句先说是哪个 App 里谁的消息 (比如「微信群硅碳AI诊疗答疑群通知:」), 他看不到这条通知原文。';
  return `<phone-signal><now>${new Date().toLocaleString('zh-CN', { hour12: false })}</now><items>${items}</items><instruction>${instruction}</instruction></phone-signal>`;
}

async function wake(): Promise<void> {
  batchTimer = null;
  const batch = pending;
  pending = [];
  if (!batch.length) return;
  const now = Date.now();
  while (wakeHistory.length && wakeHistory[0] < now - 3_600_000) wakeHistory.shift();
  /* 勿扰时段 / 本小时叫够了: 不叫, 账本里有, 巡检时会看到 */
  const urgent = batch.some((s) => s.kind === 'missed_call');
  if (inQuietHours(new Date()) || (wakeHistory.length >= MAX_WAKES_PER_HOUR && !urgent)) return;
  const pilot = targetPilot();
  if (!pilot || getCurrentCall()?.sessionId === pilot.sessionId) return;
  wakeHistory.push(now);
  const reply = awaitSessionReply(pilot.sessionId, 10 * 60_000);
  const ok = await enqueueToSessionRuntime(pilot.sessionId, signalXml(batch), { kind: 'cron', command: `phone: ${batch.length} 条` });
  console.log(`[PilotSignals] wake ${pilot.name}: ${batch.length} 条 (${batch.map((s) => s.kind).join(',')}) ${ok ? 'enqueued' : 'runtime unavailable'}`);
  /* 它说了话 (不是 [quiet]) 而你不在电脑前 → 推到 Telegram; 要打电话的那种走 report_to_user 自己的阶梯 */
  if (ok) {
    void reply.then((text) => {
      const said = text.trim();
      if (said && !said.endsWith('[quiet]')) void pushFromPilot(pilot.sessionId, said, { onlyWhenAway: true });
    });
  }
}

/** mobile-bridge `phone.signals` 进来 */
export function ingestSignals(items: unknown[]): { ok: true; accepted: number; wake: number } {
  const existing = readSignals();
  const seen = new Set(existing.map((s) => `${s.package}|${s.at}|${s.title}`));
  const fresh: PhoneSignal[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const s: PhoneSignal = {
      app: String(r.app ?? ''), package: String(r.package ?? ''), title: String(r.title ?? ''),
      text: String(r.text ?? ''), at: Number(r.at) || Date.now(), category: typeof r.category === 'string' ? r.category : undefined,
    };
    const key = `${s.package}|${s.at}|${s.title}`;
    if (seen.has(key)) continue; // 断线补拉会重复送, 同一条只认一次
    seen.add(key);
    fresh.push(classify(s));
  }
  if (fresh.length) writeSignals([...fresh.filter((s) => s.cls !== 'drop'), ...existing]);
  /* 补拉来的旧通知 (超过 30 分钟) 不叫醒 —— 早就过去的事, 记进账本等巡检看 */
  /* 电脑不在时手机上的它已经看过的 (handled): 只进账本, 不再叫醒电脑上的它判第二遍 (手机 pilot_local.dart) */
  const handled = new Set(items.filter((r) => (r as { handled?: unknown })?.handled === true).map((r) => {
    const x = r as Record<string, unknown>;
    return `${x.package ?? ''}|${Number(x.at) || 0}|${x.title ?? ''}`;
  }));
  const wakeNow = fresh.filter((s) => s.cls === 'wake' && Date.now() - s.at < 30 * 60_000 && !handled.has(`${s.package}|${s.at}|${s.title}`));
  if (wakeNow.length) {
    pending.push(...wakeNow);
    /* 攒批从第一条算起 60 秒 (群聊一直刷也不会一直往后推); 未接来电不等, 5 秒就叫 —— 可能要马上回 */
    const urgent = wakeNow.some((s) => s.kind === 'missed_call');
    if (!batchTimer || urgent) {
      if (batchTimer) clearTimeout(batchTimer);
      batchTimer = setTimeout(() => { void wake(); }, urgent ? 5_000 : BATCH_MS);
    }
  }
  return { ok: true, accepted: fresh.length, wake: wakeNow.length };
}
