import { basename } from 'node:path';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { getCurrentChatSessionId } from '../runtime/shell/chatSessionContext.js';
import {
  deliverToPeer,
  getSessionPeerHost,
  listPeerSessions,
  resolvePeerTarget,
  SESSION_MESSAGE_MAX_CHARS,
  type PeerSender,
  type PeerSessionEntry,
} from '../runtime/peers/sessionPeers.js';

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function row(e: PeerSessionEntry) {
  return {
    session_id: e.sessionId,
    name: e.name || basename(e.cwd) || e.sessionId.slice(0, 8),
    cwd: e.cwd,
    app: e.client,
    status: e.busy ? 'working' : 'idle',
    last_active: ago(e.lastActiveAt),
  };
}

function currentSender(): PeerSender | null {
  const sessionId = getCurrentChatSessionId();
  if (!sessionId) return null;
  const host = getSessionPeerHost();
  const mine = host?.get(sessionId);
  let name = mine?.name || '';
  let cwd = mine?.cwd || '';
  if (!name || !cwd) {
    try {
      const s = getDatabase().getSession(sessionId);
      name ||= s?.name || '';
      cwd ||= s?.workspacePath || '';
    } catch { /* 没库也能发, 只是名字缺 */ }
  }
  cwd ||= process.cwd();
  return {
    sessionId,
    name: name || basename(cwd),
    cwd,
    client: host?.client ?? ((process.versions as any)?.electron ? 'desktop' : 'cli'),
  };
}

export const listSessionsTool: Tool = {
  name: 'list_sessions',
  description: `List the other Neox sessions open on this computer (CLI terminals and desktop app chats) — name, working directory, app, and whether each is working or idle. Use it to find the session_id for send_to_session.`,
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  isReadOnly: true,
  parameters: { type: 'object', properties: {} },
  async function(): Promise<string> {
    const self = getCurrentChatSessionId();
    const others = listPeerSessions().filter(e => e.sessionId !== self);
    /* count 放最前: 界面拿到的是截短的 JSON, 前缀里得有个数 */
    return JSON.stringify({
      count: others.length,
      sessions: others.slice(0, 30).map(row),
      ...(others.length > 30 ? { more: others.length - 30 } : {}),
      ...(others.length === 0 ? { note: 'No other sessions are open on this computer.' } : {}),
    });
  },
};

export const sendToSessionTool: Tool = {
  name: 'send_to_session',
  description: `Send a message to another Neox session open on this computer (another CLI terminal or desktop chat). The other agent sees it as a "message from <this session>": if it is idle it starts working on it right away; if it is busy it sees it as soon as its current turn ends.

Use it to hand off work, ask a question, or report a result to a session the user pointed you at (find it with list_sessions). The message must be self-contained — the other agent cannot see this conversation, so include paths, findings and what you want back.

This is fire-and-forget: do not wait or poll for the reply; if the other session answers, its reply arrives here as a new message. Don't message a session just to say thanks or acknowledge.`,
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  parameters: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Target session: its session_id from list_sessions (preferred), or its exact name',
      },
      message: {
        type: 'string',
        description: 'The message — specific and self-contained',
      },
    },
    required: ['to', 'message'],
  },
  async function(args: any): Promise<string> {
    const to = typeof args?.to === 'string' ? args.to : '';
    const message = typeof args?.message === 'string' ? args.message.trim() : '';
    if (!message) return JSON.stringify({ status: 'error', error: 'message is empty' });
    if (message.length > SESSION_MESSAGE_MAX_CHARS) {
      return JSON.stringify({ status: 'error', error: `message is too long (${message.length} chars, max ${SESSION_MESSAGE_MAX_CHARS}) — send a summary and point to a file for the rest` });
    }
    const sender = currentSender();
    if (!sender) return JSON.stringify({ status: 'error', error: 'no current session' });

    const entries = listPeerSessions().filter(e => e.sessionId !== sender.sessionId);
    const hit = resolvePeerTarget(entries, to);
    if ('error' in hit) {
      return JSON.stringify({
        status: 'error',
        error: `${hit.error}. Call list_sessions and pass the session_id.`,
        ...(hit.candidates ? { candidates: hit.candidates.slice(0, 10).map(row) } : {}),
      });
    }
    const target = hit.entry;
    const res = await deliverToPeer(target, { op: 'deliver', to: target.sessionId, from: sender, text: message });
    const who = row(target);
    if (!res.ok) return JSON.stringify({ status: 'error', to: who.name, session_id: target.sessionId, error: res.error || 'not delivered' });
    return JSON.stringify({
      status: 'sent',
      to: who.name,
      session_id: target.sessionId,
      delivery: res.state === 'queued'
        ? 'It is busy; it will see this when its current turn ends.'
        : res.state === 'held'
          ? 'It has received many messages recently, so it will see this the next time its user talks to it.'
          : 'It is working on it now.',
      note: 'Do not wait for a reply — keep going. A reply, if any, arrives as a new message.',
    });
  },
};

export const SESSION_PEER_TOOLS: Tool[] = [listSessionsTool, sendToSessionTool];
