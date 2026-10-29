
import { createHash } from 'node:crypto';
import { app, BrowserWindow, dialog } from 'electron';

import { consumeApprovedPairing } from './pairing.js';
import { bridgeLog } from './log.js';
import type { PairingResponse } from './types.js';

const DECIDE_TIMEOUT_MS = 60_000;
const DENY_COOLDOWN_MS = 60_000;

let busy = false;
const deniedAt = new Map<string, number>();

/** 核对码: sha256(手机公钥 raw 32 字节) 前 4 字节 mod 1e6, 补足 6 位。手机端同一算法 (pair_client.dart)。 */
export function pairCheckCode(phonePubkeyB64: string): string | null {
  let raw: Buffer;
  try {
    raw = Buffer.from(phonePubkeyB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  } catch {
    return null;
  }
  if (raw.length !== 32) return null;
  const n = createHash('sha256').update(raw).digest().readUInt32BE(0) % 1_000_000;
  return String(n).padStart(6, '0');
}

export type Decide = (info: { deviceName: string; code: string; signal: AbortSignal }) => Promise<boolean>;

/** 默认弹窗: 原生对话框挂在主窗口上 (窗口被收起时先拉出来, 否则用户看不到) */
const nativeDecide: Decide = async ({ deviceName, code, signal }) => {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null;
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  /* 用户在用别的 App 时也要看得到 —— 窗口被挡住时弹窗等于没弹 */
  if (process.platform === 'darwin') app.focus({ steal: true });
  const zh = app.getLocale().toLowerCase().startsWith('zh');
  const opts: Electron.MessageBoxOptions = {
    type: 'question',
    buttons: zh ? ['允许', '拒绝'] : ['Allow', 'Deny'],
    defaultId: 0,
    cancelId: 1,
    /* 超时 / 手机那边取消了: 弹窗跟着收掉, 不留一个点了也没用的「允许」 */
    signal,
    title: zh ? '手机请求连接' : 'Phone wants to connect',
    message: zh ? `允许「${deviceName}」连接这台电脑?` : `Allow "${deviceName}" to connect to this computer?`,
    detail: zh
      ? `核对码 ${code}\n\n手机上显示的应该是同一串数字。不是你的手机就点拒绝。\n允许后它可以查看和使用这台电脑上的会话。`
      : `Check code ${code}\n\nYour phone should show the same number. Deny if this isn't your phone.\nOnce allowed, it can see and use the sessions on this computer.`,
  };
  /* 被 signal 收掉的弹窗 response 落在 cancelId (拒绝) */
  const r = await (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
  return !signal.aborted && r.response === 0;
};

export async function handlePairRequest(
  body: unknown,
  decide: Decide = nativeDecide,
  res?: { once(event: 'close', cb: () => void): unknown; writableFinished: boolean },
): Promise<{ status: number; body: PairingResponse | { error: string } }> {
  const b = (body ?? {}) as Record<string, unknown>;
  const pub = typeof b.phone_pubkey === 'string' ? b.phone_pubkey.trim() : '';
  const id = typeof b.phone_device_id === 'string' ? b.phone_device_id.trim() : '';
  const name = typeof b.phone_device_name === 'string' ? b.phone_device_name.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 64) : '';
  const code = pairCheckCode(pub);
  if (!code || !id || id.length > 128 || !name) return { status: 400, body: { error: 'invalid pair request' } };

  const now = Date.now();
  for (const [k, t] of deniedAt) if (now - t > DENY_COOLDOWN_MS) deniedAt.delete(k);
  if (deniedAt.has(id)) return { status: 403, body: { error: 'denied' } };
  if (busy) return { status: 429, body: { error: 'busy' } };

  busy = true;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), DECIDE_TIMEOUT_MS);
  res?.once('close', () => { if (!res.writableFinished) abort.abort(); });
  try {
    bridgeLog('pairing', `局域网配对请求 ${id.slice(0, 12)}… (${name}), 等电脑确认`);
    const allowed = await Promise.race([
      decide({ deviceName: name, code, signal: abort.signal }).catch(() => false),
      new Promise<boolean>((r) => abort.signal.addEventListener('abort', () => r(false), { once: true })),
    ]);
    if (abort.signal.aborted) return { status: 408, body: { error: 'timeout' } };
    if (!allowed) {
      deniedAt.set(id, Date.now());
      return { status: 403, body: { error: 'denied' } };
    }
    const r = await consumeApprovedPairing(pub, id, name);
    return r.ok ? { status: 200, body: r.response } : { status: 400, body: { error: r.error } };
  } finally {
    clearTimeout(timer);
    busy = false;
  }
}

/** 测试用 */
export function _resetPairRequest(): void {
  busy = false;
  deniedAt.clear();
}
