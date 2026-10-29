import { net, powerMonitor } from 'electron';
import { randomInt } from 'node:crypto';
import { loadConfig, saveConfig } from '@neoxlabs/platform/utils/config.js';
import { readPilotProfiles } from '@neoxlabs/core';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { onMissedCall } from './pilotCallService.js';
import { agentBridgeForSession } from './runtimeEnqueue.js';

interface TgConfig { botToken?: string; chatId?: string; botName?: string }

export interface PilotTelegramStatus {
  configured: boolean;
  bound: boolean;
  botName?: string;
  pairingCode?: string;
  running: boolean;
  lastError?: string;
}

const PAIR_TTL_MS = 10 * 60_000;
const REPLY_TIMEOUT_MS = 5 * 60_000;
const AWAY_IDLE_SECONDS = 300;
const TG_TEXT_MAX = 4000;
/** 端到端测试时指向本地假 Telegram (scripts 里起一个), 平时就是官方 */
const TG_API = process.env.NEOX_TELEGRAM_API_BASE || 'https://api.telegram.org';

let polling = false;
let pollAbort: AbortController | null = null;
let offset = 0;
let pairing: { code: string; until: number } | null = null;
let lastError: string | undefined;
/** 这个 chat 现在在跟哪个 Pilot 说话 (没选过 = 最近活跃的那个) */
let talkingTo: string | null = null;
let unhookMissed: (() => void) | null = null;

function tgConfig(): TgConfig {
  return ((loadConfig() as { pilot?: { telegram?: TgConfig } }).pilot?.telegram) ?? {};
}

function saveTgConfig(patch: Partial<TgConfig> | null): void {
  const cfg = loadConfig() as Record<string, unknown> & { pilot?: Record<string, unknown> & { telegram?: TgConfig } };
  const pilot = { ...(cfg.pilot ?? {}) };
  if (patch === null) delete pilot.telegram;
  else pilot.telegram = { ...(cfg.pilot?.telegram ?? {}), ...patch };
  saveConfig({ ...cfg, pilot } as never);
}

async function tg<T = any>(method: string, body?: Record<string, unknown>, signal?: AbortSignal, token = tgConfig().botToken): Promise<T> {
  if (!token) throw new Error('no bot token');
  const res = await net.fetch(`${TG_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  const data = await res.json().catch(() => null) as { ok?: boolean; result?: T; description?: string } | null;
  if (!data?.ok) throw new Error(data?.description || `HTTP ${res.status}`);
  return data.result as T;
}

async function sendText(chatId: string, text: string): Promise<void> {
  const body = text.trim();
  if (!body) return;
  for (let i = 0; i < body.length; i += TG_TEXT_MAX) {
    await tg('sendMessage', { chat_id: chatId, text: body.slice(i, i + TG_TEXT_MAX) });
  }
}

// ───────────────────────── Pilot 选择 ─────────────────────────

function sessionUpdatedAt(sessionId: string): number {
  try {
    const s = getDatabase().getSession(sessionId) as { updatedAt?: number; updated_at?: number } | null;
    return Number(s?.updatedAt ?? s?.updated_at ?? 0);
  } catch { return 0; }
}

function pilotsByRecency(): Array<{ sessionId: string; name: string }> {
  return Object.entries(readPilotProfiles())
    .map(([sessionId, p]) => ({ sessionId, name: p.name, at: sessionUpdatedAt(sessionId) || p.createdAt }))
    .sort((a, b) => b.at - a.at);
}

function currentPilot(): { sessionId: string; name: string } | null {
  const all = pilotsByRecency();
  return all.find((p) => p.sessionId === talkingTo) ?? all[0] ?? null;
}

function findPilotByName(name: string): { sessionId: string; name: string } | null {
  const want = name.trim().toLowerCase();
  if (!want) return null;
  const all = pilotsByRecency();
  return all.find((p) => p.name.toLowerCase() === want) ?? all.find((p) => p.name.toLowerCase().startsWith(want)) ?? null;
}

function helpText(): string {
  const all = pilotsByRecency();
  const cur = currentPilot();
  if (all.length === 0) return '电脑上还没有 Pilot, 先在 Neox 里建一个。';
  const list = all.map((p) => `${p.sessionId === cur?.sessionId ? '· ' : '  '}/${p.name}`).join('\n');
  return `现在跟 ${cur?.name} 说话。换人发 /名字:\n${list}`;
}

// ───────────────────────── 进: Telegram → Pilot ─────────────────────────

async function askPilot(sessionId: string, text: string): Promise<string> {
  const bridge = agentBridgeForSession(sessionId);
  if (!bridge) return '电脑上的 Neox 还没准备好, 稍后再发。';
  const { sessionStore } = await import('@neoxlabs/core/platform/sessionStore.js');
  const session = await sessionStore.loadSession(sessionId).catch(() => null);
  const { normalizeModelId } = await import('../mobile-bridge/wsServer.js');
  const modelId = await normalizeModelId(session?.modelId);
  if (!modelId) return '这个 Pilot 用的模型在电脑上找不到了, 在 Neox 里给它换一个。';
  /* 先挂上等待再发: 会话正忙时 sendMessage 只排队就返回, 回复要等排到它那一轮 */
  const reply = bridge.awaitNextRunResult(sessionId, REPLY_TIMEOUT_MS);
  await bridge.sendMessage({
    sessionId,
    prompt: text,
    modelId,
    workspacePath: session?.workspacePath,
    agentMode: 'pilot',
    userMessageSource: 'telegram',
    /* 跟桌面上一样: DeepSeek 关思考才够快 (界面那边按模型记, 这里按名字认) */
    metadata: /deepseek/i.test(modelId) ? { effortLevel: 'off' } : {},
  } as never);
  const out = (await reply).trim();
  return out || '(它没说话, 电脑上看看)';
}

async function handleText(chatId: string, text: string): Promise<void> {
  const cfg = tgConfig();
  if (!cfg.chatId) {
    if (pairing && Date.now() < pairing.until && text.trim() === pairing.code) {
      saveTgConfig({ chatId });
      pairing = null;
      await sendText(chatId, `连上了。${helpText()}`);
    }
    /* 没配对上的一律不回 —— 不给陌生人任何信号 */
    return;
  }
  if (chatId !== cfg.chatId) return;

  const cmd = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
  let body = text;
  if (cmd) {
    const [, word, rest] = cmd;
    if (word === 'start' || word === 'help' || word === 'list') { await sendText(chatId, helpText()); return; }
    const hit = findPilotByName(word);
    if (!hit) { await sendText(chatId, `没有叫 ${word} 的。${helpText()}`); return; }
    talkingTo = hit.sessionId;
    if (!rest.trim()) { await sendText(chatId, `好, 现在跟 ${hit.name} 说话。`); return; }
    body = rest;
  }
  const pilot = currentPilot();
  if (!pilot) { await sendText(chatId, helpText()); return; }
  talkingTo = pilot.sessionId;

  const typing = setInterval(() => { void tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}); }, 4500);
  void tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  try {
    const answer = await askPilot(pilot.sessionId, body);
    await sendText(chatId, answer);
  } finally {
    clearInterval(typing);
  }
}

async function pollLoop(): Promise<void> {
  while (polling) {
    pollAbort = new AbortController();
    const timer = setTimeout(() => pollAbort?.abort(), 40_000);
    try {
      const updates = await tg<Array<{ update_id: number; message?: { chat?: { id?: number }; text?: string } }>>(
        'getUpdates', { offset, timeout: 30, allowed_updates: ['message'] }, pollAbort.signal);
      lastError = undefined;
      for (const u of updates) {
        offset = u.update_id + 1;
        const chatId = u.message?.chat?.id;
        const text = u.message?.text;
        if (chatId == null || !text) continue;
        /* 不 await: 一个 Pilot 在想的时候, 别的消息 (换人 / 帮助) 照样能回 */
        void handleText(String(chatId), text).catch((err) => console.warn('[PilotTelegram] handle failed:', (err as Error)?.message));
      }
    } catch (err) {
      if (!polling) break;
      const msg = (err as Error)?.message ?? String(err);
      if ((err as Error)?.name !== 'AbortError') {
        lastError = msg;
        console.warn('[PilotTelegram] poll failed:', msg);
        await new Promise((r) => setTimeout(r, /Unauthorized|Not Found/i.test(msg) ? 60_000 : 5_000));
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

// ───────────────────────── 出: Pilot → Telegram ─────────────────────────

function userIsAway(): boolean {
  try { return powerMonitor.getSystemIdleState(AWAY_IDLE_SECONDS) !== 'active'; } catch { return false; }
}

/** Pilot 主动说的话推到手机。onlyWhenAway: 人在电脑前就不推 (桌面上看得到)。 */
export async function pushFromPilot(sessionId: string | null, text: string, opts: { onlyWhenAway?: boolean } = {}): Promise<boolean> {
  const { chatId, botToken } = tgConfig();
  if (!chatId || !botToken || !text.trim()) return false;
  if (opts.onlyWhenAway && !userIsAway()) return false;
  const name = sessionId ? readPilotProfiles()[sessionId]?.name : undefined;
  if (sessionId) talkingTo = sessionId; /* 回一句就是回给它 */
  try {
    await sendText(chatId, name ? `${name}: ${text.trim()}` : text.trim());
    return true;
  } catch (err) {
    console.warn('[PilotTelegram] push failed:', (err as Error)?.message);
    return false;
  }
}

// ───────────────────────── 生命周期 / 设置 ─────────────────────────

export function bootPilotTelegram(): void {
  if (!unhookMissed) {
    unhookMissed = onMissedCall((call) => {
      void pushFromPilot(call.sessionId, `刚才打给你没接通 —— ${call.reason}\n直接回这里就能接着说。`, { onlyWhenAway: true });
    });
  }
  if (polling || !tgConfig().botToken) return;
  polling = true;
  void pollLoop();
}

export function stopPilotTelegram(): void {
  polling = false;
  pollAbort?.abort();
  pollAbort = null;
}

export function pilotTelegramStatus(): PilotTelegramStatus {
  const cfg = tgConfig();
  return {
    configured: !!cfg.botToken,
    bound: !!cfg.chatId,
    botName: cfg.botName,
    pairingCode: pairing && Date.now() < pairing.until ? pairing.code : undefined,
    running: polling,
    lastError,
  };
}

/** 填 token: 先 getMe 验一下, 验过才存; 换 token = 重新配对 */
export async function setPilotTelegramToken(token: string): Promise<PilotTelegramStatus> {
  const t = token.trim();
  if (!t) { disconnectPilotTelegram(); return pilotTelegramStatus(); }
  const me = await tg<{ username?: string }>('getMe', {}, undefined, t);
  stopPilotTelegram();
  saveTgConfig({ botToken: t, botName: me.username, chatId: undefined });
  offset = 0;
  lastError = undefined;
  bootPilotTelegram();
  return startPilotTelegramPairing();
}

export function startPilotTelegramPairing(): PilotTelegramStatus {
  pairing = { code: String(randomInt(100000, 1000000)), until: Date.now() + PAIR_TTL_MS };
  return pilotTelegramStatus();
}

export function disconnectPilotTelegram(): void {
  stopPilotTelegram();
  saveTgConfig(null);
  pairing = null;
  talkingTo = null;
  lastError = undefined;
}
