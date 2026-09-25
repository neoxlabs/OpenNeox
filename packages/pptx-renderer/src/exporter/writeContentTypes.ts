/**
 * writeContentTypes — [Content_Types].xml
 * 声明每种部件的 MIME. 少一个 pptx 就打不开.
 */

import type { Presentation } from '../model/types.js';
import type { MediaExtractResult } from './writeMedia.js';
import { XML_DECL } from './ooxml/xml.js';

export function writeContentTypes(model: Presentation, media: MediaExtractResult): string {
  const parts: string[] = [];
  parts.push(XML_DECL);
  parts.push(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`);
  /* 默认扩展名 → MIME */
  parts.push(`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`);
  parts.push(`<Default Extension="xml" ContentType="application/xml"/>`);
  /* 图片扩展 */
  const extSeen = new Set<string>();
  for (const m of media.allMedia) {
    const ext = m.fileName.split('.').pop() ?? 'bin';
    if (extSeen.has(ext)) continue;
    extSeen.add(ext);
    parts.push(`<Default Extension="${ext}" ContentType="${m.contentType}"/>`);
  }
  /* Override — 每个部件明确 MIME */
  parts.push(`<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`);
  /* docProps/app.xml — 出处标记部件 (见 exporter/index.ts APP_PROPS_XML)。少这条 Override, Office 会判包损坏。 */
  parts.push(`<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>`);
  parts.push(`<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`);
  parts.push(`<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>`);
  parts.push(`<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`);
  for (let i = 0; i < model.slides.length; i++) {
    parts.push(`<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
  }
  parts.push(`</Types>`);
  return parts.join('');
}
