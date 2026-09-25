/**
 * pptxText 负责读取和替换 PPTX 中的文本。
 *
 * 这个模块只处理 XML 字符串, 不依赖 JSZip 或 Node。core 工具和渲染端解析器共用同一份逻辑。
 *
 * 换字的难点跟 Word 一样: PowerPoint 按格式把一句话切成多段 run
 * ("本季度营收 " | "1,280"(加粗红) | " 万元…")。替换按段落拼接文本查找,
 * 并把替换文字放入起点所在的 run, 沿用该 run 的格式, 其余格式保持不变。
 */

export interface DeckSlide {
  /** 1 起 */
  index: number;
  path: string;
  title: string;
  /** 非标题形状里的段落 (表格单独放) */
  paragraphs: string[];
  tables: string[][][];
  notes: string[];
}

/* ───────────── XML 小工具 ───────────── */

export function escapeXmlText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function unescapeXmlText(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/* <a:p> 但不是 <a:pPr>: 名字后面必须是空白或 > */
const PARA_RE = /<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g;
const T_RE = /<a:t(\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:t(\s[^>]*)?\/>/g;

function paragraphText(inner: string): string {
  let out = '';
  const re = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) out += m[1] !== undefined ? unescapeXmlText(m[1]) : '\n';
  return out;
}

function paragraphsOf(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(PARA_RE)) {
    const t = paragraphText(m[1]).trim();
    if (t) out.push(t);
  }
  return out;
}

/* ───────────── 结构 ───────────── */

/** presentation.xml 的 sldIdLst 顺序 → 包内路径 (ppt/slides/slideN.xml)。文件名序号 ≠ 放映顺序, 必须按这个排。 */
export function orderSlidePaths(presentationXml: string, relsXml: string): string[] {
  const targets = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) targets.set(id, target);
  }
  const out: string[] = [];
  for (const m of presentationXml.matchAll(/<p:sldId\b[^>]*>/g)) {
    const rid = /\br:id="([^"]+)"/.exec(m[0])?.[1];
    const t = rid ? targets.get(rid) : undefined;
    if (!t) continue;
    out.push(t.startsWith('/') ? t.slice(1) : `ppt/${t.replace(/^\.\//, '')}`);
  }
  return out;
}

/** 幻灯片 rels 里的备注页路径 */
export function notesPathFromSlideRels(relsXml: string | null): string | null {
  if (!relsXml) return null;
  const m = /<Relationship\b[^>]*Type="[^"]*\/notesSlide"[^>]*>/.exec(relsXml);
  const t = m ? /\bTarget="([^"]+)"/.exec(m[0])?.[1] : undefined;
  if (!t) return null;
  /* 相对 ppt/slides/ : "../notesSlides/notesSlide1.xml" */
  return t.startsWith('/') ? t.slice(1) : `ppt/${t.replace(/^\.\.\//, '')}`;
}

export function extractSlideText(slideXml: string): { title: string; paragraphs: string[]; tables: string[][][] } {
  /* 表格先拿走, 否则单元格会混进正文段落 */
  const tables: string[][][] = [];
  let rest = slideXml.replace(/<a:tbl\b[\s\S]*?<\/a:tbl>/g, (tbl) => {
    const rows: string[][] = [];
    for (const tr of tbl.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)) {
      const cells: string[] = [];
      for (const tc of tr[1].matchAll(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>|<a:tc\b[^>]*\/>/g)) {
        cells.push(paragraphsOf(tc[1] ?? '').join(' ').trim());
      }
      rows.push(cells);
    }
    tables.push(rows);
    return '';
  });
  let title = '';
  rest = rest.replace(/<p:sp\b[\s\S]*?<\/p:sp>/g, (sp) => {
    if (!title && /<p:ph\b[^>]*type="(title|ctrTitle)"/.test(sp)) {
      title = paragraphsOf(sp).join(' ');
      return '';
    }
    return sp;
  });
  return { title, paragraphs: paragraphsOf(rest), tables };
}

/** 备注页: 只取正文占位符 (type="body"), 不要页码 / 缩略图占位 */
export function extractNotesText(notesXml: string): string[] {
  const out: string[] = [];
  for (const sp of notesXml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)) {
    if (/<p:ph\b[^>]*type="body"/.test(sp[0])) out.push(...paragraphsOf(sp[0]));
  }
  return out;
}

/** 按放映顺序读整份稿子。read(path) 由调用方提供 (JSZip / 别的), 这里不碰字节。 */
export async function readDeck(
  read: (path: string) => Promise<string | null>,
  opts: { notes?: boolean } = {},
): Promise<DeckSlide[]> {
  const pres = await read('ppt/presentation.xml');
  const rels = await read('ppt/_rels/presentation.xml.rels');
  if (!pres || !rels) throw new Error('不是 .pptx (缺 ppt/presentation.xml) —— .ppt / .key 需要先另存为 .pptx');
  const paths = orderSlidePaths(pres, rels);
  const out: DeckSlide[] = [];
  for (let i = 0; i < paths.length; i++) {
    const xml = await read(paths[i]);
    if (!xml) continue;
    const t = extractSlideText(xml);
    let notes: string[] = [];
    if (opts.notes) {
      const relPath = paths[i].replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels');
      const np = notesPathFromSlideRels(await read(relPath));
      const nx = np ? await read(np) : null;
      if (nx) notes = extractNotesText(nx);
    }
    out.push({ index: i + 1, path: paths[i], ...t, notes });
  }
  return out;
}

export function slidesToMarkdown(slides: DeckSlide[], opts: { notes?: boolean } = {}): string {
  const parts: string[] = [];
  for (const s of slides) {
    const lines: string[] = [`## 第 ${s.index} 页${s.title ? ` · ${s.title}` : ''}`];
    for (const p of s.paragraphs) lines.push(p.includes('\n') ? p : `- ${p}`);
    for (const t of s.tables) {
      if (!t.length) continue;
      const cols = Math.max(...t.map((r) => r.length));
      const fmt = (r: string[]) => `| ${Array.from({ length: cols }, (_, i) => (r[i] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`;
      lines.push('', fmt(t[0]), `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`, ...t.slice(1).map(fmt));
    }
    if (opts.notes && s.notes.length) lines.push('', `> 备注: ${s.notes.join(' / ')}`);
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}

/* ───────────── 换字 ───────────── */

/**
 * 在一段幻灯片 XML 的每个段落里, 把 find 换成 replace (可以跨 run)。
 * 替换文字进起点所在的 run, 沿用它的格式; 被跨过的 run 删掉对应的字, 其余不动。
 */
export function replaceTextInSlideXml(xml: string, find: string, replace: string): { xml: string; count: number } {
  if (!find) return { xml, count: 0 };
  let count = 0;
  const out = xml.replace(PARA_RE, (whole, inner: string) => {
    /* 收集这一段所有 <a:t> 的位置和文字 */
    const runs: Array<{ start: number; end: number; open: string; text: string }> = [];
    T_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = T_RE.exec(inner))) {
      if (m[2] === undefined) continue; /* 自闭合 <a:t/> 没字 */
      runs.push({ start: m.index, end: m.index + m[0].length, open: `<a:t${m[1] ?? ''}>`, text: unescapeXmlText(m[2]) });
    }
    if (runs.length === 0) return whole;
    const texts = runs.map((r) => r.text);
    if (!texts.join('').includes(find)) return whole;

    /* 只替换真正不同的中间片段, 让替换文字沿用对应 run 的格式, 保留其余强调样式。 */
    let pre = 0;
    while (pre < find.length && pre < replace.length && find[pre] === replace[pre]) pre++;
    let suf = 0;
    while (suf < find.length - pre && suf < replace.length - pre
      && find[find.length - 1 - suf] === replace[replace.length - 1 - suf]) suf++;
    const mid = replace.slice(pre, replace.length - suf);

    let from = 0;
    for (;;) {
      const full = texts.join('');
      const at = full.indexOf(find, from);
      if (at < 0) break;
      const cutStart = at + pre;
      const cutEnd = at + find.length - suf;
      /* 定位 cutStart 所在的 run; 纯插入 (cutStart === cutEnd) 且落在 run 边界时, 接到前一个 run 的尾巴上 */
      let pos = 0; let first = -1;
      for (let i = 0; i < texts.length; i++) {
        const len = texts[i].length;
        const inside = cutStart < pos + len || (cutStart === cutEnd && cutStart === pos + len && cutStart > 0);
        if (inside) { first = i; break; }
        pos += len;
      }
      if (first < 0) { first = texts.length - 1; pos = full.length - texts[first].length; }
      const offset = cutStart - pos;
      let remaining = cutEnd - cutStart;
      const head = texts[first].slice(0, offset);
      const tail = texts[first].slice(offset);
      if (remaining <= tail.length) {
        texts[first] = head + mid + tail.slice(remaining);
      } else {
        texts[first] = head + mid;
        remaining -= tail.length;
        for (let j = first + 1; j < texts.length && remaining > 0; j++) {
          const take = Math.min(remaining, texts[j].length);
          texts[j] = texts[j].slice(take);
          remaining -= take;
        }
      }
      count++;
      from = at + replace.length;
    }

    /* 回填 */
    let rebuilt = ''; let cursor = 0;
    runs.forEach((r, i) => {
      rebuilt += inner.slice(cursor, r.start) + `${r.open}${escapeXmlText(texts[i])}</a:t>`;
      cursor = r.end;
    });
    rebuilt += inner.slice(cursor);
    return whole.replace(inner, rebuilt);
  });
  return { xml: out, count };
}
