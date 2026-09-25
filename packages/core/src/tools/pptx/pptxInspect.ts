
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { measureText } from '@neoxlabs/pptx-compose';

export interface PptxInspectIssue {
  slide?: number;
  severity: 'error' | 'warn';
  kind: string;
  message: string;
  shape?: { id: string | null; name: string | null; rect: Rect };
}

export interface PptxInspectReport {
  ok: boolean;
  engine: 'precise-font-metrics';
  /** true = 本文件由 Neox slides 引擎生成 (交付闸门对它强制 mustFixCount=0)。 */
  neoxGenerated: boolean;
  pptxPath?: string;
  slideCount: number;
  slideSize: { cx: number; cy: number };
  errors: number;
  warnings: number;
  mustFixCount: number;
  /** mustFix 排在前面 */
  issues: PptxInspectIssue[];
}

interface Rect { x: number; y: number; cx: number; cy: number }

interface ShapeInfo {
  id: string | null;
  name: string | null;
  kind: 'picture' | 'shape';
  rect: Rect;
  text: string;
  textLen: number;
  maxFontPt: number | null;
  latinFont: string | null;
  eaFont: string | null;
  isBold: boolean;
  letterSpacingPt: number;
  lineHeightPt: number | null;
  hasRuns: boolean;
  isContent: boolean;
}

type SlideKind = 'hero' | 'text-heavy' | 'image' | 'divider' | 'graphic' | 'unknown';

const EMU_PER_PX = 9525;

/** mustFix = errors + 硬性规则违规。跟 pptx-deck-writer 技能的硬性规则一一对应。 */
const MUST_FIX_KINDS = new Set([
  'out-of-bounds', 'zero-size', 'text-overlap', 'text-overflow-estimated',
  'edge-overflow', 'title-font-too-small', 'body-font-too-small',
  'title-wraps-multi-line',
]);

export async function inspectPptxFile(pptxPath: string): Promise<PptxInspectReport> {
  const buf = await readFile(pptxPath);
  return inspectPptxBytes(buf, { pptxPath });
}

/**
 * 结构级检查。pptx 结构损坏 (缺 presentation.xml / sldSz) 直接抛 —— 不给默认值兜底。
 */
export async function inspectPptxBytes(
  bytes: Uint8Array,
  opts: { pptxPath?: string } = {},
): Promise<PptxInspectReport> {
  const zip = await JSZip.loadAsync(bytes);

  const slideFiles = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNo(a) - slideNo(b));

  const presFile = zip.file('ppt/presentation.xml');
  if (!presFile) throw new Error('pptx 结构损坏: 缺 ppt/presentation.xml');
  const presXml = await presFile.async('string');
  const szMatch = presXml.match(/<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
  if (!szMatch) throw new Error('pptx 结构损坏: presentation.xml 缺 <p:sldSz cx cy>');
  const sldW = parseInt(szMatch[1]!, 10);
  const sldH = parseInt(szMatch[2]!, 10);

  const issues: PptxInspectIssue[] = [];
  const slideTypes: SlideKind[] = [];
  for (let i = 0; i < slideFiles.length; i++) {
    const slideXml = await zip.file(slideFiles[i]!)!.async('string');
    const shapes = extractShapes(slideXml);
    /* 第 1 页是封面, 标题字号门限用 hero (>=50pt); 其余页用 h1 (>=35pt) */
    checkSlide(i + 1, shapes, sldW, sldH, issues, i === 0);
    slideTypes.push(classifySlideType(slideXml, shapes, i === 0));
  }
  runDeckDiversityChecks(slideTypes, issues);

  const mustFix = issues.filter((x) => x.severity === 'error' || MUST_FIX_KINDS.has(x.kind));

  /* 出处: docProps/app.xml 的 <Application> 是 Neox 引擎自己写的标记
   * (neox-pptx-renderer exporter 的 NEOX_PPTX_GENERATOR)。缺了就是外部文件, 如实标 false, 不猜。 */
  let neoxGenerated = false;
  const appFile = zip.file('docProps/app.xml');
  if (appFile) {
    const appXml = await appFile.async('string');
    neoxGenerated = /<Application>\s*Neox Slides Engine\s*<\/Application>/.test(appXml);
  }

  return {
    ok: mustFix.length === 0,
    engine: 'precise-font-metrics',
    neoxGenerated,
    ...(opts.pptxPath ? { pptxPath: opts.pptxPath } : {}),
    slideCount: slideFiles.length,
    slideSize: { cx: sldW, cy: sldH },
    errors: issues.filter((x) => x.severity === 'error').length,
    warnings: issues.filter((x) => x.severity === 'warn').length,
    mustFixCount: mustFix.length,
    issues: [...mustFix, ...issues.filter((x) => !mustFix.includes(x))],
  };
}

/** 该 issue 是否属于必须修的 (交付闸门按它拦) */
export function isMustFix(issue: PptxInspectIssue): boolean {
  return issue.severity === 'error' || MUST_FIX_KINDS.has(issue.kind);
}

function slideNo(name: string): number {
  return parseInt(name.match(/slide(\d+)\.xml/)![1]!, 10);
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

function extractShapes(xml: string): ShapeInfo[] {
  const shapes: ShapeInfo[] = [];
  const spRe = /<p:sp\b[\s\S]*?<\/p:sp>|<p:pic\b[\s\S]*?<\/p:pic>/g;
  let m: RegExpExecArray | null;
  while ((m = spRe.exec(xml)) != null) {
    const chunk = m[0];
    const kind = chunk.startsWith('<p:pic') ? 'picture' : 'shape';
    const off = chunk.match(/<a:off[^>]*x="(-?\d+)"[^>]*y="(-?\d+)"/);
    const ext = chunk.match(/<a:ext[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
    if (!off || !ext) continue;
    /* 逐段落抽文本 (段落间是真实换行 —— 精准测量要按 \n 分行) */
    const paraChunks = chunk.match(/<a:p\b[\s\S]*?<\/a:p>/g) ?? [];
    const paraTexts = paraChunks.map((p) =>
      [...p.matchAll(/<a:r\b[\s\S]*?<a:t>([\s\S]*?)<\/a:t>/g)].map((r) => decodeXml(r[1]!)).join(''));
    const text = paraTexts.filter((t) => t.length > 0).join('\n');
    const szMatches = [...chunk.matchAll(/<a:rPr[^>]*\bsz="(\d+)"/g)].map((r) => parseInt(r[1]!, 10));
    /* 字距 spc (1/100 pt) —— 不带上它, 精准复测会比 measure 时宽/窄, 误报折行 */
    const spcMatch = chunk.match(/<a:rPr[^>]*\bspc="(-?\d+)"/);
    const lnSpcMatch = chunk.match(/<a:lnSpc><a:spcPts val="(\d+)"\/><\/a:lnSpc>/);
    const nv = chunk.match(/<p:cNvPr\s+id="(\d+)"\s+name="([^"]+)"/);
    /* 是不是内容承载体: writeSlide 给每个 shape 都带 <p:txBody> (哪怕空占位), 所以看有没有 <a:r> run。
     * 装饰几何只有 endParaRPr 没有 run, isContent=false, 允许出血。 */
    const hasRuns = /<a:r\b/.test(chunk);
    shapes.push({
      id: nv ? nv[1]! : null,
      name: nv ? nv[2]! : null,
      kind,
      rect: {
        x: parseInt(off[1]!, 10), y: parseInt(off[2]!, 10),
        cx: parseInt(ext[1]!, 10), cy: parseInt(ext[2]!, 10),
      },
      text,
      textLen: text.length,
      maxFontPt: szMatches.length ? Math.max(...szMatches) / 100 : null,
      latinFont: chunk.match(/<a:latin typeface="([^"]+)"/)?.[1] ?? null,
      eaFont: chunk.match(/<a:ea typeface="([^"]+)"/)?.[1] ?? null,
      isBold: /<a:rPr[^>]*\bb="1"/.test(chunk),
      letterSpacingPt: spcMatch ? parseInt(spcMatch[1]!, 10) / 100 : 0,
      lineHeightPt: lnSpcMatch ? parseInt(lnSpcMatch[1]!, 10) / 100 : null,
      hasRuns,
      isContent: kind === 'picture' || hasRuns,
    });
  }
  return shapes;
}

/** 被引号包住的文本是引言, 不是标题 —— 中英文引号都认 */
function isQuoted(text: string): boolean {
  const t = String(text ?? '').trim();
  if (t.length < 2) return false;
  const OPEN = '"“‘「『«';
  const CLOSE = '"”’」』»';
  return OPEN.includes(t[0]!) && CLOSE.includes(t[t.length - 1]!);
}

function checkSlide(
  slideNo: number, shapes: ShapeInfo[], sldW: number, sldH: number,
  out: PptxInspectIssue[], isCover: boolean,
): void {
  const push = (severity: 'error' | 'warn', kind: string, message: string, shape?: ShapeInfo) => out.push({
    slide: slideNo, severity, kind, message,
    shape: shape ? { id: shape.id, name: shape.name, rect: shape.rect } : undefined,
  });

  if (shapes.length === 0) {
    push('warn', 'empty-slide', 'slide has 0 shapes');
    return;
  }

  /* 槽位文本是纯文本, 引擎不解析 markdown —— **强调** 会被原样画上去。出声让调用方改, 不替它剥。
   * 扫全部文本形状: 放在 contentShapes 里时页脚附近的 note 被过滤掉, 守卫一次都没触发过。 */
  for (const s of shapes) {
    if (!s.hasRuns) continue;
    if (/\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|(?:^|\s)#{1,6}\s/.test(s.text ?? '')) {
      push('warn', 'literal-markdown-in-text',
        `文本里的 markdown 记号会被原样画出来: "${String(s.text).slice(0, 30)}" —— 槽位是纯文本, 去掉 ** 和 []() 记号`,
        s);
    }
  }

  /* 字号下限: 封面 hero title ≥50pt, 其余页 h1 ≥35pt, 正文 ≥16pt。按字号分桶 (shape 名都叫 TextBox N)。 */
  const textShapes = shapes.filter((s) => s.hasRuns && s.textLen > 0 && s.maxFontPt != null);
  /* 页脚: 外部 pptx 看名字关键词, 自家的看位置 (底部 16% 且短文本) */
  const isFooterlike = (s: ShapeInfo) =>
    /(footer|page|number|attribution|caption|kicker)/i.test(s.name || '')
    || (s.rect.y > sldH * 0.84 && s.textLen <= 40);
  const contentShapes = textShapes.filter((s) => !isFooterlike(s));

  if (contentShapes.length > 0) {
    const heroShape = contentShapes.reduce((max, s) => (s.maxFontPt! > max.maxFontPt! ? s : max), contentShapes[0]!);
    const heroPt = heroShape.maxFontPt!;
    /* 引言页 (heroImageQuote / manifesto) 最大字号的是引言不是标题, 不套 h1 门限 */
    const looksLikePullQuote =
      (heroShape.textLen > 25 && contentShapes.length <= 3) || isQuoted(heroShape.text);

    if (isCover) {
      if (heroPt < 50 && !looksLikePullQuote) {
        push('warn', 'title-font-too-small',
          `cover hero title uses ${heroPt}pt (< 50pt floor for deck titles); shorten text or increase font`, heroShape);
      }
    } else if (heroPt < 35 && !looksLikePullQuote) {
      push('warn', 'title-font-too-small', `slide title uses ${heroPt}pt (< 35pt floor for slide titles)`, heroShape);
    }

    /* 正文下限按文字量估角色: <10 字 tag 10pt / 10-25 字 label 14pt / >25 字 body 16pt */
    for (const s of contentShapes) {
      if (s === heroShape) continue;
      let floor: number; let role: string;
      if (s.textLen < 10) { floor = 10; role = 'tag'; }
      else if (s.textLen <= 25) { floor = 14; role = 'label'; }
      else { floor = 16; role = 'body'; }
      if (s.maxFontPt! < floor) {
        push('warn', 'body-font-too-small',
          `${role} text "${s.name}" (${s.textLen} chars) uses ${s.maxFontPt}pt (< ${floor}pt floor); shorten content or use bulletList`,
          s);
      }
    }
  }

  /* 标题必须一行: 真实字体 advance 算单行宽, 跟框宽比 —— 事实判定 */
  for (const s of contentShapes) {
    if (s.maxFontPt == null || s.maxFontPt < 30) continue;
    if (s.textLen > 24) continue;                         /* 引言/段落, 不属于"必须一行" */
    if (s.maxFontPt >= 60 && s.textLen > 12) continue;    /* manifesto 类巨字允许折行 */
    if (s.text.includes('\n')) continue;
    if (isQuoted(s.text)) continue;
    const widthPx = s.rect.cx / EMU_PER_PX;
    const m = measureText(s.text, s.maxFontPt, Infinity, {
      singleLine: true, bold: s.isBold,
      fontLatin: s.latinFont ?? undefined, fontEast: s.eaFont ?? undefined,
      letterSpacingPt: s.letterSpacingPt || undefined,
    });
    if (m.width > widthPx) {
      push('warn', 'title-wraps-multi-line',
        `title-sized shape "${s.name}" (${s.maxFontPt}pt, ${s.textLen} chars) will wrap to 2+ lines; MUST shorten text (never shrink font)`,
        s);
    }
  }

  for (const s of shapes) {
    const r = s.rect;
    /* 越界只判内容承载体; 装饰几何故意出血。容忍 100pt, 小于它的算 edge-overflow */
    const TOL = 1270000;
    if (s.isContent && (r.x < -TOL || r.y < -TOL || r.x + r.cx > sldW + TOL || r.y + r.cy > sldH + TOL)) {
      push('error', 'out-of-bounds',
        `content shape "${s.name}" (${s.kind}) outside slide: rect=(${r.x},${r.y},${r.cx},${r.cy}) slide=(${sldW},${sldH})`, s);
    } else if (s.isContent && (r.x < 0 || r.y < 0 || r.x + r.cx > sldW || r.y + r.cy > sldH)) {
      push('warn', 'edge-overflow', `content shape "${s.name}" slightly outside slide edge (<100pt)`, s);
    }
    if (r.cx <= 0 || r.cy <= 0) {
      push('error', 'zero-size', `shape "${s.name}" has non-positive size`, s);
    }
    if (s.hasRuns && s.textLen === 0 && s.name
      && !/(divider|bar|line|bg|background|footer|accent|placeholder)/i.test(s.name)) {
      push('warn', 'empty-text', `text shape "${s.name}" is empty (unfilled slot?)`, s);
    }
    if (s.maxFontPt != null) {
      if (s.maxFontPt < 9) push('warn', 'font-too-small', `shape "${s.name}" uses ${s.maxFontPt}pt (<9pt hard to read)`, s);
      /* 章节页大号数字到 160pt 是设计意图 */
      if (s.maxFontPt > 200) push('warn', 'font-too-large', `shape "${s.name}" uses ${s.maxFontPt}pt (>200pt likely mistake)`, s);
    }
    /* 文本溢出: 真实字体断行 × XML 里钉死的行高, 跟框高比, 超 2px 就报 */
    if (s.textLen > 0 && s.maxFontPt != null) {
      const m = measureText(s.text, s.maxFontPt, r.cx / EMU_PER_PX, {
        bold: s.isBold,
        fontLatin: s.latinFont ?? undefined,
        fontEast: s.eaFont ?? undefined,
        letterSpacingPt: s.letterSpacingPt || undefined,
        lineHeightPt: s.lineHeightPt ?? undefined,
      });
      const heightPx = r.cy / EMU_PER_PX;
      if (m.height > heightPx + 2) {
        push('warn', 'text-overflow-estimated',
          `shape "${s.name}" needs ${Math.ceil(m.height)}px (${m.lines} lines × ${m.lineHeightPt}pt) but box is ${Math.round(heightPx)}px; trim content or enlarge box`,
          s);
      }
    }
  }

  /* 文本框两两重叠 (装饰几何不算) */
  for (let a = 0; a < textShapes.length; a++) {
    for (let b = a + 1; b < textShapes.length; b++) {
      const A = textShapes[a]!.rect; const B = textShapes[b]!.rect;
      const ix = Math.max(0, Math.min(A.x + A.cx, B.x + B.cx) - Math.max(A.x, B.x));
      const iy = Math.max(0, Math.min(A.y + A.cy, B.y + B.cy) - Math.max(A.y, B.y));
      const inter = ix * iy;
      if (inter <= 0) continue;
      const iou = inter / Math.min(A.cx * A.cy, B.cx * B.cy);
      if (iou > 0.3) {
        push('warn', 'text-overlap',
          `text shapes "${textShapes[a]!.name}" and "${textShapes[b]!.name}" overlap by ${Math.round(iou * 100)}%`,
          textShapes[a]);
      }
    }
  }
}

/* 页型 → 视觉类别。生成时把模板 id 写进了 <p:cSld name>, 直接查表, 不猜。 */
const TEMPLATE_KIND: Record<string, SlideKind> = {
  'cover-hero': 'hero', 'section-divider': 'divider', 'agenda': 'divider',
  'hero-image-quote': 'hero', 'manifesto': 'hero', 'quote-page': 'hero',
  'data-focus': 'hero', 'numbers-hero': 'hero',
  'image-gallery': 'image', 'photo-spread': 'image',
  /* 满页矢量图形 —— "看的页", 不是"读的页" */
  'process-flow': 'graphic', 'versus-page': 'graphic', 'hierarchy-page': 'graphic',
  'funnel-page': 'graphic', 'orbit-page': 'graphic', 'feature-grid': 'graphic',
  'kpi-cards': 'graphic', 'chart-focus': 'graphic', 'timeline': 'graphic',
  'contrast': 'graphic',
  'title-body': 'text-heavy', 'bullet-list': 'text-heavy', 'two-column': 'text-heavy',
  'three-column': 'text-heavy', 'data-table': 'text-heavy', 'editorial-split': 'text-heavy',
};

function classifySlideType(xml: string, shapes: ShapeInfo[], isCover: boolean): SlideKind {
  const m = /<p:cSld\s+name="([^"]*)"/.exec(xml);
  const known = m ? TEMPLATE_KIND[m[1]!] : undefined;
  if (known) return known;

  /* 外部 pptx / 老文件没有模板标记, 才走启发式 */
  if (isCover) return 'hero';
  const pictures = shapes.filter((s) => s.kind === 'picture');
  const textShapes = shapes.filter((s) => s.hasRuns);
  const bigText = shapes.some((s) => s.hasRuns && s.maxFontPt != null && s.maxFontPt >= 50);
  const bgDark = /<a:srgbClr val="(0F|1D|1E|22|33|46|4A|66)/i.test(xml.slice(0, 3000));
  if (bgDark && bigText && textShapes.length <= 4) return 'divider';
  if (bigText && textShapes.length <= 3 && !pictures.length) return 'hero';
  if (pictures.length >= 1) return 'image';
  if (textShapes.length > 3) return 'text-heavy';
  return 'unknown';
}

/** deck 级视觉节奏 */
function runDeckDiversityChecks(types: SlideKind[], out: PptxInspectIssue[]): void {
  const total = types.length;
  if (total < 3) return;

  /* 1. 连续 3 张 text-heavy (graphic 页算呼吸) */
  let streakType = types[0];
  let streakStart = 0;
  for (let i = 1; i <= types.length; i++) {
    if (i === types.length || types[i] !== streakType) {
      const streakLen = i - streakStart;
      if (streakLen >= 3 && streakType === 'text-heavy') {
        out.push({
          slide: streakStart + 2,
          severity: 'warn',
          kind: 'deck-no-visual-rhythm',
          message: `${streakLen} 张连续 text-heavy 页 (slides ${streakStart + 1}-${i}); 中间插入 heroImageQuote / dataFocus / manifesto 呼吸一下`,
        });
      }
      streakType = types[i];
      streakStart = i;
    }
  }

  /* 2. 8+ 页中段必须有呼吸页 (封面不算) */
  if (total >= 8) {
    const midBreath = types.slice(1).some((t) => t === 'hero' || t === 'image' || t === 'divider' || t === 'graphic');
    if (!midBreath) {
      out.push({
        slide: Math.ceil(total / 2),
        severity: 'warn',
        kind: 'deck-no-breath-page',
        message: `${total} 页 deck 中段没有一张 hero/image/divider 呼吸页; 至少在中间插一个 heroImageQuote / photoSpread / sectionDivider`,
      });
    }
  }

  /* 3. 6+ 页没有章节页 */
  if (total >= 6 && !types.includes('divider')) {
    out.push({
      slide: 1,
      severity: 'warn',
      kind: 'deck-no-sections',
      message: `${total} 页 deck 没有任何 sectionDivider; 建议 3-5 章节, 每章开头加一个 divider`,
    });
  }

  /* 4. 5+ 页一张图都没有 (不硬性) */
  if (total >= 5 && !types.includes('image')) {
    out.push({
      slide: 1,
      severity: 'warn',
      kind: 'deck-no-images',
      message: `${total} 页 deck 全部没图 · 建议至少一张 imageGallery / photoSpread / heroImageQuote(with image) 增加视觉呼吸`,
    });
  }
}
