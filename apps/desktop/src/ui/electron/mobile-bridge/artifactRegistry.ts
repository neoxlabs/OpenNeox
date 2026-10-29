/**
 * artifactRegistry.ts — 「agent 这轮做出来的文件」登记处, 给手机端下载用.
 *
 * 起因: 用户在手机上让 agent 做了一份 PPT, 做完了**拿不走** —— timeline 里
 * 只有一行文件名文本, 手机端没有任何下载/预览/分享入口。而 tool_result 的
 * payload 里其实早就带着绝对路径了 (deck_export 回 `{"path":"/Users/.../xx.pptx"}`)。
 *
 * 为什么是"登记 id"而不是"手机传路径来读":
 *   - 手机能传路径 = 任意文件读取。配对过的手机被人拿到就等于拿到整台电脑的
 *     文件系统, 这个口子不能开;
 *   - 产品上也不该开 —— 用户明确说了"整个工程都能拿代价太大", 要的是**产物**。
 *   本模块只登记 agent 自己报出来的产物路径, 手机只能按 id 取, 取不到别的。
 *
 * 边界:
 *   - 只收**当前会话 workspace 之内**的路径, 越界 (含符号链接指出去) 直接丢弃;
 *   - 单文件大小上限 MAX_ARTIFACT_BYTES, 超了不登记 (手机上也不该下 500MB);
 *   - 每会话最多 MAX_PER_SESSION 条, 超了淘汰最旧的;
 *   - 登记项活 TTL_MS, 过期即失效 —— 一次配对泄露不会永久留一个可读句柄。
 */

import { createHash, randomUUID } from 'node:crypto';
import { statSync, realpathSync } from 'node:fs';
import { basename, extname, resolve, sep } from 'node:path';

export interface ArtifactMeta {
  /** 手机拿这个 id 下载, 全局唯一且不可猜 */
  id: string;
  /** 真实绝对路径 — 只在主进程内, 从不下发给手机 */
  absPath: string;
  name: string;
  sizeBytes: number;
  mime: string;
  sessionId: string;
  registeredAt: number;
  /** 内容指纹 (path+size+mtime) — 同一文件重复登记时复用 id, 不重复刷卡片 */
  fingerprint: string;
}

/** 下发给手机的公开形状 — 不含 absPath */
export interface ArtifactPublic {
  id: string;
  name: string;
  size_bytes: number;
  mime: string;
}

const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const MAX_PER_SESSION = 50;
const TTL_MS = 24 * 60 * 60 * 1000;

const bySession = new Map<string, Map<string, ArtifactMeta>>();
const byId = new Map<string, ArtifactMeta>();

const MIME_BY_EXT: Record<string, string> = {
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
};

export function mimeForPath(p: string): string {
  return MIME_BY_EXT[extname(p).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 哪些扩展名值得当"产物"推给手机.
 *
 * 白名单而不是黑名单: agent 干活时会碰几十种中间文件 (.ts/.log/.lock/.map),
 * 一股脑推过去手机 timeline 就成了垃圾场。用户要的是"做完的那个东西"。
 */
const ARTIFACT_EXTS = new Set([
  '.pptx', '.docx', '.xlsx', '.pdf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.zip', '.csv', '.mp4', '.mp3', '.wav',
  '.html', '.mov', '.webm', '.m4a',
]);

export function looksLikeArtifact(p: string): boolean {
  return ARTIFACT_EXTS.has(extname(p).toLowerCase());
}

/**
 * 只允许 **当前会话的 workspace 之内**.
 *
 * 第一版还把整个 `os.tmpdir()` 也算进来了 (想着"有些工具先写临时目录"), 单测里
 * 那条符号链接用例当场把它戳穿: /tmp 下任何进程写的任何文件都会变成手机可取的
 * 产物。这个口子不值得为了少数临时目录产物去开 —— 真正的产物最后总会落到
 * workspace 里, 落不到的宁可没有下载卡。
 *
 * realpath 之后再比: 否则 workspace 里放一个指向 /etc 的符号链接就绕过去了。
 */
function withinAllowedRoot(absPath: string, workspacePath?: string): boolean {
  if (!workspacePath) return false;
  let real: string;
  let root: string;
  try {
    real = realpathSync(absPath);
    root = realpathSync(workspacePath);
  } catch {
    return false;
  }
  return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
}

function prune(sessionId: string): void {
  const map = bySession.get(sessionId);
  if (!map) return;
  const now = Date.now();
  for (const [fp, meta] of [...map]) {
    if (now - meta.registeredAt > TTL_MS) {
      map.delete(fp);
      byId.delete(meta.id);
    }
  }
  while (map.size > MAX_PER_SESSION) {
    const oldest = [...map.entries()].sort((a, b) => a[1].registeredAt - b[1].registeredAt)[0];
    if (!oldest) break;
    map.delete(oldest[0]);
    byId.delete(oldest[1].id);
  }
}

/**
 * 登记一个产物. 返回给手机看的公开形状; 不合规 (越界/太大/读不到) 返回 null.
 *
 * 同一个文件重复登记 (agent 改一版导出一次) 会按 path+size+mtime 复用 id,
 * 手机端就不会每导出一次多一张卡。
 */
export function registerArtifact(
  sessionId: string,
  absPathRaw: string,
  workspacePath?: string,
): ArtifactPublic | null {
  try {
    const absPath = resolve(absPathRaw);
    if (!withinAllowedRoot(absPath, workspacePath)) return null;
    const st = statSync(absPath);
    if (!st.isFile()) return null;
    if (st.size <= 0 || st.size > MAX_ARTIFACT_BYTES) return null;

    const fingerprint = createHash('sha256')
      .update(`${absPath}|${st.size}|${st.mtimeMs}`)
      .digest('hex')
      .slice(0, 32);

    let map = bySession.get(sessionId);
    if (!map) { map = new Map(); bySession.set(sessionId, map); }

    const existing = map.get(fingerprint);
    if (existing) {
      existing.registeredAt = Date.now();
      return toPublic(existing);
    }

    const meta: ArtifactMeta = {
      id: `art-${randomUUID()}`,
      absPath,
      name: basename(absPath),
      sizeBytes: st.size,
      mime: mimeForPath(absPath),
      sessionId,
      registeredAt: Date.now(),
      fingerprint,
    };
    map.set(fingerprint, meta);
    byId.set(meta.id, meta);
    prune(sessionId);
    return toPublic(meta);
  } catch {
    return null;
  }
}

function toPublic(m: ArtifactMeta): ArtifactPublic {
  return { id: m.id, name: m.name, size_bytes: m.sizeBytes, mime: m.mime };
}

/** 按 id 取登记项 — file.fetch 用. 过期/不存在返回 null. */
export function lookupArtifact(id: string): ArtifactMeta | null {
  const meta = byId.get(id);
  if (!meta) return null;
  if (Date.now() - meta.registeredAt > TTL_MS) {
    byId.delete(id);
    bySession.get(meta.sessionId)?.delete(meta.fingerprint);
    return null;
  }
  return meta;
}

/** 测试/退出清理用 */
export function _resetArtifactRegistry(): void {
  bySession.clear();
  byId.clear();
}

export const ARTIFACT_LIMITS = { MAX_ARTIFACT_BYTES, MAX_PER_SESSION, TTL_MS };
