import { randomUUID } from 'node:crypto';
import { powerMonitor } from 'electron';
import {
  setHostCapabilities, setPhoneExecutor, withApproval, type PhoneExecRequest, type PhoneExecResult, readPilotProfiles, spokenLeadOf,
} from '@neoxlabs/core';
import type { MobileBridgeServer } from '../mobile-bridge/wsServer.js';
import { makeNotification } from '../mobile-bridge/jsonRpc.js';
import { getCurrentCall, hangupCall, phoneCallEvent, setPhoneRinger, type PilotCall } from './pilotCallService.js';
import { agentBridgeForSession } from './runtimeEnqueue.js';
import { getPilotProfile } from '@neoxlabs/core';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { getLifeEventsStore } from '@neoxlabs/core/life/index.js';
import { answerReport, markReportsRead, readReports } from './pilotReports.js';
import { ingestSignals } from './pilotSignals.js';
import { loadConfig } from '@neoxlabs/platform/utils/config.js';
import { DEFAULT_QUIET_HOURS } from '@neoxlabs/pilot-data-sdk';
import { phonePushable, pushToPhone, refreshPhonePushable } from './pilotPhonePush.js';
import { getDeviceId } from '../mobile-bridge/deviceStore.js';

/** 两分钟没碰电脑算不在电脑前 —— 比 Telegram 推送 (5 分钟) 敏感: 来电是要人马上接的 */
const AWAY_SECONDS = 120;
const SPEAK_MAX_CHARS = 600;
/** 手机执行一个动作最多等多久 —— 系统授权框手机端自己 2 分钟收口, 这里多留一点 */
const PHONE_EXEC_TIMEOUT_MS = 140_000;

function awayFromDesktop(): boolean {
  try { return powerMonitor.getSystemIdleState(AWAY_SECONDS) !== 'active'; } catch { return false; }
}

/** 最近一通打到手机的电话 + 在哪台接的 —— 推送叫醒的手机晚连上来时, 据此告诉它别响了 */
let lastPhoneCall: { id: string; at: number } | null = null;
let answeredBy: string | null = null;
/** 这通推送过 (有手机的系统来电是推送弹的) —— 结束时才需要再推一条撤铃 */
const pushedCalls = new Set<string>();

/** 推「这通别响了」: 只给推送叫醒过的来电发 (wake 不显示, 手机原生侧按 call_id 撤铃, NeoxPushService) */
function pushCallEnd(callId: string): void {
  if (!pushedCalls.delete(callId)) return;
  void pushToPhone('wake', '', '', { neox_action: 'call_end', call_id: callId });
}

export function attachPilotPhoneLink(server: MobileBridgeServer): void {
  /* ── 来电 ── */
  /* 手机够得着 = 连着, 或者 App 被杀了但能推送叫醒 (pilotPhonePush) */
  const phoneReachable = () => server.openConnCount() > 0 || phonePushable();
  void refreshPhonePushable();
  const callNote = (call: PilotCall) => makeNotification('pilot.call', {
    call_id: call.id,
    session_id: call.sessionId,
    pilot_name: call.pilotName,
    avatar: call.avatar,
    reason: call.reason,
    opening: call.opening,
    urgency: call.urgency,
    ring_seconds: call.ringSeconds,
    rang_at: call.ringingAt,
  });
  setPhoneRinger({
    shouldRingPhone: () => awayFromDesktop() && phoneReachable(),
    phoneConnected: phoneReachable,
    ring: (call: PilotCall) => {
      lastPhoneCall = { id: call.id, at: Date.now() };
      answeredBy = null;
      /* 只响一台: 连着的手机里最近在用的那台 (几台一起响, 接了一台另一台还在叫) */
      const target = server.mostRecentConn();
      console.log(`[PilotCall] 来电 ${call.id.slice(0, 8)} → ${target ? `${target.mobile.device_name} (${target.transport}, 前台=${target.foreground ?? '未报'})` : `没有连着的手机, 推送`}`);
      let sent = false;
      if (target) {
        try { target.sendRaw(JSON.stringify(callNote(call))); sent = true; } catch { /* 连接刚断: 走下面的推送 */ }
      }
      /* 连着的那台此刻不在你手上 (在后台 / 没报), 或者一台都没连 —— 你手上那部可能连着另一台电脑、或者 App 没开:
       * 推送叫醒账号下的手机。带上是哪台电脑打的, 接起来时手机先切到这台 (pilot_call_controller._onAction)。
       * 同一部手机推送和直连都到了也只响一次 (同一个 call_id, 系统来电同一个通知位) */
      if (!sent || target?.foreground !== true) {
        pushedCalls.add(call.id);
        void pushToPhone('call', call.pilotName, call.opening || call.reason, {
          call_id: call.id, session_id: call.sessionId ?? '', ring_seconds: String(call.ringSeconds), desktop_id: getDeviceId(),
        });
      }
    },
    /* 别处接了 / 没接超时 / 电脑这边挂了: 让手机别再响、或结束通话界面 */
    stop: (callId: string, reason: string) => {
      server.broadcastToAllConns(makeNotification('pilot.call_end', { call_id: callId, reason }));
      pushCallEnd(callId);
    },
  });

  /* 手机断了 (App 被杀 / 网络掉了 / 重装): 在手机上进行的那通电话跟着结束, 不然电脑一直以为在打, 后面的来电全成 busy */
  server.onConnClosed(() => {
    const call = getCurrentCall();
    if (call?.device === 'phone' && call.phase === 'active' && server.openConnCount() === 0) hangupCall('error');
  });

  /* 推送叫醒的手机连回来了:
   *  - 还在响 → 补发给它 (它点的就是这通电话的通知)
   *  - 别的手机已经接了 / 这通已经结束 → 告诉它别响了 (推送是发给账号下所有手机的, 系统来电各自在响) */
  server.onConnOpened((conn) => {
    if (!conn.isOpen()) return;
    const call = getCurrentCall();
    if (call?.device === 'phone' && call.phase === 'ringing') {
      try { conn.sendRaw(JSON.stringify(callNote(call))); } catch { /* 连接刚断 */ }
      return;
    }
    if (lastPhoneCall && Date.now() - lastPhoneCall.at < 3 * 60_000 && conn.mobile.device_id !== answeredBy) {
      const reason = call?.id === lastPhoneCall.id && call.phase === 'active' ? 'answered_elsewhere' : 'ended';
      try { conn.sendRaw(JSON.stringify(makeNotification('pilot.call_end', { call_id: lastPhoneCall.id, reason }))); } catch { /* 同上 */ }
    }
  });

  /* 手机报前后台: 来电挑你最近打开的那台 (wsServer.mostRecentConn) */
  server.registerMethod('device.presence', (params: { foreground?: boolean }, conn) => {
    if (conn) server.setConnPresence(conn, params?.foreground === true);
    console.log(`[PilotCall] ${conn?.mobile?.device_name ?? '?'} ${params?.foreground === true ? '到前台' : '到后台'}`);
    return { ok: true };
  });

  server.registerMethod('pilot.call_event', (params: { call_id?: string; event?: string }, conn) => {
    const ev = params?.event;
    if (typeof params?.call_id !== 'string' || (ev !== 'accepted' && ev !== 'declined' && ev !== 'ended')) {
      return { ok: false, error: 'bad params' };
    }
    const ok = phoneCallEvent(params.call_id, ev);
    if (ok && ev === 'accepted') {
      /* 这台接了: 其它连着的手机别再响 (接的那台收到 answered_elsewhere 会认出是自己, 不挂) */
      answeredBy = conn?.mobile?.device_id ?? null;
      server.broadcastToAllConns(makeNotification('pilot.call_end', { call_id: params.call_id, reason: 'answered_elsewhere' }), conn);
      /* 推送叫醒、连着别的电脑 / 没连上的手机: 系统来电在各自响, 推一条让它们撤 (接的那台已经不在响, 撤了也无妨) */
      pushCallEnd(params.call_id);
    }
    return { ok };
  });

  /* ── 联系人: 手机上的 Pilot 页跟电脑同一份档案 ── */
  server.registerMethod('pilot.list', () => {
    const profiles = readPilotProfiles();
    const pilots = Object.entries(profiles).map(([sessionId, p]) => {
      let updatedAt = p.createdAt;
      try {
        const s = getDatabase().getSession(sessionId) as { updatedAt?: number; updated_at?: number } | null;
        updatedAt = Number(s?.updatedAt ?? s?.updated_at ?? p.createdAt) || p.createdAt;
      } catch { /* 库读不到用建档时间 */ }
      return {
        session_id: sessionId,
        name: p.name,
        avatar: p.avatar,
        persona: p.persona ?? '',
        patrol_minutes: p.patrolMinutes ?? 0,
        updated_at: updatedAt,
      };
    }).sort((a, b) => b.updated_at - a.updated_at);
    return { pilots };
  });

  server.registerMethod('pilot.board', (params: { session_id?: string }) => {
    const sid = typeof params?.session_id === 'string' ? params.session_id : '';
    if (!sid) return { ok: false, error: 'session_id required' };
    const reports = readReports().filter((r) => r.sessionId === sid).slice(0, 12).map((r) => ({
      id: r.id, status: r.status, title: r.title, summary: r.summary, options: r.options ?? [],
      urgency: r.urgency, at: r.lastAt ?? r.at, read: !!r.readAt, answer: r.answer ?? null,
      /* 同一件事报了几次 (合并成一行), 手机板上显示 ×N */
      times: (r.repeats ?? 0) + 1,
    }));
    let reminders: Array<{ id: string; title: string; at: number }> = [];
    try {
      reminders = getLifeEventsStore().listByKind('reminder', { status: 'scheduled', limit: 200 })
        .filter((e) => e.sessionId === sid && typeof e.scheduledAt === 'number')
        .sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0))
        .slice(0, 6)
        .map((e) => ({ id: e.id, title: e.title, at: e.scheduledAt! }));
    } catch { /* 提醒库不可用就不给 */ }
    return { ok: true, reports, reminders };
  });
  /* ── 近况: 电脑不在时手机上的它也得知道「最近交代了什么、哪些在办、板上挂着什么」——
   *    不然你问「登录那个做得怎么样了」它答不上, 就不是同一个它。手机连着时随看板一起拉一份缓存下来 ── */
  server.registerMethod('pilot.digest', (params: { session_id?: string }) => {
    const sid = typeof params?.session_id === 'string' ? params.session_id : '';
    if (!sid) return { ok: false, error: 'session_id required' };
    const textOf = (item: any): string => {
      const c = item?.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('');
      return '';
    };
    const recent: Array<{ role: 'user' | 'assistant'; text: string; at: number }> = [];
    try {
      for (const m of getDatabase().getLastMessages(sid, 120)) {
        const item = m.itemData as { role?: string; type?: string };
        if (item?.role !== 'user' && item?.role !== 'assistant') continue;
        const text = textOf(item).replace(/\s+/g, ' ').trim();
        /* 巡检 / 手机信号这类后台触发不是你说的话; [quiet] 是它没事 */
        if (!text || text.startsWith('<') || text === '[quiet]' || text.endsWith('[quiet]')) continue;
        recent.push({ role: item.role, text: text.length > 280 ? `${text.slice(0, 280)}…` : text, at: m.timestamp });
      }
    } catch { /* 库读不到就只给板上的 */ }
    const open = readReports().filter((r) => r.sessionId === sid && (!r.readAt || (r.status === 'blocked' && !r.answer))).slice(0, 8)
      .map((r) => ({ status: r.status, title: r.title, summary: r.summary, at: r.at }));
    /* 电脑上它用的模型: 手机上的它跟着用同一个 (同一个它, 同一种口吻和本事) */
    let modelId: string | null = null;
    try {
      const s = getDatabase().getSession(sid) as { modelId?: string; model_id?: string } | null;
      const m = String(s?.modelId ?? s?.model_id ?? '');
      modelId = m && !m.startsWith('default:') ? m : null;
    } catch { /* 读不到就让手机自己挑 */ }
    return { ok: true, at: Date.now(), recent: recent.slice(-14), open_reports: open, model_id: modelId };
  });

  /* ── 提醒只响一次 (docs/NEOX_PILOT_LOCAL_FIRST L2): 电脑在线时电脑响 (打电话), 手机给每条 Pilot 提醒
   *    排一个晚 90 秒的系统闹钟兜底; 电脑一响 (scheduled → fired) 就通知手机撤掉。电脑睡着 → 没人撤 → 手机自己响。
   *    手机拿全量对账, 不靠增量: 断线期间改了什么, 连回来对一次就齐 ── */
  const pilotReminders = () => {
    const db = getDatabase();
    return getLifeEventsStore().listByKind('reminder', { status: 'scheduled', limit: 500 })
      .filter((e) => typeof e.scheduledAt === 'number' && e.sessionId && db.getSessionAgentMode(e.sessionId) === 'pilot')
      .map((e) => ({ id: e.id, title: e.title, at: e.scheduledAt!, session_id: e.sessionId }));
  };
  server.registerMethod('pilot.reminders', () => {
    try {
      /* 勿扰时段一起带过去: 电脑不在时手机上的它看短信 / 通知, 也要守同一个勿扰 */
      const q = (loadConfig() as { lifeQuietHours?: { enabled?: boolean; start?: string; end?: string } }).lifeQuietHours ?? DEFAULT_QUIET_HOURS;
      return { ok: true, reminders: pilotReminders(), quiet_hours: q?.enabled && q.start && q.end ? { start: q.start, end: q.end } : null };
    } catch (e) { return { ok: false, error: String((e as Error)?.message ?? e) }; }
  });
  /* 变了才通知手机。两个来源: 主进程里的改动 (到点 fired、你在任务板上 × 掉) 走订阅, 马上到;
   * agent 在 worker 里定的提醒写的是同一个库, 但主进程这份 store 收不到通知 —— 30 秒对一次签名兜住 */
  let lastSig = '';
  let changedTimer: ReturnType<typeof setTimeout> | null = null;
  const pushIfChanged = () => {
    let sig = '';
    try { sig = pilotReminders().map((r) => `${r.id}@${r.at}`).join(','); } catch { return; }
    if (sig === lastSig) return;
    lastSig = sig;
    if (server.openConnCount() > 0) server.broadcastToAllConns(makeNotification('pilot.reminders_changed', {}));
  };
  try {
    getLifeEventsStore().subscribe(() => {
      if (changedTimer) return;
      changedTimer = setTimeout(() => { changedTimer = null; pushIfChanged(); }, 800);
    });
  } catch { /* 提醒库不可用: 手机连上时照样会对一次账 */ }
  setInterval(pushIfChanged, 30_000).unref?.();
  /* 手机上看到了 = 读了 (升级阶梯停); 点了选项 = 记下 (回它的那句话手机自己发进会话) */
  server.registerMethod('pilot.reports_read', (params: { session_id?: string }) => {
    if (typeof params?.session_id === 'string' && params.session_id) markReportsRead(params.session_id);
    return { ok: true };
  });
  server.registerMethod('pilot.report_answer', (params: { id?: string; answer?: string }) => {
    if (typeof params?.id === 'string' && typeof params.answer === 'string') answerReport(params.id, params.answer);
    return { ok: true };
  });

  /* ── 手机上发生的事 (新通知 / 短信 / 未接来电): 要紧的叫醒 Pilot, 其余记账等巡检看 (pilotSignals.ts) ── */
  server.registerMethod('phone.signals', (params: { items?: unknown[] }) =>
    ingestSignals(Array.isArray(params?.items) ? params.items.slice(0, 100) : []));

  /* ── 说话: 电脑合成, 手机播 ── */
  server.registerMethod('pilot.speak', async (params: { text?: string; session_id?: string }) => {
    /* 手机拿来念的是整段回复: 只念口播段 (跟电脑上念的同一条规则, @neoxlabs/core/services/spokenLead) */
    const text = typeof params?.text === 'string' ? spokenLeadOf(params.text.trim()).lead.slice(0, SPEAK_MAX_CHARS) : '';
    if (!text) return { ok: false, error: 'text required' };
    const bridge = agentBridgeForSession(typeof params?.session_id === 'string' ? params.session_id : '');
    const client = await bridge?.getClientAsync().catch(() => null);
    if (!client) return { ok: false, error: 'runtime not ready' };
    type Spoken = { audio?: string; format?: string; error?: string };
    /* 手机上念也用这个分身自己的声音 */
    const voice = typeof params?.session_id === 'string' ? getPilotProfile(params.session_id)?.voice : undefined;
    const r: Spoken = await (client as unknown as { ttsSpeak: (t: string, v?: string) => Promise<Spoken> })
      .ttsSpeak(text, voice)
      .catch((e: Error): Spoken => ({ error: e?.message ?? String(e) }));
    if (!r?.audio) return { ok: false, error: r?.error || 'synthesis failed' };
    return { ok: true, audio: r.audio, format: r.format || 'mp3' };
  });

  /* ── 办事: 电脑上的 Pilot 借手机的手 (phone 工具) ──
   * 只发给最近活跃的那一台: 配了两台手机时, 「打个电话」不能两台一起拨。
   * 手机执行完回 `phone.exec_result`; 它可能在等用户点系统授权框, 所以等得久 (140s)。 */
  const pending = new Map<string, { resolve: (r: PhoneExecResult) => void; timer: NodeJS.Timeout }>();
  server.registerMethod('phone.exec_result', (params: { req_id?: string; ok?: boolean; output?: string; image?: { data?: string; media_type?: string } }) => {
    const p = typeof params?.req_id === 'string' ? pending.get(params.req_id) : undefined;
    if (!p) return { ok: false };
    clearTimeout(p.timer);
    pending.delete(params.req_id!);
    /* 拍照: 图片本身随结果回来, 交给 phone 工具转成模型看得见的图 */
    const image = typeof params.image?.data === 'string' && params.image.data
      ? { data: params.image.data, media_type: params.image.media_type || 'image/jpeg' }
      : undefined;
    p.resolve({ ok: params.ok === true, output: String(params.output ?? ''), ...(image ? { image } : {}) });
    return { ok: true };
  });

  const execOnPhone = (req: PhoneExecRequest): Promise<PhoneExecResult> => {
    const phone = server.listConns()
      .filter((c) => c.isOpen())
      .sort((a, b) => Math.max(b.lastPongAt, b.lastPingAt) - Math.max(a.lastPongAt, a.lastPingAt))[0];
    if (!phone) return Promise.resolve({ ok: false, output: '手机没连上: 让用户在手机上打开 Neox (和电脑配对过的那台)' });
    const reqId = randomUUID();
    return new Promise<PhoneExecResult>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(reqId);
        resolve({ ok: false, output: '手机两分钟没回话 (可能在等用户点系统授权, 或者 App 被切到后台了)' });
      }, PHONE_EXEC_TIMEOUT_MS);
      pending.set(reqId, { resolve, timer });
      /* 写动作带上用配对密钥签的批准令牌: 手机节点验签才执行 (pilot:D-01) */
      const signed = withApproval('phone', req.tool, req.args ?? {}, Buffer.from(phone.mobile.relay_session_key_b64, 'base64'));
      server.pushToDevice(phone.mobile.device_id, makeNotification('phone.exec', {
        req_id: reqId, tool: req.tool, args: signed.args, ...(signed.approval ? { approval: signed.approval } : {}),
      }));
    });
  };
  setPhoneExecutor(execOnPhone);
  setHostCapabilities({ phoneExec: execOnPhone });
}
