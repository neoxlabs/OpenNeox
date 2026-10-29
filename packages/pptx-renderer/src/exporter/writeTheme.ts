/**
 * writeTheme — ppt/theme/theme1.xml
 * 最小完整 theme: 12 色 slot + 主副字体. PowerPoint 缺 theme 会拒绝打开.
 */

import type { Theme } from '../model/types.js';
import { XML_DECL, hexNoHash } from './ooxml/xml.js';
import { DEFAULT_THEME_COLORS, DEFAULT_MAJOR_FONT, DEFAULT_MINOR_FONT } from '../model/defaults.js';

const SLOT_ORDER = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];

export function writeThemeXml(theme: Theme): string {
  const colors = { ...DEFAULT_THEME_COLORS, ...(theme.colors ?? {}) };
  const majorFont = theme.majorFont || DEFAULT_MAJOR_FONT;
  const minorFont = theme.minorFont || DEFAULT_MINOR_FONT;

  const clrSlots = SLOT_ORDER.map((slot) => {
    /* dk1/lt1 用 sysClr, 其它 srgbClr */
    if (slot === 'dk1') return `<a:${slot}><a:sysClr val="windowText" lastClr="${hexNoHash(colors[slot])}"/></a:${slot}>`;
    if (slot === 'lt1') return `<a:${slot}><a:sysClr val="window" lastClr="${hexNoHash(colors[slot])}"/></a:${slot}>`;
    return `<a:${slot}><a:srgbClr val="${hexNoHash(colors[slot])}"/></a:${slot}>`;
  }).join('');

  return `${XML_DECL}
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Neox">
  <a:themeElements>
    <a:clrScheme name="Neox">${clrSlots}</a:clrScheme>
    <a:fontScheme name="Neox">
      <a:majorFont>
        <a:latin typeface="${majorFont}"/>
        <a:ea typeface="${majorFont}"/>
        <a:cs typeface=""/>
      </a:majorFont>
      <a:minorFont>
        <a:latin typeface="${minorFont}"/>
        <a:ea typeface="${minorFont}"/>
        <a:cs typeface=""/>
      </a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="Neox">
      <a:fillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:fillStyleLst>
      <a:lnStyleLst>
        <a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
        <a:ln w="25400" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
        <a:ln w="38100" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
      </a:lnStyleLst>
      <a:effectStyleLst>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
      </a:effectStyleLst>
      <a:bgFillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
</a:theme>`;
}
