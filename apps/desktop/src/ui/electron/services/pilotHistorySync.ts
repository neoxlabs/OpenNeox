import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { stripRuntimeInjectedMarkers } from '../../shared/runtimeInjectedMarkers.js';
import { pilotCloud, isCloudPilotSession, type PilotLedgerMessage } from './pilotCloudSlot.js';
import { lazyElectron } from '../lazyElectron.js';

const BrowserWindow = lazyElectron<typeof import('electron').BrowserWindow>('BrowserWindow');

const CURSOR_KEY = (pilotId: string) => `pilot_ledger_cursor_v2:${pilotId}`;
/** 本地比对窗口: 最近这么多条时间线 (账本第一次补全量时也只回看这么远) */
const LOCAL_SCAN = 3000;

export function normalizeForMatch(text: string): string {
  return stripRuntimeInjectedMarkers(String(text ?? '')).normalize('NFKC').replace(/\s+/g, '').trim();
}

interface LocalEntry { id?: string; type?: string; detail?: string; sequence?: number; timestamp?: number }

export function missingLedgerEntries(local: LocalEntry[], ledger: PilotLedgerMessage[]): Record<string, unknown>[] {
  const pool = new Map<string, number>();
  const localAssistant: string[] = [];
  const anchors = local
    .filter((e) => typeof e.sequence === 'number' && e.sequence > 0 && typeof e.timestamp === 'number' && !String(e.id ?? '').startsWith('ledger-'))
    .map((e) => ({ seq: e.sequence as number, at: e.timestamp as number }))
    .sort((a, b) => a.at - b.at);
  const usedPerAnchor = new Map<number, number>();
  const sequenceAfter = (at: number): number | undefined => {
    let anchor: number | undefined;
    for (const a of anchors) { if (a.at <= at) anchor = a.seq; else break; }
    if (anchor === undefined) return undefined;
    const k = usedPerAnchor.get(anchor) ?? 0;
    usedPerAnchor.set(anchor, k + 1);
    return anchor + 0.5 + k * 0.001;
  };
  for (const e of local) {
    if (String(e.id ?? '').startsWith('ledger-')) continue;
    const role = e.type === 'user_message' ? 'user' : e.type === 'assistant_message' ? 'assistant' : null;
    if (!role) continue;
    const t = normalizeForMatch(e.detail ?? '');
    if (!t) continue;
    const k = `${role}|${t}`;
    pool.set(k, (pool.get(k) ?? 0) + 1);
    if (role === 'assistant') localAssistant.push(t);
  }
  const out: Record<string, unknown>[] = [];
  for (const m of ledger) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = stripRuntimeInjectedMarkers(String(m.text ?? '')).trim();
    const t = normalizeForMatch(text);
    if (!t) continue;
    const k = `${m.role}|${t}`;
    const n = pool.get(k) ?? 0;
    if (n > 0) { pool.set(k, n - 1); continue; }
    if (m.role === 'assistant' && localAssistant.some((a) => a.length >= 8 && t.includes(a))) continue;
    const id = `ledger-${m.id}`;
    const sequence = sequenceAfter(m.at);
    out.push({
      id,
      type: m.role === 'user' ? 'user_message' : 'assistant_message',
      title: m.role === 'user' ? 'User' : 'Assistant',
      detail: text,
      timestamp: m.at,
      ...(sequence !== undefined ? { sequence } : {}),
      pending: false,
      messageId: id,
      ledgerDevice: m.device ?? undefined,
    });
  }
  return out;
}

/** 补一个 Pilot 的对话; 返回补进去几条 */
export async function syncPilotHistory(pilotId: string): Promise<{ added: number }> {
  const cloud = pilotCloud();
  if (!cloud || !isCloudPilotSession(pilotId)) return { added: 0 };
  const db = getDatabase();
  const cursor = db.getAppState<number>(CURSOR_KEY(pilotId));
  const ledger = await cloud.messages(pilotId, cursor != null ? { after: cursor, limit: 500 } : { limit: 500 });
  if (ledger.length === 0) return { added: 0 };
  const local = db.getTimelinePage(pilotId, LOCAL_SCAN).entries as LocalEntry[];
  const toAdd = missingLedgerEntries(local, ledger);
  if (toAdd.length > 0) {
    db.upsertTimelineEntries(pilotId, toAdd);
    for (const w of BrowserWindow.getAllWindows()) {
      try { if (!w.isDestroyed()) w.webContents.send('timeline:changed', { sessionId: pilotId }); } catch { /* 窗口没了 */ }
    }
  }
  db.setAppState(CURSOR_KEY(pilotId), Math.max(...ledger.map((m) => m.id)));
  return { added: toAdd.length };
}
