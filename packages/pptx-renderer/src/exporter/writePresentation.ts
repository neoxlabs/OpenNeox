/**
 * writePresentation — ppt/presentation.xml + ppt/_rels/presentation.xml.rels
 */

import type { Presentation } from '../model/types.js';
import { XML_DECL } from './ooxml/xml.js';

export function writePresentationXml(model: Presentation): string {
  const cx = model.slideWidth;
  const cy = model.slideHeight;
  const sldIdParts: string[] = [];
  /* slide id 从 256 开始 (OOXML 规范 min value) */
  for (let i = 0; i < model.slides.length; i++) {
    const id = 256 + i;
    const rId = `rId${i + 2}`; /* rId1 保留给 slideMaster */
    sldIdParts.push(`<p:sldId id="${id}" r:id="${rId}"/>`);
  }

  return `${XML_DECL}
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:sldIdLst>${sldIdParts.join('')}</p:sldIdLst>
  <p:sldSz cx="${cx}" cy="${cy}" type="screen16x9"/>
  <p:notesSz cx="${cy}" cy="${cx}"/>
  <p:defaultTextStyle/>
</p:presentation>`;
}

export function writePresentationRelsXml(model: Presentation): string {
  const parts: string[] = [];
  parts.push(XML_DECL);
  parts.push(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`);
  /* rId1: slideMaster1 */
  parts.push(`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>`);
  /* rId2..N+1: 每个 slide */
  for (let i = 0; i < model.slides.length; i++) {
    parts.push(`<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`);
  }
  /* 最后: theme */
  const themeRid = model.slides.length + 2;
  parts.push(`<Relationship Id="rId${themeRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>`);
  parts.push(`</Relationships>`);
  return parts.join('');
}
