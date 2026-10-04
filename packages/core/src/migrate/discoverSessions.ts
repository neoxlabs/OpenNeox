/**
 * 扫描 Claude Code 和 Codex 的历史会话清单，不搬运会话内容。
 * 元数据扫描按块读取完整 JSONL 行并设置字节、行数上限；工作目录只接受文件
 * 内容中的 cwd，无法读取时保留 unknown，不从目录 slug 推断路径。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** 扫描按完整行停止，并同时受行数和最大字节数限制，避免附件拖慢元数据读取。 */
const CHUNK_BYTES = 64 * 1024;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const ENOUGH_LINES = 40;

export interface ExternalSessionCandidate {
  /** 哪一家 —— 决定用哪个解析器 (importSessions.ts) */
  source: 'claude-code' | 'codex';
  /** 源里的 sessionId (Claude Code = 文件名去掉 .jsonl; Codex = session_meta.id) */
  sessionId: string;
  filePath: string;
  /** 从内容里读到的工作目录; 读不到为 null —— **不从目录名猜** */
  cwd: string | null;
  /** ai-title 事件里的标题; 没有就回落到首条用户消息的前几十字 */
  title: string | null;
  bytes: number;
  /** 文件 mtime (ISO) —— 最近改的排前面 */
  updatedAt: string;
}

export interface ExternalSessionScan {
  /** 兼容旧调用方: Claude Code 的根 */
  root: string;
  /** 源目录存在与否 —— 区分"没装过 Claude Code"和"装了但没会话" */
  rootExists: boolean;
  /** 每一家的根 + 是否存在 —— 界面据此区分"没装"和"装了没会话" */
  roots: Array<{ source: 'claude-code' | 'codex'; path: string; exists: boolean }>;
  sessions: ExternalSessionCandidate[];
  totalBytes: number;
  /** 读坏了的文件, 计数即可, 不该打断扫描 */
  unreadable: number;
}

/**
 * 有上限的流式扫描 —— 一块一块读, 只解析**完整**的行, 拿到要的东西就停。
 *
 *   三个停止条件, 满足任一即返回:
 *     · cwd 和标题都拿到了
 *     · 已经看过 ENOUGH_LINES 个完整行 (元信息不在开头就是没有, 再读也是白读)
 *     · 已经读了 MAX_SCAN_BYTES (防单行几 MB 的附件把我们拖进整个 2GB)
 */
function extractMeta(file: string): { cwd: string | null; title: string | null } {
  let cwd: string | null = null;
  let title: string | null = null;
  let firstUserText: string | null = null;

  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    let pending = '';
    let consumed = 0;
    let lines = 0;

    while (consumed < MAX_SCAN_BYTES) {
      const n = fs.readSync(fd, buf, 0, CHUNK_BYTES, consumed);
      if (n <= 0) break;
      consumed += n;
      pending += buf.subarray(0, n).toString('utf-8');

      /* 末段留在 pending 里等下一块 —— 它可能是半条 JSON */
      const parts = pending.split('\n');
      pending = parts.pop() ?? '';

      for (const part of parts) {
        const line = part.trim();
        if (!line) continue;
        lines++;
        let d: any;
        try { d = JSON.parse(line); } catch { continue; }

        if (!cwd && typeof d?.cwd === 'string' && d.cwd.trim()) cwd = d.cwd.trim();
        if (!title && d?.type === 'ai-title' && typeof d?.title === 'string' && d.title.trim()) {
          title = d.title.trim();
        }
        if (!firstUserText && d?.type === 'user') {
          firstUserText = extractText(d?.message?.content);
        }
        if (cwd && title) return { cwd, title };
      }
      if (lines >= ENOUGH_LINES) break;
    }
  } catch {
    /* 读不了就当没有元信息 —— 调用方仍会把这个会话列出来 (它是真实存在的) */
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }

  return { cwd, title: title ?? (firstUserText ? firstUserText.slice(0, 60) : null) };
}

/** 用户消息的 content 是 string 或 [{type:'text',text}, {type:'image',...}] */
function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    /* Claude: {type:'text'}; Codex: {type:'input_text'|'output_text'} */
    const kind = part && typeof part === 'object' ? (part as any).type : '';
    if (kind === 'text' || kind === 'input_text' || kind === 'output_text') {
      const t = String((part as any).text ?? '').trim();
      if (t) return t;
    }
  }
  return null;
}

export function discoverExternalSessions(): ExternalSessionScan {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const codexRoot = path.join(os.homedir(), '.codex', 'sessions');
  const scan: ExternalSessionScan = {
    root, rootExists: false, sessions: [], totalBytes: 0, unreadable: 0,
    roots: [
      { source: 'claude-code', path: root, exists: false },
      { source: 'codex', path: codexRoot, exists: false },
    ],
  };

  /* Claude Code 没装 / 读不了都不该让 Codex 那一半跟着空掉 —— 各扫各的 */
  let projectDirs: fs.Dirent[] = [];
  try {
    if (fs.existsSync(root)) {
      scan.rootExists = true;
      scan.roots[0].exists = true;
      projectDirs = fs.readdirSync(root, { withFileTypes: true });
    }
  } catch {
    projectDirs = [];
  }

  for (const dir of projectDirs) {
    /* 跟随指向目录的软链，兼容集中管理外部会话目录的配置。 */
    const dirPath = path.join(root, dir.name);
    if (!dir.isDirectory()) {
      if (!dir.isSymbolicLink()) continue;
      try { if (!fs.statSync(dirPath).isDirectory()) continue; } catch { continue; }
    }

    let files: string[];
    try { files = fs.readdirSync(dirPath); } catch { scan.unreadable++; continue; }

    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue;
      const filePath = path.join(dirPath, name);
      let st: fs.Stats;
      try { st = fs.statSync(filePath); } catch { scan.unreadable++; continue; }
      if (!st.isFile() || st.size === 0) continue;

      const { cwd, title } = extractMeta(filePath);
      scan.sessions.push({
        source: 'claude-code',
        sessionId: name.slice(0, -'.jsonl'.length),
        filePath,
        cwd,
        title,
        bytes: st.size,
        updatedAt: new Date(st.mtimeMs).toISOString(),
      });
      scan.totalBytes += st.size;
    }
  }

  scanCodex(codexRoot, scan);

  scan.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return scan;
}

/** Codex 会话按 YYYY/MM/DD 三层目录枚举，cwd 从首行 session_meta 读取，标题优先取索引或首条用户消息。 */
function scanCodex(root: string, scan: ExternalSessionScan): void {
  try {
    if (!fs.existsSync(root)) return;
  } catch { return; }
  scan.roots[1].exists = true;

  /* 索引只用来补标题, 读不到不影响 */
  const titles = new Map<string, string>();
  try {
    const idx = path.join(root, '..', 'session_index.jsonl');
    if (fs.existsSync(idx)) {
      for (const line of fs.readFileSync(idx, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (typeof d?.id === 'string' && typeof d?.thread_name === 'string') titles.set(d.id, d.thread_name);
        } catch { /* 单行坏了跳过 */ }
      }
    }
  } catch { /* 索引可有可无 */ }

  const files: string[] = [];
  /* YYYY/MM/DD 三层 —— 写死深度比递归全盘走安全 (不会跟到软链外面去) */
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || files.length > 5000) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { scan.unreadable++; return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  walk(root, 0);

  for (const filePath of files) {
    let st: fs.Stats;
    try { st = fs.statSync(filePath); } catch { scan.unreadable++; continue; }
    if (!st.isFile() || st.size === 0) continue;

    const meta = extractCodexMeta(filePath);
    scan.sessions.push({
      source: 'codex',
      sessionId: meta.id ?? path.basename(filePath, '.jsonl'),
      filePath,
      cwd: meta.cwd,
      title: (meta.id ? titles.get(meta.id) : null) ?? meta.title,
      bytes: st.size,
      updatedAt: new Date(st.mtimeMs).toISOString(),
    });
    scan.totalBytes += st.size;
  }
}

/** Codex 的元信息在头部: 第 1 行 session_meta 有 id/cwd, 首条用户消息当标题 */
function extractCodexMeta(file: string): { id: string | null; cwd: string | null; title: string | null } {
  let id: string | null = null;
  let cwd: string | null = null;
  let title: string | null = null;

  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    let pending = '';
    let consumed = 0;
    let lines = 0;

    while (consumed < MAX_SCAN_BYTES) {
      const n = fs.readSync(fd, buf, 0, CHUNK_BYTES, consumed);
      if (n <= 0) break;
      consumed += n;
      pending += buf.subarray(0, n).toString('utf-8');
      const parts = pending.split('\n');
      pending = parts.pop() ?? '';

      for (const part of parts) {
        const line = part.trim();
        if (!line) continue;
        lines++;
        let d: any;
        try { d = JSON.parse(line); } catch { continue; }

        if (d?.type === 'session_meta' && d?.payload) {
          if (typeof d.payload.id === 'string') id = d.payload.id;
          if (typeof d.payload.cwd === 'string' && d.payload.cwd.trim()) cwd = d.payload.cwd.trim();
        }
        if (!title && d?.type === 'response_item' && d?.payload?.type === 'message' && d.payload.role === 'user') {
          const t = extractText(d.payload.content);
          /* harness 注入块不是用户需求，不能作为会话标题。 */
          if (t && !/^<[a-z_-]+>/i.test(t.trim())) title = t.slice(0, 60);
        }
        if (id && cwd && title) return { id, cwd, title };
      }
      if (lines >= ENOUGH_LINES) break;
    }
  } catch {
    /* 同 Claude 那边: 读不了就当没元信息, 会话照列 */
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  return { id, cwd, title };
}
