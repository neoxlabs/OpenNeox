/**
 * gitEncoding — git 输出的**文件内容**字节流解码 (成熟版)
 *
 * 背景: git show / git diff 输出的是文件**原始字节**. 直接按 UTF-8 解码, 对 Windows 上
 * 常见的 GBK / GB18030 / Big5 / Shift_JIS 等非 UTF-8 源码会变乱码. 这里做稳妥探测:
 *
 *   1. BOM 优先 (UTF-8 / UTF-16 LE/BE BOM 直接定编码).
 *   2. 二进制防呆: 前段出现 NUL 字节 → 当二进制, 返回空串 (viewer 不该渲染二进制).
 *   3. 有效 UTF-8 → 直接 UTF-8 (现代文件绝大多数命中, 零误判).
 *   4. 否则 chardet 探测 → iconv-lite 解码; 探测不可用/失败 → GB18030 兜底
 *      (中文 Windows 最常见; GB18030 是 GBK/GB2312 的超集, 向下兼容) → 再不行 latin1 保底.
 *
 * 只用于"文件内容"通道 (diff 正文 / git show <hash>:<path>). 路径/分支/log 等 git 自身
 * 输出仍走 UTF-8 + core.quotepath=false (见 gitHandlers).
 */

import iconv from 'iconv-lite';
import chardet from 'chardet';

/** 前 N 字节里有 NUL → 判为二进制 */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function isValidUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/** 把 chardet 返回名规整成 iconv 认识的, 顺便把可疑的西文单字节探测纠偏到 GB18030 */
function normalizeEncoding(detected: string | null, buf: Buffer): string {
  if (!detected) return 'GB18030';
  const lower = detected.toLowerCase();
  if (lower === 'ascii' || lower === 'utf-8' || lower === 'utf8') return 'UTF-8';
  /* chardet 对中文 GBK 偶尔误报成 windows-1252 / ISO-8859-1 (都是西文单字节).
   * 若高位字节占比明显 (典型多字节 CJK), 纠偏到 GB18030 — 比西文单字节解码更可能对. */
  if (lower.includes('1252') || lower.includes('8859') || lower.includes('windows-125')) {
    let high = 0;
    const n = Math.min(buf.length, 4000);
    for (let i = 0; i < n; i++) if (buf[i] >= 0x80) high++;
    if (n > 0 && high / n > 0.15) return 'GB18030';
  }
  return detected;
}

/**
 * 解码 git 输出的文件内容字节. 返回可安全渲染的字符串.
 * 二进制内容返回空串.
 */
export function decodeGitBytes(buf: Buffer): string {
  if (!buf || buf.length === 0) return '';

  /* BOM */
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString('utf-8');
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return iconv.decode(buf.slice(2), 'utf-16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return iconv.decode(buf.slice(2), 'utf-16be');
  }

  if (looksBinary(buf)) return '';

  /* 现代文件: 有效 UTF-8 直接用, 零误判 */
  if (isValidUtf8(buf)) return buf.toString('utf-8');

  /* 非 UTF-8 → 探测 + iconv */
  let enc: string;
  try {
    enc = normalizeEncoding(chardet.detect(buf), buf);
  } catch {
    enc = 'GB18030';
  }
  if (enc === 'UTF-8') return buf.toString('utf-8');
  try {
    if (iconv.encodingExists(enc)) return iconv.decode(buf, enc);
  } catch { /* fall through */ }
  /* 兜底链: GB18030 (中文 Win 最常见) → latin1 (永不抛, 至少不丢字节) */
  try {
    return iconv.decode(buf, 'GB18030');
  } catch {
    return iconv.decode(buf, 'latin1');
  }
}
