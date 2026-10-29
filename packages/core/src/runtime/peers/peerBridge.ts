/**
 * 会话互发接进 runtime bridge (initRuntimeBridge 调一次)。
 *
 *   登记: 会话每轮开始 / 结束时 touch —— 名字、工作目录、在不在跑。子 agent 会话不登记 (它们不是用户开的窗口)。
 *   收件: 对方进程投来的消息包成 <session-message> 进会话收件箱, 闲着起一轮、在跑等这轮完 (见 sessionPeers.ts)。
 *   刹车: 两个 agent 互相回话可能停不下来 —— 同一会话 10 分钟内被消息叫起超过 8 次, 之后的只入收件箱
 *         不起轮, 等它的用户下次开口时一起带上。
 */
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { getBackgroundTaskNotifier } from '../shell/backgroundTaskNotifier.js';
import {
  buildSessionMessageXml,
  SESSION_MESSAGE_MAX_CHARS,
  startSessionPeerHost,
  type DeliverRequest,
  type DeliverResult,
  type PeerClient,
  type SessionPeerHost,
} from './sessionPeers.js';

const WAKE_WINDOW_MS = 10 * 60_000;
const MAX_WAKES_PER_WINDOW = 8;

export interface SessionPeersHooks {
  onTurnStart(sessionId: string, workspacePath?: string): void;
  onTurnEnd(sessionId: string): void;
  onSessionClosed(sessionId: string): void;
  /** 客户端说「这个会话开着」(还没发消息): 登记 + 记下用哪个模型, 收到消息才起得了轮 */
  onAnnounce(sessionId: string, info: { providerId?: string; modelName?: string; workspacePath?: string }): void;
}

const NOOP: SessionPeersHooks = { onTurnStart() {}, onTurnEnd() {}, onSessionClosed() {}, onAnnounce() {} };

export function setupSessionPeers(opts: {
  client: PeerClient;
  workDir: string;
  /** 一次性宿主 (neox -p) 跑完就退, 不登记 —— 发消息不需要登记 */
  oneShot?: boolean;
  isActive(sessionId: string): boolean;
  /** 没有 chat meta 的会话起不了轮 (autoResume 会丢), 不收 */
  canResume(sessionId: string): boolean;
  /** 会话还没跑过一轮时, 用客户端报来的模型补上 chat meta (已有的不覆盖) */
  seedChatMeta(sessionId: string, meta: { providerId?: string; modelName?: string }): void;
}): SessionPeersHooks {
  if (opts.oneShot || process.env.NEOX_DISABLE_SESSION_PEERS === '1') return NOOP;

  let host: SessionPeerHost | null = null;
  const wakes = new Map<string, number[]>();
  /** sessionId → 是不是用户开的顶层会话 (查一次库就记住) */
  const topLevel = new Map<string, boolean>();
  /** 客户端报的目录 —— 共用后台服务时库里/服务进程的目录不是这个会话的, 以客户端为准 */
  const announcedCwd = new Map<string, string>();

  const describe = (sessionId: string): { top: boolean; name: string; cwd: string } => {
    try {
      const s = getDatabase().getSession(sessionId);
      if (!topLevel.has(sessionId)) topLevel.set(sessionId, !s?.parentSessionId);
      /* 还没起标题的会话库里是占位名 "Session <id>" —— 不如不给, 列表那边退回目录名 */
      const name = s?.name && !s.name.includes(sessionId) ? s.name : '';
      return { top: topLevel.get(sessionId)!, name, cwd: s?.workspacePath || '' };
    } catch {
      return { top: topLevel.get(sessionId) ?? true, name: '', cwd: '' };
    }
  };

  const deliver = (req: DeliverRequest): DeliverResult => {
    const to = req.to;
    if (!host?.has(to) || !opts.canResume(to)) return { ok: false, error: 'that session is not open here any more' };
    const text = req.text.trim().slice(0, SESSION_MESSAGE_MAX_CHARS);
    if (!text) return { ok: false, error: 'message is empty' };

    const now = Date.now();
    const recent = (wakes.get(to) ?? []).filter(t => now - t < WAKE_WINDOW_MS);
    const held = recent.length >= MAX_WAKES_PER_WINDOW;
    if (!held) recent.push(now);
    wakes.set(to, recent);

    const busy = opts.isActive(to);
    getBackgroundTaskNotifier().enqueueMessageForSession(to, buildSessionMessageXml(req.from, text), {
      kind: 'peer',
      command: `message from ${req.from.name || req.from.sessionId}`,
      noAutoResume: held,
    });
    cliLogger.info('PEERS', `deliver ${req.from.sessionId} → ${to} (${text.length} chars, ${held ? 'held' : busy ? 'queued' : 'started'})`);
    return { ok: true, state: held ? 'held' : busy ? 'queued' : 'started' };
  };

  const pendingAnnounce = new Map<string, Parameters<SessionPeersHooks['onAnnounce']>[1]>();
  void startSessionPeerHost(opts.client, deliver)
    .then((h) => {
      host = h;
      for (const [sid, info] of pendingAnnounce) hooks.onAnnounce(sid, info);
      pendingAnnounce.clear();
    })
    .catch((err) => cliLogger.warn('PEERS', `session peer host not started: ${err?.message ?? err}`));

  const hooks: SessionPeersHooks = {
    onTurnStart(sessionId, workspacePath) {
      if (!host) return;
      const d = describe(sessionId);
      if (!d.top) return;
      host.touch(sessionId, {
        name: d.name,
        cwd: workspacePath || announcedCwd.get(sessionId) || d.cwd || host.get(sessionId)?.cwd || opts.workDir,
        busy: true,
        lastActiveAt: Date.now(),
      });
    },
    onTurnEnd(sessionId) {
      if (!host?.has(sessionId)) return;
      /* 首轮结束时标题多半刚生成好 —— 顺手刷名字 */
      const d = describe(sessionId);
      host.touch(sessionId, { busy: false, lastActiveAt: Date.now(), ...(d.name ? { name: d.name } : {}) });
    },
    onSessionClosed(sessionId) {
      host?.remove(sessionId);
      wakes.delete(sessionId);
      topLevel.delete(sessionId);
      announcedCwd.delete(sessionId);
    },
    onAnnounce(sessionId, info) {
      if (!sessionId) return;
      if (info.workspacePath) announcedCwd.set(sessionId, info.workspacePath);
      if (info.providerId || info.modelName) opts.seedChatMeta(sessionId, { providerId: info.providerId, modelName: info.modelName });
      /* 收件口还在起 (CLI 一启动就报): 先记着, 起好了补登记 */
      if (!host) { pendingAnnounce.set(sessionId, info); return; }
      const d = describe(sessionId);
      if (!d.top) return;
      host.touch(sessionId, {
        name: d.name,
        cwd: info.workspacePath || d.cwd || host.get(sessionId)?.cwd || opts.workDir,
        busy: opts.isActive(sessionId),
        lastActiveAt: Date.now(),
      });
    },
  };
  return hooks;
}
