/**
 * exporter — Presentation → 真 .pptx zip bytes (isomorphic).
 *
 * 依赖 JSZip 反向组 zip. 生成的 .pptx 满足 Ecma-376 最小可读集,
 * 打开 PowerPoint / Keynote / WPS / LibreOffice 都能识别 + 二次编辑.
 *
 * 用法:
 *   const ppt = Presentation.create(...);
 *   ...
 *   const file = await exportPptx(ppt);
 *   await file.save('out.pptx');           // Node
 *   await file.blob();                     // Browser
 *   const bytes = await file.bytes();      // 拿裸 Uint8Array
 */

import JSZip from 'jszip';
import type { Presentation as PresentationModel, PictureShape } from '../model/types.js';
import { probeImageSize } from '../model/image-size.js';
import type { Presentation } from '../builder/index.js';
import {
  DEFAULT_THEME_COLORS, DEFAULT_MAJOR_FONT, DEFAULT_MINOR_FONT,
} from '../model/defaults.js';
import { writeContentTypes } from './writeContentTypes.js';
import { writePresentationXml, writePresentationRelsXml } from './writePresentation.js';
import { writeSlideXml, writeSlideRelsXml } from './writeSlide.js';
import { writeThemeXml } from './writeTheme.js';
import { writeMinimalLayoutXml, writeMinimalLayoutRelsXml } from './writeLayout.js';
import { writeMinimalMasterXml, writeMinimalMasterRelsXml } from './writeMaster.js';
import { extractMedia } from './writeMedia.js';

/** 出口: exportPptx(builder 侧的 Presentation) 或 直接传 model. */
export async function exportPptx(input: Presentation | { model: PresentationModel } | PresentationModel): Promise<PresentationFile> {
  const model: PresentationModel = 'model' in input ? input.model : (input as PresentationModel);

  const zip = new JSZip();

  /* 导出前把图片来源统一解析为 data URL。
   * 支持 HTTP、file URL、本地路径和 data URL；解析失败直接抛出，
   * 让调用方修正具体资源，而不是写入不可用的占位图片。 */
  await prefetchImageSources(model);
  applyCoverCrop(model);

  /* 1. 走 slide 抽出所有 image → media/imageN.ext, 建 slide→media map */
  const mediaByRid = extractMedia(model);
  /* mediaByRid.slides[i] = Array<{rid, mediaFile, contentType, bytes}> */

  /* 2. 写各类 XML */

  /* [Content_Types].xml — 声明所有部件的 MIME */
  zip.file('[Content_Types].xml', writeContentTypes(model, mediaByRid));

  /* _rels/.rels — 根 relationships */
  zip.file('_rels/.rels', ROOT_RELS_XML);

  /* docProps/app.xml — 出处标记 .
   * 唯一用途: 让下游能确定式回答"这份 pptx 是 Neox 引擎生成的, 还是用户自己拿进来的第三方文件".
   * 交付闸门 (inspect + open_surface) 只对**自己生成的**deck 强制"mustFix 必须为 0";
   * 用户拖进来的外部 deck 不该被我们的排版规则拦住不让看。没有这个标记就只能靠猜。 */
  zip.file('docProps/app.xml', APP_PROPS_XML);

  /* ppt/presentation.xml + ppt/_rels/presentation.xml.rels */
  zip.file('ppt/presentation.xml', writePresentationXml(model));
  zip.file('ppt/_rels/presentation.xml.rels', writePresentationRelsXml(model));

  /* ppt/theme/theme1.xml */
  const theme = model.theme ?? {
    colors: DEFAULT_THEME_COLORS,
    majorFont: DEFAULT_MAJOR_FONT,
    minorFont: DEFAULT_MINOR_FONT,
  };
  zip.file('ppt/theme/theme1.xml', writeThemeXml(theme));

  /* ppt/slideMasters/slideMaster1.xml + rels — 最小可用 master */
  zip.file('ppt/slideMasters/slideMaster1.xml', writeMinimalMasterXml());
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', writeMinimalMasterRelsXml());

  /* ppt/slideLayouts/slideLayout1.xml + rels — 最小可用 layout */
  zip.file('ppt/slideLayouts/slideLayout1.xml', writeMinimalLayoutXml());
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', writeMinimalLayoutRelsXml());

  /* ppt/slides/slideN.xml + rels — 每张 slide */
  for (let i = 0; i < model.slides.length; i++) {
    const slide = model.slides[i]!;
    const slideNum = i + 1;
    const mediaForSlide = mediaByRid.slides[i] ?? [];
    zip.file(
      `ppt/slides/slide${slideNum}.xml`,
      writeSlideXml(slide, mediaForSlide, { widthEmu: model.slideWidth, heightEmu: model.slideHeight }),
    );
    zip.file(
      `ppt/slides/_rels/slide${slideNum}.xml.rels`,
      writeSlideRelsXml(mediaForSlide),
    );
  }

  /* ppt/media/imageN.ext — 图片二进制 */
  for (const m of mediaByRid.allMedia) {
    zip.file(`ppt/media/${m.fileName}`, m.bytes);
  }

  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return new PresentationFile(bytes);
}

/** _rels/.rels — 根 relationships, 声明主文档是 ppt/presentation.xml + 扩展属性 docProps/app.xml. */
const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

/** 生成器标识 —— 下游 (inspect / 交付闸门) 按这个字符串判定 deck 出处。改这里要同步改 inspectSlides.mjs。 */
export const NEOX_PPTX_GENERATOR = 'Neox Slides Engine';

/** docProps/app.xml — 标准 OOXML 扩展属性部件, PowerPoint/Keynote/WPS 都认 (显示在"属性"里)。 */
const APP_PROPS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>${NEOX_PPTX_GENERATOR}</Application>
</Properties>`;

/**
 * prefetchImageSources 在导出前遍历所有图片，将 HTTP、本地路径和 file URL
 * 内联为 data URL；data URL 保持不变。所有资源错误都会在导出前统一报告。
 */
/**
 * applyCoverCrop 为 objectFit=cover 且尚未提供 srcRect 的图片计算居中裁剪。
 * 它在资源预取后运行，因此本地路径、HTTP 和 data URL 都能通过统一的 data URL
 * 尺寸探测；调用方已提供的裁剪参数保持不变。
 */
function applyCoverCrop(model: PresentationModel): void {
  for (const slide of model.slides) {
    for (const shape of slide.shapes) {
      if (shape.kind !== 'picture') continue;
      const pic = shape as PictureShape;
      if (pic.objectFit !== 'cover' || pic.srcRect) continue;
      const dims = probeImageSize(pic.src);
      if (!dims?.width || !dims?.height) continue;
      const fw = pic.frame.w, fh = pic.frame.h;
      if (!fw || !fh) continue;
      const imgAR = dims.width / dims.height;
      const boxAR = fw / fh;
      if (Math.abs(imgAR - boxAR) < 0.001) continue;
      if (imgAR > boxAR) {
        const cut = (1 - boxAR / imgAR) / 2;   /* 图比框宽 → 裁左右 */
        pic.srcRect = { l: cut, t: 0, r: cut, b: 0 };
      } else {
        const cut = (1 - imgAR / boxAR) / 2;   /* 图比框高 → 裁上下 */
        pic.srcRect = { l: 0, t: cut, r: 0, b: cut };
      }
    }
  }
}

async function prefetchImageSources(model: PresentationModel): Promise<void> {
  if (typeof fetch === 'undefined') {
    throw new Error('exportPptx: global fetch unavailable · 请用 Node 18+ 或浏览器运行时');
  }

  const cache = new Map<string, string>(); /* src → dataUrl */
  const pending = new Map<string, Promise<string>>();
  const errors: Array<{ src: string; reason: string }> = [];

  const contentTypeFromExt = (p: string): string => {
    const ext = (p.split('.').pop() || '').toLowerCase();
    switch (ext) {
      case 'png': return 'image/png';
      case 'jpg':
      case 'jpeg': return 'image/jpeg';
      case 'gif': return 'image/gif';
      case 'webp': return 'image/webp';
      case 'bmp': return 'image/bmp';
      case 'svg': return 'image/svg+xml';
      case 'tiff':
      case 'tif': return 'image/tiff';
      default: return 'application/octet-stream';
    }
  };

  const bytesToDataUrl = (bytes: Uint8Array, contentType: string): string => {
    let b64: string;
    if (typeof Buffer !== 'undefined') {
      b64 = Buffer.from(bytes).toString('base64');
    } else {
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
      b64 = btoa(s);
    }
    return `data:${contentType};base64,${b64}`;
  };

  const doHttp = async (url: string): Promise<string> => {
    let lastErr: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 2000 - 1000));
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 30000);
        const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Neox/1.0' } });
        clearTimeout(t);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const contentType = res.headers.get('content-type') || contentTypeFromExt(url);
        const buf = await res.arrayBuffer();
        if (buf.byteLength < 1024 || buf.byteLength > 20 * 1024 * 1024) {
          throw new Error(`size out of range: ${buf.byteLength}B`);
        }
        return bytesToDataUrl(new Uint8Array(buf), contentType);
      } catch (err: any) {
        lastErr = err;
        const msg = err?.message || String(err);
        if (/HTTP 4\d\d|size out of range/.test(msg)) break;
      }
    }
    throw lastErr ?? new Error('unknown fetch error');
  };

  const doLocalFile = async (rawPath: string): Promise<string> => {
    /* file:// URL 剥前缀 (跨平台 · Windows file:///C:/... 也认) */
    let path = rawPath;
    if (path.startsWith('file://')) path = decodeURIComponent(path.slice(7).replace(/^\/(?=[A-Z]:)/, ''));
    if (typeof process === 'undefined' || !(process as any).versions?.node) {
      throw new Error('browser runtime · 本地 path 不能读, 请传 blob/dataUrl/http URL');
    }
    const fs = await import('node:fs/promises');
    const bytes = await fs.readFile(path);
    if (bytes.byteLength < 512 || bytes.byteLength > 20 * 1024 * 1024) {
      throw new Error(`size out of range: ${bytes.byteLength}B`);
    }
    return bytesToDataUrl(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), contentTypeFromExt(path));
  };

  const resolve = async (src: string): Promise<string> => {
    if (cache.has(src)) return cache.get(src)!;
    let inflight = pending.get(src);
    if (inflight) return inflight;
    const isHttp = /^https?:\/\//i.test(src);
    const isFileUrl = /^file:\/\//i.test(src);
    const isPosixAbs = src.startsWith('/');
    const isWinAbs = /^[A-Za-z]:[\\/]/.test(src);
    inflight = (async () => {
      const dataUrl = isHttp ? await doHttp(src)
        : (isFileUrl || isPosixAbs || isWinAbs) ? await doLocalFile(src)
        : (() => { throw new Error(`unsupported src scheme (want http/https/file:// or absolute path): ${src.slice(0, 80)}`); })();
      cache.set(src, dataUrl);
      return dataUrl;
    })();
    pending.set(src, inflight);
    try {
      return await inflight;
    } finally {
      pending.delete(src);
    }
  };

  /* 扫全 model 收待处理 src (跳过已 data URL 的). */
  const jobs: Promise<void>[] = [];
  for (let si = 0; si < model.slides.length; si++) {
    const slide = model.slides[si]!;
    for (const shape of slide.shapes) {
      if (shape.kind !== 'picture' || typeof shape.src !== 'string') continue;
      const src = shape.src;
      if (src.startsWith('data:')) continue; /* 已是 data URL, 保持原样 */
      const slideNo = si + 1;
      jobs.push((async () => {
        try {
          const dataUrl = await resolve(src);
          shape.src = dataUrl;
        } catch (err: any) {
          errors.push({ src, reason: `slide ${slideNo}: ${err?.message || String(err)}` });
        }
      })());
    }
  }
  await Promise.all(jobs);

  if (errors.length > 0) {
    const detail = errors.map((e, i) => `  ${i + 1}. ${e.reason} — ${e.src}`).join('\n');
    throw new Error(
      `exportPptx: ${errors.length} 张图片处理失败, 修图 src 后重试:\n${detail}`,
    );
  }
}

/** PresentationFile — export 结果的 handle. save / blob / bytes 三条路. */
export class PresentationFile {
  constructor(private _bytes: Uint8Array) {}

  /** Node: 落磁盘. Browser: 抛 (无 fs) — 用 blob() 代替. */
  async save(filePath: string): Promise<void> {
    if (typeof process === 'undefined' || typeof (process as any).versions?.node === 'undefined') {
      throw new Error('save() 只能在 Node 里用. Browser 请用 blob() 或 bytes()');
    }
    const fs = await import('node:fs/promises');
    await fs.writeFile(filePath, this._bytes);
  }

  /** Browser 侧拿 Blob 直接下载 / 传输. */
  blob(): Blob {
    /* TS lib.dom 的 BlobPart 类型对 Uint8Array<ArrayBufferLike> 挑, 用 any 绕 (运行时无差别) */
    return new Blob([this._bytes as any], {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
  }

  /** 裸 Uint8Array. */
  bytes(): Uint8Array {
    return this._bytes;
  }
}
