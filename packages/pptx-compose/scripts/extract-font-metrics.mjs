#!/usr/bin/env node
/* eslint-disable */
/**
 * extract-font-metrics — build-time 字体 metrics 提取器 (零依赖 · 自研 sfnt/TTC 二进制解析).
 *
 * 从真实字体文件提取:
 *   - unitsPerEm (head)
 *   - ascent / descent / lineGap (hhea) + sTypo* / usWin* (OS/2)
 *   - per-char advance widths (cmap format 4/12 → hmtx), 归一化成 em 分数
 *   - CJK 统一 advance (采样 CJK Unified 区确认等宽)
 *
 * 输出 src/assets/font-metrics.json — 运行时被 layout/text-metrics 读取做**精确断行预测**.
 * "我不要靠猜": 字符宽度来自字体文件本身, 不是启发式系数.
 *
 * 用法: node scripts/extract-font-metrics.mjs
 * 在 macOS dev 机上跑一次, 产物提交进仓库. 用户机器上运行时零字体文件依赖.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, '..', 'src', 'assets', 'font-metrics.data.ts');

/* ============================================================
 * 提取目标: file 候选路径列表 (取第一个存在的), family = name 表匹配
 * ============================================================ */

const PINGFANG_ASSET = '/System/Library/AssetsV2/com_apple_MobileAsset_Font7';

/** glob-lite: 在 AssetsV2 里按文件名找字体 (macOS 15 把一批中文字体移进了按需资产目录,
 *  目录名是 hash, 只能遍历). 中文字体现在基本都在这里, 不是只有 PingFang。 */
function assetCandidates(fileName, ...fallbacks) {
  const out = [];
  try {
    for (const d of nodeFs.readdirSync(PINGFANG_ASSET)) {
      const p = join(PINGFANG_ASSET, d, 'AssetData', fileName);
      if (nodeFs.existsSync(p)) out.push(p);
    }
  } catch { /* ignore */ }
  out.push(...fallbacks);
  return out;
}

function pingfangCandidates() {
  return assetCandidates('PingFang.ttc', '/System/Library/Fonts/PingFang.ttc');
}

import * as nodeFs from 'node:fs';

const TARGETS = [
  { family: 'PingFang SC', style: 'Regular', files: pingfangCandidates() },
  { family: 'PingFang SC', style: 'Semibold', asBoldOf: 'PingFang SC', files: pingfangCandidates() },
  { family: 'Songti SC', style: 'Regular', files: ['/System/Library/Fonts/Supplemental/Songti.ttc', '/System/Library/Fonts/Songti.ttc'] },
  { family: 'Songti SC', style: 'Bold', asBoldOf: 'Songti SC', files: ['/System/Library/Fonts/Supplemental/Songti.ttc', '/System/Library/Fonts/Songti.ttc'] },
  { family: 'Hiragino Sans GB', style: 'W3', files: ['/System/Library/Fonts/Hiragino Sans GB.ttc'] },
  { family: 'Hiragino Sans GB', style: 'W6', asBoldOf: 'Hiragino Sans GB', files: ['/System/Library/Fonts/Hiragino Sans GB.ttc'] },
  { family: 'Helvetica Neue', style: 'Regular', files: ['/System/Library/Fonts/HelveticaNeue.ttc'] },
  { family: 'Helvetica Neue', style: 'Bold', asBoldOf: 'Helvetica Neue', files: ['/System/Library/Fonts/HelveticaNeue.ttc'] },
  { family: 'Helvetica', style: 'Regular', files: ['/System/Library/Fonts/Helvetica.ttc'] },
  { family: 'Helvetica', style: 'Bold', asBoldOf: 'Helvetica', files: ['/System/Library/Fonts/Helvetica.ttc'] },
  { family: 'Didot', style: 'Regular', files: ['/System/Library/Fonts/Supplemental/Didot.ttc', '/System/Library/Fonts/Didot.ttc'] },
  { family: 'Didot', style: 'Bold', asBoldOf: 'Didot', files: ['/System/Library/Fonts/Supplemental/Didot.ttc', '/System/Library/Fonts/Didot.ttc'] },
  { family: 'Georgia', style: 'Regular', files: ['/System/Library/Fonts/Supplemental/Georgia.ttf'] },
  { family: 'Georgia', style: 'Bold', asBoldOf: 'Georgia', files: ['/System/Library/Fonts/Supplemental/Georgia Bold.ttf'] },
  { family: 'Times New Roman', style: 'Regular', files: ['/System/Library/Fonts/Supplemental/Times New Roman.ttf'] },
  { family: 'Times New Roman', style: 'Bold', asBoldOf: 'Times New Roman', files: ['/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf'] },
  { family: 'Arial', style: 'Regular', files: ['/System/Library/Fonts/Supplemental/Arial.ttf'] },
  { family: 'Arial', style: 'Bold', asBoldOf: 'Arial', files: ['/System/Library/Fonts/Supplemental/Arial Bold.ttf'] },
  { family: 'Menlo', style: 'Regular', files: ['/System/Library/Fonts/Menlo.ttc'] },
  { family: 'Menlo', style: 'Bold', asBoldOf: 'Menlo', files: ['/System/Library/Fonts/Menlo.ttc'] },
  { family: 'Avenir Next', style: 'Regular', files: ['/System/Library/Fonts/Avenir Next.ttc'] },
  { family: 'Avenir Next', style: 'Bold', asBoldOf: 'Avenir Next', files: ['/System/Library/Fonts/Avenir Next.ttc'] },

  /* 【2026-08-10 补】中文字面才是中文观众真正看见的东西, 而这里原来只有
   * 黑体 (PingFang) 和宋体 (Songti) 两种 —— 四套风格里必然有三套撞脸,
   * 换了风格中文标题看着一模一样。明康说"字体完全看不见", 有一半是这个。
   * 楷体 (表彰/仪式文体) 和圆体 (亲和, 且和 capsule 的圆角形态同源)
   * 各自有明确的用途, 不是凑数。Windows/WPS 侧 楷体=KaiTi 也有对应。 */
  { family: 'Kaiti SC', style: 'Regular', files: assetCandidates('Kaiti.ttc', '/System/Library/Fonts/Supplemental/Kaiti.ttc') },
  { family: 'Kaiti SC', style: 'Bold', asBoldOf: 'Kaiti SC', files: assetCandidates('Kaiti.ttc', '/System/Library/Fonts/Supplemental/Kaiti.ttc') },
  { family: 'Yuanti SC', style: 'Regular', files: assetCandidates('Yuanti.ttc', '/System/Library/Fonts/Supplemental/Yuanti.ttc') },
  { family: 'Yuanti SC', style: 'Bold', asBoldOf: 'Yuanti SC', files: assetCandidates('Yuanti.ttc', '/System/Library/Fonts/Supplemental/Yuanti.ttc') },
];

/** 找不到的字体 → 用 metric 相近的系统字体顶 (WPS 遇到缺字体也会替换; 我们至少替换得可预测) */
const ALIASES = {
  'Playfair Display': 'Didot',
  'Inter': 'Helvetica Neue',
  'JetBrains Mono': 'Menlo',
  'SF Mono': 'Menlo',
  'SF Pro': 'Helvetica Neue',
  'SF Pro Text': 'Helvetica Neue',
  'SF Pro Display': 'Helvetica Neue',
  'PingFang TC': 'PingFang SC',
  'PingFang HK': 'PingFang SC',
  'Microsoft YaHei': 'PingFang SC',
  '微软雅黑': 'PingFang SC',
  '宋体': 'Songti SC',
  'SimSun': 'Songti SC',
  'STSong': 'Songti SC',
  'Songti TC': 'Songti SC',
  'Hiragino Sans': 'Hiragino Sans GB',
  'Helvetica Neue Light': 'Helvetica Neue',
  /* Windows/WPS 侧的同族名 —— 导出的 pptx 在 Windows 上会用这些名字, 我们这边
   * 得能按同一套 metrics 去量, 否则又回到"量的和画的不是一个字体"。 */
  '楷体': 'Kaiti SC',
  'KaiTi': 'Kaiti SC',
  'STKaiti': 'Kaiti SC',
  'Kaiti TC': 'Kaiti SC',
  '圆体': 'Yuanti SC',
  'Yuanti TC': 'Yuanti SC',
  '黑体': 'PingFang SC',
  'SimHei': 'PingFang SC',
  'Heiti SC': 'PingFang SC',
  'STHeiti': 'PingFang SC',
};

/* 要提取 advance 的字符集 */
function charSet() {
  const chars = [];
  for (let c = 0x20; c <= 0x7e; c++) chars.push(c);            /* ASCII 可打印 */
  for (let c = 0xa0; c <= 0xff; c++) chars.push(c);            /* Latin-1 */
  const extra = '“”‘’—–‑…·•∙¥€£©®™°±×÷≈≤≥←→↑↓、。，！？；：（）《》〈〉「」『』【】〔〕—…‰㎡㎞';
  for (const ch of extra) chars.push(ch.codePointAt(0));
  /* fullwidth forms */
  for (let c = 0xff01; c <= 0xff5e; c++) chars.push(c);
  return [...new Set(chars)];
}

/* CJK 采样: 常用汉字 + 均匀采样, 用来确认 CJK 是否等宽 + 求统一 advance */
function cjkSample() {
  const common = '的一是了我不人在他有这上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开';
  const codes = [...common].map((c) => c.codePointAt(0));
  for (let c = 0x4e00; c <= 0x9fff; c += 137) codes.push(c);
  return [...new Set(codes)];
}

/* ============================================================
 * sfnt / TTC 二进制解析
 * ============================================================ */

function u8(dv, o) { return dv.getUint8(o); }
function u16(dv, o) { return dv.getUint16(o, false); }
function i16(dv, o) { return dv.getInt16(o, false); }
function u32(dv, o) { return dv.getUint32(o, false); }

/** 返回 buffer 里所有 sfnt 子字体的起始 offset (TTC 多个, 单字体 [0]) */
function sfntOffsets(dv) {
  const tag = u32(dv, 0);
  if (tag === 0x74746366 /* 'ttcf' */) {
    const numFonts = u32(dv, 8);
    const offsets = [];
    for (let i = 0; i < numFonts; i++) offsets.push(u32(dv, 12 + i * 4));
    return offsets;
  }
  return [0];
}

/** 解析 sfnt table directory → { tag: {offset, length} } */
function tableDir(dv, base) {
  const numTables = u16(dv, base + 4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16;
    const tag = String.fromCharCode(u8(dv, rec), u8(dv, rec + 1), u8(dv, rec + 2), u8(dv, rec + 3));
    tables[tag] = { offset: u32(dv, rec + 8), length: u32(dv, rec + 12) };
  }
  return tables;
}

/** name 表 → { family, subfamily }.
 * 关键坑: name 表含多语言记录 (西语 "Negrita" / 中文 "宋体-简"), 必须按 languageID 优先英文:
 *   1. platform 3 (Windows) languageID 0x409 (en-US)
 *   2. platform 1 (Mac) languageID 0 (English)
 *   3. platform 0 (Unicode) 任意
 *   4. 兜底任意语言 (纯中文名字体如 宋体-简 没英文记录时) */
function parseName(dv, t) {
  if (!t) return {};
  const base = t.offset;
  const count = u16(dv, base + 2);
  const strOff = base + u16(dv, base + 4);
  /* vals[nameID] = { str, prio } · prio 越小越优 */
  const vals = {};
  for (let i = 0; i < count; i++) {
    const rec = base + 6 + i * 12;
    const platformID = u16(dv, rec);
    const encodingID = u16(dv, rec + 2);
    const languageID = u16(dv, rec + 4);
    const nameID = u16(dv, rec + 6);
    const length = u16(dv, rec + 8);
    const offset = u16(dv, rec + 10);
    if (![1, 2, 16, 17].includes(nameID)) continue;
    let str = null;
    let prio = 9;
    if (platformID === 3 && (encodingID === 1 || encodingID === 10)) {
      let s = '';
      for (let j = 0; j < length; j += 2) s += String.fromCharCode(u16(dv, strOff + offset + j));
      str = s;
      prio = languageID === 0x409 ? 0 : 3;
    } else if (platformID === 1 && encodingID === 0) {
      let s = '';
      for (let j = 0; j < length; j++) s += String.fromCharCode(u8(dv, strOff + offset + j));
      str = s;
      prio = languageID === 0 ? 1 : 4;
    } else if (platformID === 0) {
      let s = '';
      for (let j = 0; j < length; j += 2) s += String.fromCharCode(u16(dv, strOff + offset + j));
      str = s;
      prio = 2;
    }
    if (str && (!vals[nameID] || prio < vals[nameID].prio)) vals[nameID] = { str, prio };
  }
  const pick = (id) => vals[id]?.str || '';
  return {
    family: pick(16) || pick(1),
    subfamily: pick(17) || pick(2),
  };
}

/** cmap → Map<codepoint, glyphId> (只解 format 4 / 12 的 Unicode 表) */
function parseCmap(dv, t, wanted) {
  const base = t.offset;
  const numTables = u16(dv, base + 2);
  let best = null; /* {format, offset} — 优先 format 12, 次 format 4 */
  for (let i = 0; i < numTables; i++) {
    const rec = base + 4 + i * 8;
    const platformID = u16(dv, rec);
    const encodingID = u16(dv, rec + 2);
    const offset = u32(dv, rec + 4);
    const isUnicode = platformID === 0 || (platformID === 3 && (encodingID === 1 || encodingID === 10));
    if (!isUnicode) continue;
    const format = u16(dv, base + offset);
    if (format === 12) { best = { format, offset: base + offset }; break; }
    if (format === 4 && (!best || best.format !== 12)) best = { format, offset: base + offset };
  }
  if (!best) return new Map();

  const map = new Map();
  const want = new Set(wanted);
  if (best.format === 4) {
    const o = best.offset;
    const segCountX2 = u16(dv, o + 6);
    const segCount = segCountX2 / 2;
    const endO = o + 14, startO = endO + segCountX2 + 2, deltaO = startO + segCountX2, rangeO = deltaO + segCountX2;
    for (const cp of want) {
      if (cp > 0xffff) continue;
      /* 线性找 segment (字符集小, 无所谓性能) */
      for (let s = 0; s < segCount; s++) {
        const end = u16(dv, endO + s * 2);
        if (cp > end) continue;
        const start = u16(dv, startO + s * 2);
        if (cp < start) break;
        const delta = i16(dv, deltaO + s * 2);
        const rangeOffset = u16(dv, rangeO + s * 2);
        let gid;
        if (rangeOffset === 0) gid = (cp + delta) & 0xffff;
        else {
          const gidO = rangeO + s * 2 + rangeOffset + (cp - start) * 2;
          const g = u16(dv, gidO);
          gid = g === 0 ? 0 : (g + delta) & 0xffff;
        }
        if (gid) map.set(cp, gid);
        break;
      }
    }
  } else {
    const o = best.offset;
    const nGroups = u32(dv, o + 12);
    /* group 是排序的; 字符集小, 对每个 cp 二分 */
    const sorted = [...want].sort((a, b) => a - b);
    let gi = 0;
    for (const cp of sorted) {
      while (gi < nGroups) {
        const g = o + 16 + gi * 12;
        const startChar = u32(dv, g), endChar = u32(dv, g + 4), startGid = u32(dv, g + 8);
        if (cp < startChar) break;
        if (cp <= endChar) { map.set(cp, startGid + (cp - startChar)); break; }
        gi++;
      }
    }
  }
  return map;
}

/** 解析一个子字体 → metrics 对象 */
function parseFont(dv, base, wantedChars) {
  const tables = tableDir(dv, base);
  if (!tables.head || !tables.hhea || !tables.hmtx || !tables.cmap) return null;

  const name = parseName(dv, tables.name);
  const unitsPerEm = u16(dv, tables.head.offset + 18);
  const macStyle = u16(dv, tables.head.offset + 44);
  const isItalic = (macStyle & 0x2) !== 0;

  const hheaO = tables.hhea.offset;
  const ascent = i16(dv, hheaO + 4);
  const descent = i16(dv, hheaO + 6);
  const lineGap = i16(dv, hheaO + 8);
  const numberOfHMetrics = u16(dv, hheaO + 34);

  let os2 = null;
  if (tables['OS/2']) {
    const o = tables['OS/2'].offset;
    os2 = {
      fsSelectionItalic: (u16(dv, o + 62) & 0x1) !== 0,
      weightClass: u16(dv, o + 4),
      typoAscent: i16(dv, o + 68),
      typoDescent: i16(dv, o + 70),
      typoLineGap: i16(dv, o + 72),
      winAscent: u16(dv, o + 74),
      winDescent: u16(dv, o + 76),
    };
  }

  const cmap = parseCmap(dv, tables.cmap, wantedChars);
  const hmtxO = tables.hmtx.offset;
  const advanceOf = (gid) => {
    const idx = Math.min(gid, numberOfHMetrics - 1);
    return u16(dv, hmtxO + idx * 4);
  };

  const advances = {};
  for (const cp of wantedChars) {
    const gid = cmap.get(cp);
    if (gid == null) continue;
    advances[cp] = advanceOf(gid);
  }

  return { family: name.family, subfamily: name.subfamily, isItalic, unitsPerEm, ascent, descent, lineGap, os2, advances };
}

/* ============================================================
 * main
 * ============================================================ */

function round4(x) { return Math.round(x * 10000) / 10000; }

function main() {
  const wantedLatin = charSet();
  const wantedCjk = cjkSample();
  const wanted = [...wantedLatin, ...wantedCjk];

  const out = { version: 1, generatedAt: new Date().toISOString().slice(0, 10), fonts: {}, aliases: ALIASES };
  const fileCache = new Map();

  for (const target of TARGETS) {
    let extracted = null;
    for (const file of target.files) {
      if (!existsSync(file)) continue;
      let dv = fileCache.get(file);
      if (!dv) {
        const buf = readFileSync(file);
        dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        fileCache.set(file, dv);
      }
      for (const base of sfntOffsets(dv)) {
        let font;
        try { font = parseFont(dv, base, wanted); } catch { continue; }
        if (!font) continue;
        const famMatch = font.family === target.family
          || font.family.startsWith(target.family);
        /* 风格判定: 名字表 subfamily 会被本地化 ("Negrita"/"粗体"), 改用 OS/2 weightClass +
         * macStyle italic 位 — 二进制信号跨语言稳定. */
        const weight = font.os2?.weightClass ?? 400;
        const styleWants = {
          'regular': (w) => w >= 350 && w <= 450,
          'medium': (w) => w > 450 && w <= 550,
          'semibold': (w) => w >= 590 && w <= 680,
          'bold': (w) => w >= 660 && w <= 800,
          'w3': (w) => w >= 250 && w <= 400,
          'w6': (w) => w >= 590 && w <= 700,
        }[target.style.toLowerCase()] ?? ((w) => w >= 350 && w <= 500);
        const italic = font.isItalic || font.os2?.fsSelectionItalic;
        const styleMatch = !italic && styleWants(weight);
        if (famMatch && styleMatch) { extracted = font; break; }
      }
      if (extracted) break;
    }
    if (!extracted) {
      console.warn(`[skip] ${target.family} ${target.style} — 没找到`);
      continue;
    }

    const upm = extracted.unitsPerEm;
    /* 归一化 advances → em 分数 */
    const norm = {};
    for (const [cp, adv] of Object.entries(extracted.advances)) {
      norm[cp] = round4(adv / upm);
    }
    /* CJK 统一 advance: 取采样众数 */
    const cjkAdvs = wantedCjk.map((cp) => norm[cp]).filter((x) => x != null);
    const freq = new Map();
    for (const a of cjkAdvs) freq.set(a, (freq.get(a) ?? 0) + 1);
    let cjkAdvance = 1.0, best = 0;
    for (const [a, n] of freq) if (n > best) { best = n; cjkAdvance = a; }
    const cjkUniform = cjkAdvs.length > 0 && best / cjkAdvs.length > 0.95;

    /* latin/标点 advances 保留; CJK 采样丢掉 (等宽的用 cjkAdvance 就够) */
    const latinAdvances = {};
    const cjkSet = new Set(wantedCjk);
    for (const [cp, a] of Object.entries(norm)) {
      if (!cjkSet.has(Number(cp)) || !cjkUniform) latinAdvances[cp] = a;
    }

    const rec = {
      unitsPerEm: upm,
      /* 归一化垂直 metrics (em 分数) */
      ascent: round4(extracted.ascent / upm),
      descent: round4(Math.abs(extracted.descent) / upm),
      lineGap: round4(extracted.lineGap / upm),
      typoAscent: extracted.os2 ? round4(extracted.os2.typoAscent / upm) : null,
      typoDescent: extracted.os2 ? round4(Math.abs(extracted.os2.typoDescent) / upm) : null,
      typoLineGap: extracted.os2 ? round4(extracted.os2.typoLineGap / upm) : null,
      cjkAdvance: cjkUniform ? cjkAdvance : null,
      advances: latinAdvances,
    };

    const key = target.asBoldOf ? `${target.asBoldOf}:bold` : target.family;
    out.fonts[key] = rec;
    console.log(`[ok] ${key} ← "${extracted.family} ${extracted.subfamily}" upm=${upm} ascent=${rec.ascent} descent=${rec.descent} lineGap=${rec.lineGap} cjk=${rec.cjkAdvance ?? 'varies'} latinChars=${Object.keys(latinAdvances).length}`);
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  const json = JSON.stringify(out);
  const ts = `/**
 * font-metrics.data — 真实字体 metrics 烘焙表 (scripts/extract-font-metrics.mjs 生成 · 勿手改).
 *
 * 数据来自 macOS 系统字体文件的 head/hhea/OS2/hmtx/cmap 表.
 * advances 是 em 分数 (advance/unitsPerEm), 垂直 metrics 同样归一化.
 * cjkAdvance 非 null = 该字体 CJK 全角等宽 (采样 >95% 一致).
 * 重新生成: node scripts/extract-font-metrics.mjs
 */
/* eslint-disable */
export const FONT_METRICS_DATA = ${json} as const;
`;
  writeFileSync(OUT_PATH, ts);
  const kb = Math.round(ts.length / 1024);
  console.log(`\n→ ${OUT_PATH} (${kb} KB, ${Object.keys(out.fonts).length} font records)`);
}

main();
