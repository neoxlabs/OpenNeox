/**
 * FileAdapter —— 主进程分页读取大文件的适配器.
 *
 * 对应 IntelliJ `platform/lang-impl/.../largeFilesEditor/file/FileAdapter.java`
 *  但接口更贴近前端虚拟滚动的需求 —— 按行而不是按页对外暴露.
 *
 * 职责
 * ----
 *  1. 打开文件拿 fd, 保持到 close()
 *  2. BOM 嗅探自动识别 UTF-8 / UTF-16 LE / UTF-16 BE; 其它编码由用户通过
 *     setEncoding() 指定 (GBK / Big5 / Shift-JIS / windows-1252 ...)
 *  3. 一次性 scan 文件, 建立"稀疏行偏移索引":
 *     每隔 LINE_STRIDE (默认 1000) 行记一次字节 offset (相对 payload).
 *  4. readLines(from, to): 通过索引定位起点, 往后扫 LF 边界读完整的行,
 *     TextDecoder 按当前 encoding 解码.
 *  5. close(): 释放 fd
 *
 * 行边界
 * ------
 *   UTF-8 / GBK / Big5 / Shift-JIS / windows-* / iso-8859-* / koi8-*
 *     → LF 单字节 0x0A, 2 字节以上字符的高字节带 bit7=1, 不跟 \n 冲突
 *   UTF-16LE → LF = [0x0A, 0x00], code unit stride 2
 *   UTF-16BE → LF = [0x00, 0x0A], code unit stride 2
 *
 * 读 chunk 时按 stride 对齐 (chunk 大小截到 stride 的倍数), LF 序列永远落在
 * 单个 chunk 内, 不用保留 leftover.
 */

import { open, stat } from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import { TextDecoder } from 'util';

const LINE_STRIDE = 1000;
const SCAN_CHUNK_BYTES = 1024 * 1024;
const READ_LINES_HARD_CAP_BYTES = 8 * 1024 * 1024;
const READ_LINES_HARD_CAP_LINES = 5000;

export const SUPPORTED_ENCODINGS = [
  'utf-8',
  'utf-16le',
  'utf-16be',
  'gbk',
  'gb18030',
  'big5',
  'shift_jis',
  'euc-kr',
  'euc-jp',
  'windows-1250',
  'windows-1251',
  'windows-1252',
  'windows-1253',
  'windows-1254',
  'windows-1255',
  'windows-1256',
  'windows-1257',
  'windows-1258',
  'iso-8859-1',
  'iso-8859-2',
  'iso-8859-5',
  'iso-8859-7',
  'iso-8859-8',
  'iso-8859-15',
  'koi8-r',
  'koi8-u',
] as const;

export type LargeFileEncoding = typeof SUPPORTED_ENCODINGS[number];

export interface FileAdapterMeta {
  path: string;
  size: number;
  lineCount: number;
  ext: string;
  encoding: LargeFileEncoding;
  detectedBomEncoding?: LargeFileEncoding;
  /** BOM 字节数 */
  bomSize: number;
}

interface LineBoundary {
  seq: number[];
  stride: number;
}

function boundaryFor(encoding: LargeFileEncoding): LineBoundary {
  if (encoding === 'utf-16le') return { seq: [0x0a, 0x00], stride: 2 };
  if (encoding === 'utf-16be') return { seq: [0x00, 0x0a], stride: 2 };
  return { seq: [0x0a], stride: 1 };
}

/** chunk 大小按 stride 对齐, 并确保 >= seq.length 以免空扫 */
function alignedChunk(bytes: number, stride: number): number {
  return Math.max(stride, bytes - (bytes % stride));
}

export class FileAdapter {
  private handle: FileHandle | null = null;
  private _size = 0;
  private _lineCount = 0;
  private encoding: LargeFileEncoding = 'utf-8';
  private detectedBomEncoding: LargeFileEncoding | undefined;
  private bomSize = 0;
  private boundary: LineBoundary = { seq: [0x0a], stride: 1 };
  /** 每 LINE_STRIDE 行的 payload byte offset (0 = 第一行). */
  private sparseOffsets: number[] = [];
  private lastAccessedAt = Date.now();

  constructor(public readonly path: string) {}

  async init(): Promise<FileAdapterMeta> {
    const st = await stat(this.path);
    this._size = st.size;
    this.handle = await open(this.path, 'r');
    await this.detectBom();
    this.boundary = boundaryFor(this.encoding);
    await this.buildIndex();
    return this.meta();
  }

  meta(): FileAdapterMeta {
    const dotIdx = this.path.lastIndexOf('.');
    const slashIdx = Math.max(
      this.path.lastIndexOf('/'),
      this.path.lastIndexOf('\\'),
    );
    const ext = dotIdx > slashIdx ? this.path.slice(dotIdx + 1).toLowerCase() : '';
    return {
      path: this.path,
      size: this._size,
      lineCount: this._lineCount,
      ext,
      encoding: this.encoding,
      detectedBomEncoding: this.detectedBomEncoding,
      bomSize: this.bomSize,
    };
  }

  /**
   * 切换编码. stride 变化必然重建索引.
   */
  async setEncoding(encoding: LargeFileEncoding): Promise<FileAdapterMeta> {
    if (!SUPPORTED_ENCODINGS.includes(encoding)) {
      throw new Error(`unsupported encoding: ${encoding}`);
    }
    const newBoundary = boundaryFor(encoding);
    const needRebuild = newBoundary.stride !== this.boundary.stride;
    this.encoding = encoding;
    this.boundary = newBoundary;
    if (needRebuild) {
      this.sparseOffsets = [];
      this._lineCount = 0;
      await this.buildIndex();
    }
    return this.meta();
  }

  touch(): void { this.lastAccessedAt = Date.now(); }
  idleFor(): number { return Date.now() - this.lastAccessedAt; }

  async close(): Promise<void> {
    const h = this.handle;
    this.handle = null;
    if (h) {
      try { await h.close(); } catch { /* best-effort */ }
    }
  }

  /**
   * 读取 [fromLine, toLine) 区间的行.
   */
  async readLines(fromLine: number, toLine: number): Promise<string[]> {
    this.touch();
    if (!this.handle) throw new Error('FileAdapter closed');
    if (this._lineCount === 0) return [];

    const from = Math.max(0, Math.min(fromLine, this._lineCount));
    const to = Math.max(from, Math.min(toLine, this._lineCount));
    if (to === from) return [];

    const linesNeeded = Math.min(to - from, READ_LINES_HARD_CAP_LINES);
    if (linesNeeded === 0) return [];

    // 定位起点 payload offset
    const startPayload = await this.lineToByteOffset(from);
    let cursorAbs = this.bomSize + startPayload;
    const endAbs = this.bomSize + this.payloadSize();
    const decoder = new TextDecoder(this.encoding);
    const { seq, stride } = this.boundary;

    const lines: string[] = [];
    // lineStartAbs: 当前行在绝对字节里的起点 (每次匹配到 LF 后更新)
    let lineStartAbs = cursorAbs;
    let readBudget = Math.min(endAbs - cursorAbs, READ_LINES_HARD_CAP_BYTES);

    while (lines.length < linesNeeded && cursorAbs < endAbs && readBudget > 0) {
      const want = alignedChunk(Math.min(SCAN_CHUNK_BYTES, readBudget), stride);
      const buf = Buffer.alloc(want);
      const { bytesRead } = await this.handle.read(buf, 0, want, cursorAbs);
      if (bytesRead <= 0) break;
      const slice = bytesRead === want ? buf : buf.subarray(0, bytesRead);
      // chunk 起点的绝对位置
      const chunkStartAbs = cursorAbs;

      for (let i = 0; i + seq.length <= slice.length && lines.length < linesNeeded; i += stride) {
        let ok = true;
        for (let k = 0; k < seq.length; k++) {
          if (slice[i + k] !== seq[k]) { ok = false; break; }
        }
        if (!ok) continue;
        // 一行: 从 lineStartAbs 到 chunkStartAbs + i (不含 LF)
        const absLineStart = lineStartAbs;
        const absLineEnd = chunkStartAbs + i;
        lines.push(await this.decodeRange(absLineStart, absLineEnd, slice, chunkStartAbs, decoder));
        lineStartAbs = chunkStartAbs + i + seq.length;
      }

      cursorAbs += bytesRead;
      readBudget -= bytesRead;
    }

    // 补末尾残行: 没匹配到 LF 但 lineStartAbs < endAbs
    if (lines.length < linesNeeded && lineStartAbs < endAbs) {
      lines.push(await this.decodeRange(lineStartAbs, endAbs, null, 0, decoder));
    }

    return lines;
  }

  // --------------------------------------------------------------------------

  private payloadSize(): number {
    return Math.max(0, this._size - this.bomSize);
  }

  private async detectBom(): Promise<void> {
    if (!this.handle || this._size < 2) return;
    const buf = Buffer.alloc(4);
    const { bytesRead } = await this.handle.read(buf, 0, 4, 0);
    if (bytesRead >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      this.encoding = 'utf-8'; this.detectedBomEncoding = 'utf-8'; this.bomSize = 3; return;
    }
    if (bytesRead >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
      this.encoding = 'utf-16le'; this.detectedBomEncoding = 'utf-16le'; this.bomSize = 2; return;
    }
    if (bytesRead >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
      this.encoding = 'utf-16be'; this.detectedBomEncoding = 'utf-16be'; this.bomSize = 2; return;
    }
  }

  /**
   * 把 [absStart, absEnd) 的字节解码为一行. 如果这段完全在当前 chunk (slice) 里就直接切片;
   * 否则做一次 read(从 absStart 读到 absEnd). readLines 的调用路径保证了 chunk 覆盖当前行,
   * 唯一例外是行跨越多个 chunk 的极长行 (>SCAN_CHUNK_BYTES) —— 这里走 fallback.
   */
  private async decodeRange(
    absStart: number,
    absEnd: number,
    slice: Buffer | null,
    sliceStartAbs: number,
    decoder: TextDecoder,
  ): Promise<string> {
    if (absEnd <= absStart) return '';
    // 命中当前 chunk
    if (slice && absStart >= sliceStartAbs && absEnd <= sliceStartAbs + slice.length) {
      const off = absStart - sliceStartAbs;
      const len = absEnd - absStart;
      return this.decodeSegment(slice.subarray(off, off + len), decoder);
    }
    // fallback: 独立读一段 (跨 chunk 的长行; 少见)
    if (!this.handle) return '';
    const len = absEnd - absStart;
    const capLen = Math.min(len, READ_LINES_HARD_CAP_BYTES);
    const buf = Buffer.alloc(capLen);
    const { bytesRead } = await this.handle.read(buf, 0, capLen, absStart);
    return this.decodeSegment(buf.subarray(0, bytesRead), decoder);
  }

  private decodeSegment(bytes: Buffer, decoder: TextDecoder): string {
    const { stride } = this.boundary;
    let trimmed = bytes;
    if (stride === 1) {
      if (trimmed.length > 0 && trimmed[trimmed.length - 1] === 0x0d) {
        trimmed = trimmed.subarray(0, trimmed.length - 1);
      }
    } else if (stride === 2 && trimmed.length >= 2) {
      const l = trimmed.length;
      if (this.encoding === 'utf-16le' && trimmed[l - 2] === 0x0d && trimmed[l - 1] === 0x00) {
        trimmed = trimmed.subarray(0, l - 2);
      } else if (this.encoding === 'utf-16be' && trimmed[l - 2] === 0x00 && trimmed[l - 1] === 0x0d) {
        trimmed = trimmed.subarray(0, l - 2);
      }
    }
    return decoder.decode(trimmed);
  }

  /**
   * 扫描整个 payload, 建稀疏行索引 + 统计 lineCount.
   */
  private async buildIndex(): Promise<void> {
    if (!this.handle) throw new Error('FileAdapter not opened');
    if (this.payloadSize() === 0) {
      this._lineCount = 0;
      this.sparseOffsets = [0];
      return;
    }

    this.sparseOffsets = [0];
    let lineCount = 0;
    let cursorAbs = this.bomSize;
    const endAbs = this.bomSize + this.payloadSize();
    const { seq, stride } = this.boundary;
    const buf = Buffer.alloc(SCAN_CHUNK_BYTES);

    while (cursorAbs < endAbs) {
      const want = alignedChunk(Math.min(SCAN_CHUNK_BYTES, endAbs - cursorAbs), stride);
      const { bytesRead } = await this.handle.read(buf, 0, want, cursorAbs);
      if (bytesRead <= 0) break;
      const slice = buf.subarray(0, bytesRead);
      for (let i = 0; i + seq.length <= slice.length; i += stride) {
        let ok = true;
        for (let k = 0; k < seq.length; k++) {
          if (slice[i + k] !== seq[k]) { ok = false; break; }
        }
        if (!ok) continue;
        lineCount += 1;
        if (lineCount % LINE_STRIDE === 0) {
          const nextLineStartAbs = cursorAbs + i + seq.length;
          this.sparseOffsets.push(nextLineStartAbs - this.bomSize);
        }
      }
      cursorAbs += bytesRead;
    }

    const endsWithLF = await this.endsWithLF();
    this._lineCount = endsWithLF ? lineCount : lineCount + 1;
  }

  /**
   * lineToByteOffset(L): 第 L 行在 payload 中的起点字节 offset.
   */
  private async lineToByteOffset(line: number): Promise<number> {
    if (line <= 0) return 0;
    if (line >= this._lineCount) return this.payloadSize();

    const anchorIdx = Math.floor(line / LINE_STRIDE);
    const anchorOffset = this.sparseOffsets[anchorIdx] ?? 0;
    let anchorLine = anchorIdx * LINE_STRIDE;
    if (anchorLine === line) return anchorOffset;
    if (!this.handle) throw new Error('FileAdapter closed');

    let cursorAbs = this.bomSize + anchorOffset;
    const endAbs = this.bomSize + this.payloadSize();
    const { seq, stride } = this.boundary;
    const buf = Buffer.alloc(SCAN_CHUNK_BYTES);

    while (anchorLine < line && cursorAbs < endAbs) {
      const want = alignedChunk(Math.min(SCAN_CHUNK_BYTES, endAbs - cursorAbs), stride);
      const { bytesRead } = await this.handle.read(buf, 0, want, cursorAbs);
      if (bytesRead <= 0) break;
      const slice = buf.subarray(0, bytesRead);
      for (let i = 0; i + seq.length <= slice.length; i += stride) {
        let ok = true;
        for (let k = 0; k < seq.length; k++) {
          if (slice[i + k] !== seq[k]) { ok = false; break; }
        }
        if (!ok) continue;
        anchorLine += 1;
        if (anchorLine === line) {
          return (cursorAbs + i + seq.length) - this.bomSize;
        }
      }
      cursorAbs += bytesRead;
    }
    return this.payloadSize();
  }

  private async endsWithLF(): Promise<boolean> {
    if (!this.handle) return false;
    const { seq } = this.boundary;
    const payload = this.payloadSize();
    if (payload < seq.length) return false;
    const tail = Buffer.alloc(seq.length);
    const { bytesRead } = await this.handle.read(tail, 0, seq.length, this.bomSize + payload - seq.length);
    if (bytesRead < seq.length) return false;
    for (let k = 0; k < seq.length; k++) {
      if (tail[k] !== seq[k]) return false;
    }
    return true;
  }
}
