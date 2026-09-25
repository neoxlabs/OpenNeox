/**
 * writeMedia — 遍历 Presentation, 抽出所有图片的二进制 → 分配 pptx media 文件名 + rId.
 * PictureShape.src 支持: data:base64 (blob) / http(s):// URL / 已 resolved dataUrl.
 * Phase 1 只处理 data: URL — uri 类型跳过 (未来加下载器).
 */

import type { Presentation, Slide, PictureShape, Fill } from '../model/types.js';

export interface MediaEntry {
  /** 内部序号, 用于生成文件名 image1.png / image2.jpg */
  index: number;
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface SlideMediaRef {
  rid: string;
  media: MediaEntry;
}

export interface MediaExtractResult {
  /** 每张 slide 用到的 media refs (rId 相对 slide 唯一) */
  slides: SlideMediaRef[][];
  /** 全 pptx 里所有 media (去重, 每个只出现一次) */
  allMedia: MediaEntry[];
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};

export function extractMedia(model: Presentation): MediaExtractResult {
  const result: MediaExtractResult = { slides: [], allMedia: [] };
  const dedupeByBytes = new Map<string, MediaEntry>();
  let globalIdx = 0;

  for (const slide of model.slides) {
    const slideRefs: SlideMediaRef[] = [];
    /* rId1 保留给 slideLayout；图片关系从 rId2 开始，确保每个关系 ID 唯一。 */
    let ridCounter = 1;

    const collectFromShape = (shape: any): void => {
      if (!shape) return;
      /* PictureShape */
      if (shape.kind === 'picture' && shape.src) {
        const entry = ingestSrc(shape.src, dedupeByBytes, () => ++globalIdx);
        if (entry) {
          ridCounter++;
          const rid = `rId${ridCounter}`;
          slideRefs.push({ rid, media: entry });
        }
      }
      /* Background fill 也可能是图片 */
    };

    for (const shape of slide.shapes) collectFromShape(shape);
    /* background pic */
    if (slide.background && slide.background.kind === 'pic') {
      const entry = ingestSrc(slide.background.src, dedupeByBytes, () => ++globalIdx);
      if (entry) {
        ridCounter++;
        slideRefs.push({ rid: `rId${ridCounter}`, media: entry });
      }
    }

    result.slides.push(slideRefs);
  }

  result.allMedia = Array.from(dedupeByBytes.values());
  return result;
}

function ingestSrc(
  src: string,
  dedupe: Map<string, MediaEntry>,
  nextIdx: () => number,
): MediaEntry | null {
  /* 只处理 data: URL. http(s):// 暂时跳过 (未来 fetch 加进来). */
  if (!src.startsWith('data:')) return null;
  const m = /^data:([^;,]+)(?:;base64)?,(.*)$/.exec(src);
  if (!m) return null;
  const contentType = m[1];
  const b64 = m[2];
  /* dedupe key = base64 前 64 字符 (足够区分不同图, 全字符太贵) */
  const key = `${contentType}|${b64.slice(0, 64)}|${b64.length}`;
  const existing = dedupe.get(key);
  if (existing) return existing;

  const bytes = base64ToBytes(b64);
  const ext = EXT_BY_MIME[contentType] ?? 'bin';
  const idx = nextIdx();
  const entry: MediaEntry = {
    index: idx,
    fileName: `image${idx}.${ext}`,
    contentType,
    bytes,
  };
  dedupe.set(key, entry);
  return entry;
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

void ({} as Slide);
void ({} as PictureShape);
void ({} as Fill);
