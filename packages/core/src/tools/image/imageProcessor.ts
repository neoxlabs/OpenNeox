/**
 * Image Processor — 图片检测、读取、压缩、base64 编码
 *
 * 参考 OpenAI Codex (Apache-2.0): codex-rs/utils/image
 */

import * as fs from 'fs/promises';
import * as path from 'path';

// ============================================================================
// 常量
// ============================================================================

/** 支持的图片扩展名 */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg']);

/** API 允许的最大 base64 大小 (5MB) */
export const API_IMAGE_MAX_BASE64_SIZE = 5 * 1024 * 1024;

/** 目标原始文件大小 (3.75MB — base64 后约 5MB) */
export const IMAGE_TARGET_RAW_SIZE = 3.75 * 1024 * 1024;

/** 最大图片尺寸 */
export const IMAGE_MAX_WIDTH = 2000;
export const IMAGE_MAX_HEIGHT = 2000;

/** Compress attached images at session ingress so repeated history payloads
 * stay within the API budget while preserving the visual input. */
const ATTACHMENT_MAX_BASE64_BYTES = (() => {
  const raw = process.env.NEOX_MAX_ATTACHMENT_IMAGE_BYTES;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1.2 * 1024 * 1024; // 默认 ~1.2MB
})();
/** 压缩时的最大边长(对齐 Claude Code ~1568px 量级)。 */
const ATTACHMENT_MAX_DIM = 1568;
/** 尺寸触发阈值: 任一边超过它就压(即使字节小)。Anthropic 按 宽×高/750 计 token,
 *  一张 4000×3000 的高压缩率 JPEG 字节可能只有几百 KB, token 却是 1.6 万 — 必须按像素压。 */
const ATTACHMENT_MAX_TRIGGER_DIM = 1600;

export interface AttachmentImageCompressResult {
  url: string;
  originalBytes: number;
  compressedBytes: number;
  compressed: boolean;
  /** 最终图片(压缩后或原图)的像素尺寸, 供精确 token 估算; sharp 不可用/读不到 → undefined */
  width?: number;
  height?: number;
}

/**
 * 图片入口统一预算漏斗: **任何图片进会话历史前必须过这里**。
 * 双触发条件(满足任一即压):
 *   1. base64 超字节预算 (~1.2MB, NEOX_MAX_ATTACHMENT_IMAGE_BYTES 覆盖)
 *   2. 任一边超过 1600px (sharp metadata 读尺寸, 很便宜) — 治"小字节巨像素"吃 token
 * 压缩目标: 长边 1568px + JPEG q72。
 * GIF 例外: 只按字节触发(sharp 会取首帧丢动图语义, 尺寸检查跳过)。
 * sharp 不可用 / 解析失败 / 压完没更小 → 安全回退原图(绝不弄坏附件)。
 */
export async function compressImageDataUrlIfNeeded(
  dataUrl: string,
): Promise<AttachmentImageCompressResult> {
  const noop = (dims?: { width?: number; height?: number }): AttachmentImageCompressResult => ({
    url: dataUrl,
    originalBytes: dataUrl.length,
    compressedBytes: dataUrl.length,
    compressed: false,
    width: dims?.width,
    height: dims?.height,
  });
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) return noop();
  const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s);
  if (!m) return noop();
  const mediaType = m[1].toLowerCase();
  const b64 = m[2];
  const originalBytes = b64.length;
  const overBytes = originalBytes > ATTACHMENT_MAX_BASE64_BYTES;
  const isGif = mediaType === 'image/gif';
  // SVG 走文本路径, 不进像素漏斗(sharp 会栅格化改变语义)
  if (mediaType === 'image/svg+xml') return noop();
  // GIF: 尺寸检查跳过(避免动图被取首帧), 只按字节; 字节不超 → 原样
  if (isGif && !overBytes) return noop();
  try {
    const sharp = (await import('sharp')).default;
    const buf = Buffer.from(b64, 'base64');

    let srcWidth: number | undefined;
    let srcHeight: number | undefined;
    if (!overBytes) {
      // 字节没超 → 只有像素超标才压。metadata 只读 header, 很便宜。
      const meta = await sharp(buf).metadata();
      srcWidth = meta.width;
      srcHeight = meta.height;
      const overDim = (srcWidth ?? 0) > ATTACHMENT_MAX_TRIGGER_DIM
        || (srcHeight ?? 0) > ATTACHMENT_MAX_TRIGGER_DIM;
      if (!overDim) return noop({ width: srcWidth, height: srcHeight });
    }

    const { data: out, info } = await sharp(buf)
      .resize(ATTACHMENT_MAX_DIM, ATTACHMENT_MAX_DIM, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 72 })
      .toBuffer({ resolveWithObject: true });
    const newB64 = out.toString('base64');
    /* 字节触发: 压完必须更小才换。像素触发(!overBytes): 字节可能反而变大
     * (高压缩率源 JPEG 重编码), 但只要仍在字节预算内就换 — 目的是省 token 不是省字节。 */
    const acceptable = overBytes
      ? newB64.length < originalBytes
      : newB64.length <= ATTACHMENT_MAX_BASE64_BYTES;
    if (!acceptable) return noop({ width: srcWidth, height: srcHeight });
    return {
      url: `data:image/jpeg;base64,${newB64}`,
      originalBytes,
      compressedBytes: newB64.length,
      compressed: true,
      width: info?.width,
      height: info?.height,
    };
  } catch {
    return noop(); // sharp 未安装 / 解码失败 → 安全回退
  }
}

/** PDF 魔术字节 */
const PDF_MAGIC = Buffer.from('%PDF-');

/** PDF 单次最大页数 */
export const PDF_MAX_PAGES_PER_READ = 20;

// ============================================================================
// 图片格式检测
// ============================================================================

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/svg+xml';

/**
 * 通过文件扩展名检测是否为图片
 */
export function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * 通过文件扩展名检测是否为 PDF
 */
export function isPdfFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.pdf';
}

/**
 * 通过 magic bytes 检测图片格式
 */
export function detectImageFormatFromBuffer(buffer: Buffer): ImageMediaType | null {
  if (buffer.length < 4) return null;

  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'image/jpeg';
  }

  // GIF: 47 49 46 (GIF)
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return 'image/gif';
  }

  // WebP: RIFF....WEBP
  if (buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'image/webp';
  }

  return null;
}

/**
 * 从扩展名推断 MIME 类型
 */
export function getMediaTypeFromExtension(filePath: string): ImageMediaType {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    default: return 'image/png'; // fallback
  }
}

// ============================================================================
// 图片读���与编码
// ============================================================================

export interface ImageReadResult {
  /** base64 编码的图片数据 */
  base64: string;
  /** MIME 类型 */
  mediaType: ImageMediaType;
  /** 原始文件大小 (bytes) */
  rawSize: number;
  /** base64 大小 (bytes) */
  base64Size: number;
  /** 是否被压缩/缩放 */
  wasResized: boolean;
  /** data URL (data:{mediaType};base64,{data}) */
  dataUrl: string;
}

/**
 * 读取并编码图片文件
 *
 * 流程:
 * 1. 读取原始字节
 * 2. 检测格式 (magic bytes > extension)
 * 3. 如果超过大小限制，尝试压缩
 * 4. 编码为 base64
 */
export async function readImageFile(filePath: string): Promise<ImageReadResult> {
  const buffer = await fs.readFile(filePath);
  const rawSize = buffer.length;

  // 检测格式
  let mediaType = detectImageFormatFromBuffer(buffer) ?? getMediaTypeFromExtension(filePath);

  // SVG 特殊处理 — 作为文本返回 base64
  if (mediaType === 'image/svg+xml' || filePath.endsWith('.svg')) {
    mediaType = 'image/svg+xml';
  }

  let finalBuffer: Buffer = buffer;
  let wasResized = false;

  // 如果文件太大，尝试压缩
  if (rawSize > IMAGE_TARGET_RAW_SIZE) {
    const compressed = await tryCompressImage(buffer, mediaType);
    if (compressed) {
      finalBuffer = Buffer.from(compressed.buffer);
      mediaType = compressed.mediaType;
      wasResized = true;
    }
  }

  const base64 = finalBuffer.toString('base64');
  const base64Size = base64.length;

  // 如果 base64 仍然超过 API 限制，强制压缩
  if (base64Size > API_IMAGE_MAX_BASE64_SIZE && !wasResized) {
    const compressed = await tryCompressImage(buffer, mediaType, true);
    if (compressed) {
      finalBuffer = Buffer.from(compressed.buffer);
      mediaType = compressed.mediaType;
      wasResized = true;
    }
  }

  // 统一漏斗: readfile 路径的产物同样压到附件预算(~1.2MB)内。
  // 此前只有粘贴/拖拽附件走入口压缩, readfile 阈值 3.75MB 的漏网大图
  // 沉进历史每轮重传, 是"上下文瞬间吃满"的主要来源之一。
  const finalB64 = finalBuffer.toString('base64');
  const funneled = await compressImageDataUrlIfNeeded(`data:${mediaType};base64,${finalB64}`);
  if (funneled.compressed) {
    const m2 = funneled.url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s);
    if (m2) {
      return {
        base64: m2[2],
        mediaType: m2[1] as ImageMediaType,
        rawSize,
        base64Size: m2[2].length,
        wasResized: true,
        dataUrl: funneled.url,
      };
    }
  }

  return {
    base64: finalB64,
    mediaType,
    rawSize,
    base64Size: finalB64.length,
    wasResized,
    dataUrl: `data:${mediaType};base64,${finalB64}`,
  };
}

// ============================================================================
// 图片压缩 (轻量级 — 不依赖 sharp)
// ============================================================================

/**
 * 尝试压缩图片
 *
 * 策略 (不依赖 sharp，使用 Node.js 原生能力):
 * - 小于目标大小: 直接返回
 * - 超过目标大小: 尝���用 canvas 缩��� (如果可用)
 * - 最终回退: 截断并警告
 */
async function tryCompressImage(
  buffer: Buffer,
  mediaType: ImageMediaType,
  aggressive = false,
): Promise<{ buffer: Buffer; mediaType: ImageMediaType } | null> {
  // 尝试使用 sharp (如果安装了)
  try {
    const sharp = await import('sharp');
    const targetSize = aggressive ? IMAGE_TARGET_RAW_SIZE / 2 : IMAGE_TARGET_RAW_SIZE;

    let pipeline = sharp.default(buffer);
    const metadata = await pipeline.metadata();

    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;

    // ��放到限制内
    if (width > IMAGE_MAX_WIDTH || height > IMAGE_MAX_HEIGHT) {
      pipeline = pipeline.resize(IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    } else if (aggressive) {
      // aggressive 模式: 缩小到一半
      pipeline = pipeline.resize(Math.round(width / 2), Math.round(height / 2), {
        fit: 'inside',
      });
    }

    // 输出为 JPEG (最小体积)
    if (aggressive || mediaType === 'image/jpeg') {
      const quality = aggressive ? 40 : 70;
      const result = await pipeline.jpeg({ quality }).toBuffer();
      if (result.length <= targetSize) {
        return { buffer: result, mediaType: 'image/jpeg' };
      }
      // 再降质量
      const result2 = await pipeline.jpeg({ quality: 20 }).toBuffer();
      return { buffer: result2, mediaType: 'image/jpeg' };
    }

    // PNG: 压缩级别 9
    if (mediaType === 'image/png') {
      const result = await pipeline.png({ compressionLevel: 9 }).toBuffer();
      if (result.length <= targetSize) {
        return { buffer: result, mediaType: 'image/png' };
      }
      // 转 JPEG
      const jpegResult = await pipeline.jpeg({ quality: 70 }).toBuffer();
      return { buffer: jpegResult, mediaType: 'image/jpeg' };
    }

    // WebP
    if (mediaType === 'image/webp') {
      const result = await pipeline.webp({ quality: aggressive ? 40 : 70 }).toBuffer();
      return { buffer: result, mediaType: 'image/webp' };
    }

    return null;
  } catch {
    // sharp 未安装 — 无法压缩，直接返回原始数据
    // 如果超过限制，返回 null (调用方会截断)
    if (buffer.length > API_IMAGE_MAX_BASE64_SIZE * 0.75) {
      return null; // 太大了，无法压缩
    }
    return { buffer, mediaType };
  }
}

// ============================================================================
// PDF 支持
// ============================================================================

export interface PdfReadResult {
  /** PDF 页面图片 (base64 JPEG) */
  pages: Array<{
    pageNumber: number;
    base64: string;
    mediaType: ImageMediaType;
  }>;
  /** 总页数 */
  totalPages: number;
  /** 是否有效 */
  valid: boolean;
  /** 错误信息 */
  error?: string;
  /** 请求的起始页超出总页数 —— 不是读取故障, 调用方应把 error 当说明文字回给模型 */
  pageRangeOutOfBounds?: boolean;
}

/**
 * 读取 PDF 文件，转换为图片
 *
 * 使��� pdftoppm (poppler-utils) 将 PDF 页面���为 JPEG
 */
export interface PdfTextResult {
  valid: boolean;
  /** 有实质文本层 (扫描版/纯图 PDF 为 false, 应回退图片通道) */
  hasTextLayer: boolean;
  text: string;
  totalPages: number;
  firstPage: number;
  lastPage: number;
  error?: string;
  /** 同 PdfReadResult.pageRangeOutOfBounds */
  pageRangeOutOfBounds?: boolean;
}

/** pdfinfo 读总页数; 读不出来给 0 (调用方按"页数未知"处理, 不做越界判断)。 */
export async function getPdfPageCount(filePath: string): Promise<number> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  try {
    const { stdout } = await promisify(execFile)('pdfinfo', [filePath], { timeout: 15000 });
    const m = String(stdout).match(/^Pages:\s+(\d+)/m);
    return m ? parseInt(m[1], 10) : 0;
  } catch {
    return 0;
  }
}

export type PdfPageRange =
  | { ok: true; firstPage: number; lastPage: number }
  | { ok: false; message: string };

/**
 * 把 pages 参数解析成**一定合法**的页码区间 —— 文本通道和图片通道共用, 只此一处。
 *
 *   The normalized range always satisfies 1 ≤ first ≤ last ≤ total before
 *   either text extraction or rasterization invokes Poppler. An out-of-range
 *   start returns an actionable message instead of constructing an invalid command.
 *
 *   · 解析不了的写法 (如 "abc") → 按未指定处理, 从第 1 页读
 *   · "4-2" 这种倒序 → 交换
 *   · first < 1 → 1
 */
export function resolvePdfPageRange(pages: string | undefined, totalPages: number, maxPages: number): PdfPageRange {
  let firstPage = 1;
  let lastPage = totalPages > 0 ? totalPages : maxPages;
  const match = pages?.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  if (match) {
    firstPage = parseInt(match[1], 10);
    lastPage = match[2] ? parseInt(match[2], 10) : firstPage;
    if (lastPage < firstPage) [firstPage, lastPage] = [lastPage, firstPage];
  }
  firstPage = Math.max(1, firstPage);
  if (totalPages > 0 && firstPage > totalPages) {
    return {
      ok: false,
      message: `This PDF has ${totalPages} page${totalPages === 1 ? '' : 's'}; requested pages="${pages}" start after the last page. `
        + `Use pages="1${totalPages > 1 ? `-${Math.min(totalPages, maxPages)}` : ''}".`,
    };
  }
  lastPage = Math.max(firstPage, Math.min(lastPage, firstPage + maxPages - 1));
  if (totalPages > 0) lastPage = Math.min(lastPage, totalPages);
  return { ok: true, firstPage, lastPage };
}

/* 文本层判定阈值: 平均每页 ≥ 该字符数才算有文本层 (扫描版 pdftotext 只吐空白/换页符) */
const PDF_TEXT_LAYER_MIN_CHARS_PER_PAGE = 30;
/* 文本通道单次默认最多读的页数 — 文本页便宜, 上限可以比图片通道 (20) 宽 */
export const PDF_MAX_PAGES_PER_TEXT_READ = 60;

/**
 * 提取 PDF 文本层 (pdftotext) — readfile 的 PDF **文本通道**。
 *
 * 图片通道 (readPdfAsImages) 只有视觉模型能消费; 绝大多数 PDF 有文本层,
 * 文本通道对所有模型可用且 token 便宜一个数量级。扫描版无文本层 →
 * hasTextLayer=false, 调用方回退图片通道。
 */
export async function extractPdfText(
  filePath: string,
  options?: { pages?: string },
): Promise<PdfTextResult> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);
  const fail = (error: string): PdfTextResult =>
    ({ valid: false, hasTextLayer: false, text: '', totalPages: 0, firstPage: 0, lastPage: 0, error });

  const buffer = await fs.readFile(filePath, { flag: 'r' });
  if (!buffer.subarray(0, 5).equals(PDF_MAGIC)) {
    return fail('Not a valid PDF file (missing %PDF- header)');
  }

  try {
    await execAsync('pdftotext -v 2>&1');
  } catch {
    return fail('pdftotext not installed. Install poppler-utils: brew install poppler (macOS) or apt install poppler-utils (Linux)');
  }

  const totalPages = await getPdfPageCount(filePath);
  const range = resolvePdfPageRange(options?.pages, totalPages, PDF_MAX_PAGES_PER_TEXT_READ);
  if (!range.ok) return { ...fail(range.message), totalPages, pageRangeOutOfBounds: true };
  const { firstPage, lastPage } = range;

  try {
    /* Natural reading order avoids the whitespace that -layout adds for visual
     * alignment and keeps the extracted text compact for model input. */
    const { stdout } = await execAsync(
      `pdftotext -f ${firstPage} -l ${lastPage} "${filePath}" - 2>/dev/null`,
      { timeout: 60000, maxBuffer: 32 * 1024 * 1024 },
    );
    const text = stdout
      .replace(/[ \t]+$/gm, '')
      .replace(/\f/g, '\n\n──── (下一页) ────\n\n')
      .trim();
    const pagesRead = Math.max(1, lastPage - firstPage + 1);
    const hasTextLayer = text.replace(/[\s─()下一页]/g, '').length >= PDF_TEXT_LAYER_MIN_CHARS_PER_PAGE * pagesRead * 0.3;
    return { valid: true, hasTextLayer, text, totalPages, firstPage, lastPage };
  } catch (err: any) {
    return fail(`pdftotext failed: ${err.message}`);
  }
}

export async function readPdfAsImages(
  filePath: string,
  options?: { pages?: string; dpi?: number },
): Promise<PdfReadResult> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);
  const os = await import('os');

  // 验证文件
  const buffer = await fs.readFile(filePath, { flag: 'r' });
  if (!buffer.subarray(0, 5).equals(PDF_MAGIC)) {
    return { pages: [], totalPages: 0, valid: false, error: 'Not a valid PDF file (missing %PDF- header)' };
  }

  const fileSizeMB = buffer.length / (1024 * 1024);
  if (fileSizeMB > 100) {
    return { pages: [], totalPages: 0, valid: false, error: `PDF too large: ${fileSizeMB.toFixed(1)}MB (max 100MB)` };
  }

  // 检查 pdftoppm 是否可用
  try {
    await execAsync('pdftoppm -v 2>&1');
  } catch {
    // pdftoppm 不���用 �� 尝试将 PDF 作为���档返回
    return { pages: [], totalPages: 0, valid: false, error: 'pdftoppm not installed. Install poppler-utils: brew install poppler (macOS) or apt install poppler-utils (Linux)' };
  }

  // 获取总页数 + 解析页面范围 (与文本通道同一个解析器, 见 resolvePdfPageRange)
  const totalPages = await getPdfPageCount(filePath);
  const range = resolvePdfPageRange(options?.pages, totalPages, PDF_MAX_PAGES_PER_READ);
  if (!range.ok) {
    return { pages: [], totalPages, valid: false, error: range.message, pageRangeOutOfBounds: true };
  }
  const { firstPage, lastPage } = range;

  // 转换为 JPEG
  const tmpDir = path.join(os.tmpdir(), `neox-pdf-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  const dpi = options?.dpi ?? 100;

  try {
    await execAsync(
      `pdftoppm -jpeg -r ${dpi} -f ${firstPage} -l ${lastPage} "${filePath}" "${tmpDir}/page"`,
      { timeout: 60000 },
    );

    // 读取输出图片
    const files = (await fs.readdir(tmpDir))
      .filter(f => f.endsWith('.jpg'))
      .sort();

    const pages: PdfReadResult['pages'] = [];
    for (let i = 0; i < files.length; i++) {
      const imgPath = path.join(tmpDir, files[i]);
      const imgBuffer = await fs.readFile(imgPath);
      let base64 = imgBuffer.toString('base64');
      let mediaType = 'image/jpeg';

      // 每页同样过附件预算漏斗(~1.2MB): 20 页 × 数百 KB base64 会轻松
      // 累积数 MB 沉进历史, 此前这条路径没有任何入口压缩。
      const funneled = await compressImageDataUrlIfNeeded(`data:image/jpeg;base64,${base64}`);
      if (funneled.compressed) {
        const m = funneled.url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s);
        if (m) { mediaType = m[1]; base64 = m[2]; }
      }

      // 检查大小
      if (base64.length > API_IMAGE_MAX_BASE64_SIZE) {
        continue; // 跳过过大的页面
      }

      pages.push({
        pageNumber: firstPage + i,
        base64,
        mediaType: mediaType as 'image/jpeg',
      });
    }

    return { pages, totalPages, valid: true };
  } catch (err: any) {
    return { pages: [], totalPages, valid: false, error: `PDF conversion failed: ${err.message}` };
  } finally {
    // 清理临时文件
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ============================================================================
// 工具结果格式
// ============================================================================

/**
 * Image content block 标记前缀
 * agentLoop 检测到这个前��时会解析为 image content block
 */
export const IMAGE_RESULT_PREFIX = '__NEOX_IMAGE_RESULT__';

/**
 * 构建图片工具结果 (序列���为特殊 JSON，agentLoop 解析)
 */
export function buildImageToolResult(images: Array<{
  base64: string;
  mediaType: string;
  label?: string;
}>, text?: string): string {
  return IMAGE_RESULT_PREFIX + JSON.stringify({
    type: 'image',
    images: images.map(img => ({
      data: img.base64,
      media_type: img.mediaType,
      label: img.label,
    })),
    ...(text ? { text } : {}),
  });
}
export function parseImageResultImages(raw: string): Array<{
  base64: string;
  mediaType: string;
  label?: string;
}> | null {
  if (typeof raw !== 'string' || !raw.startsWith(IMAGE_RESULT_PREFIX))
    return null;
  try {
    const parsed = JSON.parse(raw.slice(IMAGE_RESULT_PREFIX.length));
    if (!Array.isArray(parsed?.images))
      return null;
    const out = parsed.images
      .filter((img: any) => typeof img?.data === 'string' && img.data)
      .map((img: any) => ({
        base64: img.data,
        mediaType: typeof img.media_type === 'string' && img.media_type ? img.media_type : 'image/jpeg',
        ...(typeof img.label === 'string' && img.label ? { label: img.label } : {}),
      }));
    return out.length > 0 ? out : null;
  }
  catch {
    return null;
  }
}
