import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import { bridgeLog } from './log.js';

/* ── 上限 ─────────────────────────────────────────────────────────────────── */
export const MAX_ATTACHMENT_NAME_LEN = 120;
export const MAX_ATTACHMENT_MIME_LEN = 120;
/** 内联 base64 (单包) 上限 —— 跟 LAN WS maxPayload 2MB 留余量 */
export const MAX_INLINE_B64_LEN = 1536 * 1024;
/** 分片上传的单片上限: 加密 + base64 后要 < 中转 256KB */
export const MAX_UPLOAD_CHUNK_B64_LEN = 128 * 1024;
/** 一个附件的原始字节上限 (图片 / Excel 等) */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** 一条连接同时挂着的未消费上传总量 */
export const MAX_PENDING_UPLOAD_BYTES_PER_CONN = 64 * 1024 * 1024;
/** 上传开始后多久没被 session.input 引用就丢 (手机中途退出) */
const UPLOAD_TTL_MS = 10 * 60_000;
/** 解析出的 markdown 上限 — 跟 renderer documentParsers/index.ts 一致 */
const MAX_MARKDOWN_CHARS = 200 * 1024;

const DOCUMENT_CACHE_DIR = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'documents');

/* ── 分片上传 ─────────────────────────────────────────────────────────────── */

interface PendingUpload {
  id: string;
  ownerKey: string;
  kind: 'image' | 'file';
  name: string;
  mime: string;
  declaredSize: number;
  chunks: Buffer[];
  received: number;
  nextIndex: number;
  done: boolean;
  startedAt: number;
}

const uploads = new Map<string, PendingUpload>();
let sweeper: NodeJS.Timeout | null = null;

function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, u] of uploads) {
      if (now - u.startedAt > UPLOAD_TTL_MS) {
        uploads.delete(id);
        bridgeLog('upload', `expired ${id} (${u.name}, ${u.received}B)`);
      }
    }
    if (uploads.size === 0 && sweeper) { clearInterval(sweeper); sweeper = null; }
  }, 60_000);
  sweeper.unref?.();
}

function pendingBytesOf(ownerKey: string): number {
  let n = 0;
  for (const u of uploads.values()) if (u.ownerKey === ownerKey) n += u.received;
  return n;
}

export class AttachmentError extends Error {}

function cleanLabel(value: unknown, fallback: string, maxLen: number): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\u0000-\u001F\u007F/\\]/g, ' ').trim().slice(0, maxLen);
  return cleaned || fallback;
}

function cleanMime(value: unknown, fallback: string, maxLen: number): string {
  if (typeof value !== 'string') return fallback;
  const v = value.trim().toLowerCase().slice(0, maxLen);
  return /^[a-z0-9][\w.+-]*\/[a-z0-9][\w.+-]*$/.test(v) ? v : fallback;
}

/** attachment.begin — 返回 upload_id。ownerKey 用连接 / 设备标识, 只允许同一来源续传与引用。 */
export function beginUpload(ownerKey: string, params: any): { upload_id: string } {
  const kind = params?.kind === 'image' ? 'image' : params?.kind === 'file' ? 'file' : null;
  if (!kind) throw new AttachmentError('kind must be image|file');
  const declaredSize = typeof params?.size_bytes === 'number' && Number.isFinite(params.size_bytes)
    ? Math.max(0, Math.trunc(params.size_bytes)) : 0;
  if (declaredSize > MAX_UPLOAD_BYTES) {
    throw new AttachmentError(`attachment too large (${declaredSize}B > ${MAX_UPLOAD_BYTES}B)`);
  }
  if (pendingBytesOf(ownerKey) + declaredSize > MAX_PENDING_UPLOAD_BYTES_PER_CONN) {
    throw new AttachmentError('too many pending uploads');
  }
  const id = `up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  uploads.set(id, {
    id,
    ownerKey,
    kind,
    name: cleanLabel(params?.name, `attachment`, MAX_ATTACHMENT_NAME_LEN),
    mime: cleanMime(params?.mime, 'application/octet-stream', MAX_ATTACHMENT_MIME_LEN),
    declaredSize,
    chunks: [],
    received: 0,
    nextIndex: 0,
    done: false,
    startedAt: Date.now(),
  });
  ensureSweeper();
  return { upload_id: id };
}

/** attachment.chunk — 按 index 顺序收; 乱序 / 重复直接报错, 手机端整个重来 (它本来就是顺序发的)。 */
export function appendUploadChunk(ownerKey: string, params: any): { received: number } {
  const u = uploads.get(String(params?.upload_id ?? ''));
  if (!u || u.ownerKey !== ownerKey) throw new AttachmentError('unknown upload_id');
  if (u.done) throw new AttachmentError('upload already finished');
  const index = typeof params?.index === 'number' ? params.index : -1;
  if (index !== u.nextIndex) throw new AttachmentError(`chunk out of order (expected ${u.nextIndex}, got ${index})`);
  const b64 = typeof params?.data_base64 === 'string' ? params.data_base64 : '';
  if (!b64 || b64.length > MAX_UPLOAD_CHUNK_B64_LEN) {
    throw new AttachmentError(`chunk must be 1..${MAX_UPLOAD_CHUNK_B64_LEN} base64 chars`);
  }
  const buf = Buffer.from(b64, 'base64');
  if (u.received + buf.length > MAX_UPLOAD_BYTES) {
    uploads.delete(u.id);
    throw new AttachmentError(`attachment too large (> ${MAX_UPLOAD_BYTES}B)`);
  }
  u.chunks.push(buf);
  u.received += buf.length;
  u.nextIndex += 1;
  return { received: u.received };
}

/** attachment.end — 封口。之后 session.input 用 upload_id 引用一次, 引用即消费。 */
export function finishUpload(ownerKey: string, params: any): { ok: true; size_bytes: number } {
  const u = uploads.get(String(params?.upload_id ?? ''));
  if (!u || u.ownerKey !== ownerKey) throw new AttachmentError('unknown upload_id');
  if (u.declaredSize > 0 && u.received !== u.declaredSize) {
    uploads.delete(u.id);
    throw new AttachmentError(`size mismatch: declared ${u.declaredSize}, received ${u.received}`);
  }
  u.done = true;
  return { ok: true, size_bytes: u.received };
}

/** 连接断开时把这条连接的半截上传全丢掉 */
export function dropUploadsOf(ownerKey: string): void {
  for (const [id, u] of uploads) if (u.ownerKey === ownerKey) uploads.delete(id);
}

/* ── 归一: 手机 wire 项 → {kind, name, mime, bytes} ─────────────────────────── */

export interface IncomingAttachment {
  kind: 'image' | 'file';
  name: string;
  mime: string;
  bytes: Buffer;
}

/**
 * session.input payload.attachments[] 的每一项要么内联 data_base64, 要么 upload_id。
 * 任何一项不合法都**抛错**而不是跳过 —— 跳过的后果是模型收到「看一下这些附件」却一个附件都没有,
 * 用户看到的是一句答非所问; 报错至少让手机端说得出"哪个文件没发上去"。
 */
export function resolveIncomingAttachments(ownerKey: string, raw: unknown[]): IncomingAttachment[] {
  const out: IncomingAttachment[] = [];
  raw.forEach((a: any, i) => {
    const kind = a?.kind === 'image' || a?.kind === 'file' ? a.kind : null;
    if (!kind) throw new AttachmentError(`attachment #${i + 1}: kind must be image|file`);
    const name = cleanLabel(a?.name, `attachment-${i + 1}`, MAX_ATTACHMENT_NAME_LEN);
    const mime = cleanMime(a?.mime, 'application/octet-stream', MAX_ATTACHMENT_MIME_LEN);
    if (typeof a?.upload_id === 'string' && a.upload_id) {
      const u = uploads.get(a.upload_id);
      if (!u || u.ownerKey !== ownerKey || !u.done) {
        throw new AttachmentError(`${name}: upload not found or not finished (${a.upload_id})`);
      }
      uploads.delete(u.id);
      out.push({ kind, name: u.name || name, mime: u.mime || mime, bytes: Buffer.concat(u.chunks) });
      return;
    }
    const b64 = typeof a?.data_base64 === 'string' ? a.data_base64 : '';
    if (!b64) throw new AttachmentError(`${name}: empty attachment`);
    if (b64.length > MAX_INLINE_B64_LEN) {
      throw new AttachmentError(`${name}: too large for inline (${b64.length} chars), use chunked upload`);
    }
    out.push({ kind, name, mime, bytes: Buffer.from(b64, 'base64') });
  });
  return out;
}

/* ── 解析: 文件 → markdown → 文档缓存 → 桌面 Attachment ───────────────────────── */

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log',
  'xml', 'html', 'htm', 'css', 'scss', 'less', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb',
  'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'zsh', 'bash',
  'sql', 'dart', 'lua', 'r', 'm', 'gradle', 'properties', 'env', 'csv', 'tsv', 'srt', 'vtt',
]);

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

/** 字节像不像文本: 没有 NUL, 且 UTF-8 解码后替换字符占比极低 */
function looksLikeUtf8Text(buf: Buffer): boolean {
  const probe = buf.subarray(0, 64 * 1024);
  if (probe.includes(0)) return false;
  const s = probe.toString('utf-8');
  if (s.length === 0) return true;
  let bad = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 0xfffd) bad++;
  return bad / s.length < 0.002;
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

export interface ParsedDocument {
  markdown: string;
  channel: string;
  pages?: number;
  sheets?: number;
}

/** PDF: 走 core 的 pdftotext 文本通道 (跟 readfile 一样), 要落一个临时文件。 */
async function parsePdf(buf: Buffer): Promise<ParsedDocument> {
  const { extractPdfText } = await import('@neoxlabs/core');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-mobile-pdf-'));
  const file = path.join(dir, 'doc.pdf');
  try {
    await fs.writeFile(file, buf);
    const r = await extractPdfText(file);
    if (!r.valid) throw new AttachmentError(r.error || 'PDF 解析失败');
    if (!r.hasTextLayer) throw new AttachmentError('这个 PDF 没有文字层 (扫描件), 手机端暂时读不了');
    return { markdown: r.text, channel: 'local-pdftotext', pages: r.totalPages };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 按扩展名分发到桌面 renderer 同一批本地解析器 (excel / word / pptx 都不依赖 DOM;
 * pdf 那个用了 vite 的 ?worker, 主进程不能引, 改走 pdftotext)。
 */
export async function parseFileAttachment(name: string, buf: Buffer): Promise<ParsedDocument> {
  const ext = extOf(name);
  if (ext === 'pdf') return parsePdf(buf);
  if (ext === 'docx' || ext === 'doc') {
    const { parseWordLocal } = await import('../../renderer/services/documentParsers/wordParser.js');
    return { markdown: (await parseWordLocal(toArrayBuffer(buf))).markdown, channel: 'local-mammoth' };
  }
  if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm' || ext === 'csv' || ext === 'tsv') {
    const { parseExcelLocal } = await import('../../renderer/services/documentParsers/excelParser.js');
    const r = await parseExcelLocal(toArrayBuffer(buf));
    return { markdown: r.markdown, channel: 'local-xlsx', sheets: r.sheets };
  }
  if (ext === 'pptx') {
    const { parsePptxLocal } = await import('../../renderer/services/documentParsers/pptxParser.js');
    const r = await parsePptxLocal(toArrayBuffer(buf));
    return { markdown: r.markdown, channel: 'local-pptx', pages: r.pages };
  }
  if (TEXT_EXTS.has(ext) || looksLikeUtf8Text(buf)) {
    if (!looksLikeUtf8Text(buf)) throw new AttachmentError(`${name}: 不是 UTF-8 文本`);
    return { markdown: buf.toString('utf-8'), channel: 'local-plain' };
  }
  throw new AttachmentError(`${name}: 这种文件手机端暂时发不了 (支持 Excel / Word / PPT / PDF / 文本)`);
}

/** 跟 renderer documentCacheHandlers 同一个目录、同一个原子写法 */
async function writeDocumentCache(fileId: string, markdown: string): Promise<void> {
  await fs.mkdir(DOCUMENT_CACHE_DIR, { recursive: true });
  const p = path.join(DOCUMENT_CACHE_DIR, `${fileId}.md`);
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, markdown, 'utf-8');
  await fs.rename(tmp, p);
}

/** 文件名去掉路径和非法字符; 空了给个默认名 */
function safeFileName(name: string, fallback: string): string {
  const base = path.basename(String(name || '')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return base && base !== '.' && base !== '..' ? base : fallback;
}

export async function saveToWorkspace(workspacePath: string, name: string, bytes: Buffer): Promise<string> {
  const dir = path.join(workspacePath, 'uploads');
  await fs.mkdir(dir, { recursive: true });
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let file = name;
  for (let n = 2; ; n++) {
    try {
      await fs.writeFile(path.join(dir, file), bytes, { flag: 'wx' });
      break;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      /* 同一个文件又发一遍: 内容一样就直接用那份 */
      const prev = await fs.readFile(path.join(dir, file)).catch(() => null);
      if (prev && prev.equals(bytes)) break;
      file = `${stem} (${n})${ext}`;
    }
  }
  return path.join(dir, file);
}

/**
 * 归一后的附件 → 桌面 Attachment (metadata.attachments[] 的元素)。
 *  image → { type:'image', data: data:URL }
 *  file  → 解析成 markdown, 写文档缓存, { type:'file', data:'', fileId, chars, channel, ... }
 *          —— 跟 TimelineComposer.intake 的 v2 形状一致, agent 用 read_document(fileId) 读。
 * 有 workspacePath 时原件另存到工作区 uploads/, 路径放在 path (prepareTaskInputText 拼进给模型的提示,
 * 不进用户气泡); 解析不了的格式 (zip / 音视频 / 图纸 ...) 不再报错, 只存原件让 agent 用工具处理。
 */
export async function toDesktopAttachments(
  items: IncomingAttachment[],
  opts: { workspacePath?: string | null } = {},
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const [i, a] of items.entries()) {
    const id = `mobile-attach-${Date.now()}-${i}`;
    const name = safeFileName(a.name, a.kind === 'image' ? `photo-${Date.now()}.jpg` : `file-${Date.now()}`);
    let savedPath: string | undefined;
    if (opts.workspacePath) {
      try {
        savedPath = await saveToWorkspace(opts.workspacePath, name, a.bytes);
        bridgeLog('upload', `saved ${name} → ${savedPath}`);
      } catch (e: any) {
        bridgeLog('upload', `save ${name} to workspace failed: ${e?.message ?? e}`);
      }
    }
    if (a.kind === 'image') {
      /* 图片类型报错了 / 没报: 当 jpeg (手机相机出的就是 jpeg), 不拼出模型不认的 data URL */
      const mime = a.mime.startsWith('image/') ? a.mime : 'image/jpeg';
      out.push({
        id, type: 'image', data: `data:${mime};base64,${a.bytes.toString('base64')}`, name: a.name, size: a.bytes.length,
        ...(savedPath ? { path: savedPath } : {}),
      });
      continue;
    }
    let parsed: ParsedDocument;
    try {
      parsed = await parseFileAttachment(a.name, a.bytes);
    } catch (e) {
      /* 读不出文字的格式: 原件已经在工作区就照样交给 agent; 没存成才报错 */
      if (!savedPath || !(e instanceof AttachmentError)) throw e;
      out.push({ id, type: 'file', data: '', name: a.name, size: a.bytes.length, path: savedPath, status: 'saved' });
      continue;
    }
    let markdown = parsed.markdown;
    if (markdown.length > MAX_MARKDOWN_CHARS) {
      markdown = `${markdown.slice(0, MAX_MARKDOWN_CHARS)}\n\n_..文档过长, 已截断前 ${MAX_MARKDOWN_CHARS} 字符 (原始 ${parsed.markdown.length} 字符)_`;
    }
    const fileId = createHash('sha256').update(a.bytes).digest('hex');
    await writeDocumentCache(fileId, markdown);
    bridgeLog('upload', `parsed ${a.name} via ${parsed.channel}: ${markdown.length} chars → ${fileId.slice(0, 12)}`);
    out.push({
      id,
      type: 'file',
      data: '',
      name: a.name,
      size: a.bytes.length,
      fileId,
      summary: markdown.slice(0, 200),
      chars: markdown.length,
      ...(parsed.pages ? { pages: parsed.pages } : {}),
      ...(parsed.sheets ? { sheets: parsed.sheets } : {}),
      channel: parsed.channel,
      status: 'parsed',
      ...(savedPath ? { path: savedPath } : {}),
    });
  }
  return out;
}

/** 测试用 */
export function __resetUploadsForTest(): void {
  uploads.clear();
}
