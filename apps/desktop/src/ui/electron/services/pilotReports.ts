
import { Notification } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import { getPilotProfile, type ReportRequest, type ReportResult, type ReportStatus, type ReportUrgency } from '@neoxlabs/core';
import { mainWindows, ringUser } from './pilotCallService.js';
import { findDuplicate } from './pilotReportDedupe.js';

export interface PilotReport {
  id: string;
  sessionId: string | null;
  status: ReportStatus;
  title: string;
  summary: string;
  options?: string[];
  urgency: ReportUrgency;
  at: number;
  readAt?: number;
  answer?: string;
  /** 阶梯走到哪了: 打过电话的时间 + 结果 */
  calledAt?: number;
  callOutcome?: string;
  /** 同一件事又报了几次 (pilotReportDedupe.ts): 板上聚成一条, 显示 ×(repeats+1) */
  repeats?: number;
  /** 最近一次被重复报的时间 */
  lastAt?: number;
}

const KEEP = 300;
const ATTENTION_CALL_AFTER_MS = 30 * 60_000;
const TICK_MS = 60_000;

function filePath(): string {
  return join(homedir(), NEOX_HOME_DIRNAME, 'pilot-reports.json');
}

export function readReports(): PilotReport[] {
  try {
    const raw = JSON.parse(readFileSync(filePath(), 'utf8'));
    return Array.isArray(raw) ? (raw as PilotReport[]) : [];
  } catch {
    return [];
  }
}

function writeReports(list: PilotReport[]): void {
  try {
    const file = filePath();
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(list.slice(0, KEEP), null, 2), 'utf8');
    renameSync(`${file}.tmp`, file);
  } catch (err) {
    console.warn('[PilotReports] 写账本失败:', (err as Error)?.message);
  }
  for (const w of mainWindows()) {
    try { w.webContents.send('pilot-report:changed'); } catch { /* 窗口正在关 */ }
  }
}

function update(id: string, patch: Partial<PilotReport>): PilotReport | null {
  const list = readReports();
  const i = list.findIndex((r) => r.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...patch };
  writeReports(list);
  return list[i];
}

/** 打电话时接通后说的第一句: 结论那句 */
function openingOf(r: PilotReport): string {
  const first = r.summary.split(/(?<=[。！？!?.])\s*/)[0] || r.title;
  return r.status === 'blocked' ? `${r.title}。${first} 你定一下?` : first;
}

async function callFor(r: PilotReport): Promise<void> {
  update(r.id, { calledAt: Date.now() });
  const res = await ringUser({
    sessionId: r.sessionId ?? undefined,
    reason: r.title,
    opening: openingOf(r),
    urgency: r.status === 'blocked' ? 'decision' : 'alert',
  }, 'agent').catch(() => ({ status: 'blocked' as const }));
  update(r.id, { callOutcome: res.status, ...(res.status === 'answered' ? { readAt: Date.now() } : {}) });
}

function notify(r: PilotReport): void {
  try {
    if (!Notification.isSupported()) return;
    const name = getPilotProfile(r.sessionId)?.name ?? 'Pilot';
    const n = new Notification({ title: `${name} · ${r.title}`, body: r.summary.slice(0, 200), silent: false });
    n.on('click', () => {
      const w = mainWindows()[0];
      if (!w) return;
      if (w.isMinimized()) w.restore();
      w.show(); w.focus();
      w.webContents.send('pilot-call:open-session', { sessionId: r.sessionId });
    });
    n.show();
  } catch { /* 通知失败不影响账本 */ }
}

function bumpDuplicate(dup: PilotReport, summary: string, at: number): PilotReport | null {
  return update(dup.id, { repeats: (dup.repeats ?? 0) + 1, lastAt: at, summary: summary.slice(0, 2000) || dup.summary });
}

export async function addReport(req: ReportRequest): Promise<ReportResult> {
  const sessionId = req.sessionId ?? null;
  const dup = findDuplicate(readReports(), { sessionId, status: req.status, title: req.title });
  if (dup) {
    const merged = bumpDuplicate(dup, req.summary, Date.now());
    return {
      id: dup.id,
      delivery: `Already on the user's board as "${dup.title}" (now reported ${(merged?.repeats ?? 1) + 1} times). `
        + 'Not sent again and no new notification. Do not report this again; only report something new.',
    };
  }
  const r: PilotReport = {
    id: randomUUID(),
    sessionId: req.sessionId ?? null,
    status: req.status,
    title: req.title.slice(0, 120),
    summary: req.summary.slice(0, 2000),
    options: req.options?.slice(0, 2),
    urgency: req.urgency,
    at: Date.now(),
  };
  writeReports([r, ...readReports()]);
  if (r.urgency === 'urgent') {
    void callFor(r);
    return { id: r.id, delivery: 'calling the user now (desktop, then phone if unanswered); also on their task board' };
  }
  if (r.urgency === 'attention') {
    notify(r);
    return { id: r.id, delivery: 'on their task board with a notification; they will be called if it stays unread for 30 minutes' };
  }
  return { id: r.id, delivery: 'on their task board' };
}

export function importDeliveredReports(sessionId: string, reports: Array<Pick<PilotReport, 'status' | 'title' | 'summary' | 'options' | 'at'>>): void {
  if (!reports.length) return;
  const imported: PilotReport[] = [];
  for (const r of reports) {
    const at = Number(r.at) || Date.now();
    /* 同一件事已经在板上 (或这批里前面已有) → 并进去计数, 不新加一行 */
    const dup = findDuplicate([...imported, ...readReports()], { sessionId, status: r.status, title: String(r.title) }, at);
    if (dup) {
      if (imported.includes(dup)) { dup.repeats = (dup.repeats ?? 0) + 1; dup.lastAt = at; }
      else bumpDuplicate(dup, String(r.summary), at);
      continue;
    }
    imported.push({
      id: randomUUID(), sessionId, status: r.status, title: String(r.title).slice(0, 120), summary: String(r.summary).slice(0, 2000),
      options: r.options?.slice(0, 2), urgency: 'fyi', at,
    });
  }
  if (imported.length) writeReports([...imported, ...readReports()].sort((a, b) => b.at - a.at));
}

/** 渲染层: 这个 Pilot 的汇报你看到了 */
export function markReportsRead(sessionId: string): void {
  const list = readReports();
  let changed = false;
  const now = Date.now();
  for (const r of list) {
    if (r.sessionId === sessionId && !r.readAt) { r.readAt = now; changed = true; }
  }
  if (changed) writeReports(list);
}

export function answerReport(id: string, answer: string): void {
  update(id, { answer, readAt: Date.now() });
}

// ───────────────────────── 阶梯 ─────────────────────────

let timer: NodeJS.Timeout | null = null;

function tick(): void {
  const now = Date.now();
  for (const r of readReports()) {
    if (r.readAt || r.calledAt || r.urgency !== 'attention') continue;
    if (now - r.at < ATTENTION_CALL_AFTER_MS) continue;
    /* 太旧的不追 (关机一夜之后醒来, 不该一口气把昨天的全打一遍) */
    if (now - r.at > 6 * 3_600_000) continue;
    void callFor(r);
    break; // 一次只打一通, 下一轮再说
  }
}

/** 账本里去重前积下的重复 (同一件事多行) 合成一条: 留最早那行 (它的读过/打过电话状态算数), 计数累加 */
function compactDuplicates(): void {
  const list = readReports();
  const kept: PilotReport[] = [];
  let merged = 0;
  /* 从旧到新走: 先出现的是"本尊", 后来的并进去 */
  for (const r of [...list].sort((a, b) => a.at - b.at)) {
    const dup = findDuplicate(kept, { sessionId: r.sessionId, status: r.status, title: r.title }, r.at);
    if (!dup) { kept.push({ ...r }); continue; }
    dup.repeats = (dup.repeats ?? 0) + 1 + (r.repeats ?? 0);
    dup.lastAt = Math.max(dup.lastAt ?? dup.at, r.lastAt ?? r.at);
    dup.summary = r.summary || dup.summary;
    if (!dup.readAt && r.readAt) dup.readAt = r.readAt;
    merged++;
  }
  if (merged) writeReports(kept.sort((a, b) => b.at - a.at));
}

export function bootPilotReports(): void {
  if (timer) return;
  try { compactDuplicates(); } catch (err) { console.warn('[PilotReports] compact failed:', (err as Error)?.message); }
  timer = setInterval(() => {
    try { tick(); } catch (err) { console.warn('[PilotReports] tick failed:', (err as Error)?.message); }
  }, TICK_MS);
}

export function openReportsFor(sessionId: string): PilotReport[] {
  return readReports().filter((r) => r.sessionId === sessionId && (!r.readAt || (r.status === 'blocked' && !r.answer)));
}
