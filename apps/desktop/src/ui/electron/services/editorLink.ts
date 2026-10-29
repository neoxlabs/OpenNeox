import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fsp, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, basename, extname } from 'node:path';
import type { BrowserWindow } from 'electron';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import type { EditorLinkIntent, EditorLinkRequest } from '@neoxlabs/platform/shared/ipc.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LINES = 2000;
const MAX_TEXT_CHARS = 200_000;
const MAX_DIAG_CHARS = 500;
const INTENTS: readonly EditorLinkIntent[] = ['explain', 'fix', 'optimize', 'tests'];

export function editorLinkTokenPath(): string {
  return join(homedir(), NEOX_HOME_DIRNAME, 'run', 'editor-link.token');
}

/** 读 token, 没有就生成一份 (0600)。启动时调一次。 */
export function ensureEditorLinkToken(): string {
  const file = editorLinkTokenPath();
  try {
    if (existsSync(file)) {
      const t = readFileSync(file, 'utf8').trim();
      if (/^[0-9a-f]{64}$/.test(t)) return t;
    }
  } catch { /* 读不了就重建 */ }
  const token = randomBytes(32).toString('hex');
  mkdirSync(join(homedir(), NEOX_HOME_DIRNAME, 'run'), { recursive: true });
  writeFileSync(file, token, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* Windows 上无意义 */ }
  return token;
}

function tokenMatches(expected: string, given: string | null): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact', mjs: 'javascript', cjs: 'javascript',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', rb: 'ruby', php: 'php',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', css: 'css', scss: 'scss', html: 'html',
  json: 'json', md: 'markdown', yaml: 'yaml', yml: 'yaml', sh: 'shell', sql: 'sql', vue: 'vue', svelte: 'svelte',
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const posInt = (v: unknown, fallback: number): number =>
  (typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback);

/** 解析 + 校验一条深链。不是 editor 深链返回 null (交给别的处理方); 是但不合法返回 'rejected'。 */
export async function parseEditorLink(url: string, token: string): Promise<EditorLinkRequest | 'rejected' | null> {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'neox:' || u.host !== 'editor') return null;

  const m = /^\/(attach|open)\/([A-Za-z0-9_-]+)$/.exec(u.pathname);
  if (!m) return 'rejected';
  let p: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(m[2], 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return 'rejected';
    p = parsed as Record<string, unknown>;
  } catch { return 'rejected'; }
  if (!tokenMatches(token, str(p.t) || null)) return 'rejected';

  if (m[1] === 'open') {
    const folder = str(p.folder);
    if (!isAbsolute(folder)) return 'rejected';
    try { if (!(await fsp.stat(folder)).isDirectory()) return 'rejected'; } catch { return 'rejected'; }
    return { kind: 'open', folder };
  }

  const path = str(p.path);
  if (!isAbsolute(path)) return 'rejected';
  const start = posInt(p.start, 1);
  let end = Math.max(start, posInt(p.end, start));
  if (end - start + 1 > MAX_LINES) end = start + MAX_LINES - 1;

  /* 插件给了缓冲区原文 (可能还没保存) 就用它; 否则读盘上的那几行 */
  let text: string | null = typeof p.text === 'string' && p.text.length <= MAX_TEXT_CHARS ? p.text : null;
  if (text === null) {
    try {
      const st = await fsp.stat(path);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return 'rejected';
      const lines = (await fsp.readFile(path, 'utf8')).split(/\r?\n/);
      end = Math.min(end, lines.length);
      if (start > end) return 'rejected';
      text = lines.slice(start - 1, end).join('\n');
    } catch { return 'rejected'; }
  }
  if (!text.trim()) return 'rejected';

  const intent = INTENTS.includes(p.intent as EditorLinkIntent) ? (p.intent as EditorLinkIntent) : undefined;
  const rawDiag = p.diag && typeof p.diag === 'object' ? (p.diag as Record<string, unknown>) : null;
  const diagMsg = rawDiag ? str(rawDiag.message) : '';
  const diag = diagMsg ? { message: diagMsg.slice(0, MAX_DIAG_CHARS), line: posInt(rawDiag!.line, start) } : undefined;
  const ws = str(p.ws);
  const ext = extname(path).slice(1).toLowerCase();
  return {
    kind: 'attach',
    workspace: ws && isAbsolute(ws) ? ws : undefined,
    code: {
      text,
      name: `${basename(path)}:${start}-${end}`,
      path,
      language: EXT_LANG[ext],
      lineRange: { start, end },
    },
    intent: diag ? 'fix' : intent,
    diag,
  };
}

/* ── 队列: 渲染层来取 ── */
const pending: EditorLinkRequest[] = [];

export function drainEditorLinkRequests(): EditorLinkRequest[] {
  return pending.splice(0, pending.length);
}

/**
 * 深链入口。返回 true = 这是 editor 深链 (不管收没收), 调用方别再交给别的处理方。
 * pickWindow 按请求里的项目找窗口 (那个项目已经在某个窗口开着就用那个), 找不到给 null。
 */
export async function handleEditorLink(
  url: string,
  deps: { token: string; pickWindow: (workspace?: string) => BrowserWindow | null },
): Promise<boolean> {
  const req = await parseEditorLink(url, deps.token);
  if (req === null) return false;
  if (req === 'rejected') {
    console.warn('[editorLink] rejected deep link');
    return true;
  }
  pending.push(req);
  const win = deps.pickWindow(req.kind === 'attach' ? req.workspace : req.folder);
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send('editor-link:ping');
  }
  return true;
}
