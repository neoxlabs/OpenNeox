
import { bridgeLog } from './log.js';
import { resolveSessionImagePath, stashDataUrl, stashImage, stashImageFile, withSessionImageBase } from './mobileImageStash.js';

export const MOBILE_TEXT_CAP = 8_000;

export const MOBILE_ITEM_CAP_BYTES = 96 * 1024;

function truncateTo(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}\n…[已截断, 原文 ${s.length} 字]`;
}

interface SlimLimits {
  /** 单个字符串最长字数 */
  text: number;
  /** 数组最多保留几个元素 (超出的用一条占位说明) */
  array: number;
}

const NORMAL_LIMITS: SlimLimits = { text: MOBILE_TEXT_CAP, array: Number.POSITIVE_INFINITY };
/** 第一遍瘦完还超单条上限时用的紧口径 */
const TIGHT_LIMITS: SlimLimits = { text: 1_000, array: 40 };
/** 最后一道: 只留结构 */
const SKELETON_LIMITS: SlimLimits = { text: 200, array: 12 };

/** 文本里嵌的 data:image (markdown `![x](data:...)`、HTML、日志) —— 换成 neox-image:// 引用 */
const EMBEDDED_DATA_IMAGE_RE = /data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]{64,})/gi;

/** markdown 图片指向电脑上的文件 `![x](/abs/a.png)` / `![x](file:///abs/a.png)` / 项目内相对路径
 *  `![x](charts/a.png)` —— 同样换成引用。带 scheme 的 (http:, data:, neox-image:) 不在这里管。 */
const LOCAL_MD_IMAGE_RE = /(!\[[^\]\n]*\]\()(?:file:\/\/)?((?![a-z][a-z0-9+.-]*:)[^)\s]+\.(?:png|jpe?g|webp|gif|bmp|svg))(\))/gi;

function stashEmbeddedImages(s: string): string {
  if (s.includes('](')) {
    s = s.replace(LOCAL_MD_IMAGE_RE, (all, open: string, p: string, close: string) => {
      let file = p;
      try { file = decodeURI(p); } catch { /* 不是合法转义, 按原样当路径 */ }
      const abs = resolveSessionImagePath(file);
      const url = abs ? stashImageFile(abs) : null;
      return url ? `${open}${url}${close}` : all;
    });
  }
  if (!s.includes('data:image/')) return s;
  return s.replace(EMBEDDED_DATA_IMAGE_RE, (_all, mime: string, b64: string) => {
    const md = stashImage(mime, b64);
    /* stashImage 给的是 `![](url)`, 嵌在原文里只要 url 部分 */
    return md ? md.slice(4, -1) : '[图片]';
  });
}

/** 图片块 → 一个 markdown 图片文本块 (手机按引用拉); 落盘失败退回占位 */
function imageBlock(mime: string, b64: string): { type: 'text'; text: string } {
  return { type: 'text', text: stashImage(mime, b64) ?? '[图片]' };
}

function slimValue(v: any, depth: number, lim: SlimLimits): any {
  if (typeof v === 'string') {
    if (v.startsWith('data:image/')) return stashDataUrl(v) ?? '[图片]';
    v = stashEmbeddedImages(v);
    /* 工具调用参数是 JSON 字符串 (write_file 的 content 整个文件都在里面) ——
     * 直接截会截成非法 JSON, 手机解析参数就挂了。解开、瘦身、再序列化。 */
    if (v.length > lim.text && (v.startsWith('{') || v.startsWith('['))) {
      try { return JSON.stringify(slimValue(JSON.parse(v), depth + 1, lim)); } catch { /* 不是 JSON, 按文本截 */ }
    }
    return truncateTo(v, lim.text);
  }
  if (!v || typeof v !== 'object') return v;
  /* 嵌套太深的原来是**原样放行** —— 正好是最容易藏大块内容的地方。改成一句说明。 */
  if (depth > 8) return '[嵌套过深, 已省略]';
  if (Array.isArray(v)) {
    if (v.length > lim.array) {
      return [
        ...v.slice(0, lim.array).map((x) => slimValue(x, depth + 1, lim)),
        `…[还有 ${v.length - lim.array} 项已省略]`,
      ];
    }
    return v.map((x) => slimValue(x, depth + 1, lim));
  }
  /* 多模态图片块: OpenAI 形 {type:'image_url', image_url:{url:data:...}} / Anthropic 形 {type:'image', source:{data}} */
  if (v.type === 'image_url' && typeof v.image_url?.url === 'string' && v.image_url.url.startsWith('data:')) {
    return { type: 'text', text: stashDataUrl(v.image_url.url) ?? '[图片]' };
  }
  if (v.type === 'image' && typeof v.source?.data === 'string') {
    return imageBlock(String(v.source.media_type ?? 'image/png'), v.source.data);
  }
  /* MCP 形 {type:'image', data, mimeType} */
  if (v.type === 'image' && typeof v.data === 'string' && typeof v.mimeType === 'string') {
    return imageBlock(v.mimeType, v.data);
  }
  const out: Record<string, any> = {};
  for (const [k, x] of Object.entries(v)) out[k] = slimValue(x, depth + 1, lim);
  return out;
}

export function jsonByteLength(v: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(v), 'utf8'); } catch { return 0; }
}

/**
 * 瘦身到手机能收、中转能过的样子。三档逐级收紧, 保证输出 ≤ MOBILE_ITEM_CAP_BYTES:
 *   1. 常规: 字符串 8K, 图片换占位
 *   2. 紧: 字符串 1K, 数组 40 项
 *   3. 骨架: 字符串 200, 数组 12 项 —— 只让手机认得出这是哪种消息、属于哪一轮
 * 每一档输出都是**同样的结构** (字段名/类型不变, tool_calls 仍是数组、arguments 仍是合法 JSON),
 * 手机按 kind 解析不会因为瘦身而 skip。
 */
export function slimPayloadForMobile<T>(payload: T): T {
  try {
    let out = slimValue(payload, 0, NORMAL_LIMITS);
    let bytes = jsonByteLength(out);
    if (bytes <= MOBILE_ITEM_CAP_BYTES) return out;
    for (const lim of [TIGHT_LIMITS, SKELETON_LIMITS]) {
      out = slimValue(payload, 0, lim);
      const next = jsonByteLength(out);
      if (next <= MOBILE_ITEM_CAP_BYTES) {
        bridgeLog('slim', `payload ${bytes}B over item cap, re-slimmed to ${next}B (text≤${lim.text})`);
        return out;
      }
      bytes = next;
    }
    /* 骨架还超 (成千上万个数组/键): 只留手机归轮/归类要用的几个顶层字段 */
    const p: any = payload;
    const stub: Record<string, any> = {};
    for (const k of ['role', 'turn_id', 'tool_call_id', 'tool_name', 'stream_order', 'type', 'kind']) {
      if (p && typeof p === 'object' && k in p && (typeof p[k] === 'string' || typeof p[k] === 'number')) stub[k] = p[k];
    }
    stub.content = `[这条内容太大 (${jsonByteLength(payload)} 字节), 手机端不显示, 请在电脑上查看]`;
    bridgeLog('slim', `payload still ${bytes}B after skeleton slim, replaced with stub`);
    return stub as T;
  } catch {
    return payload;
  }
}

/**
 * 一页的字节预算。回包还要 AES-GCM 加密再 base64 (×4/3) 外加 envelope 字段 —— 明文留 150KB 才稳。
 * 超了就从**旧的一头**丢: 手机按本页最小 seq 往回翻页, 丢掉的下一页自然会拉到;
 * 手机只在拿到空页时才认为到头 (HistoryPage.reachedEnd), 所以少给几条不会让它停。
 * 至少留一条 —— 单条本身已被 slimPayloadForMobile 截到 8K 字以内。
 */
export const HISTORY_PAGE_BUDGET_BYTES = 150 * 1024;

/**
 * 一页历史: 逐条转协议 (单条出错只跳过那一条并记下, 不能让整页变空 —— 以前一条坏结构 →
 * 整个 getSessionHistory 进 catch → 回 [] → 这个会话在手机上永远"没有消息"), 再按字节预算截。
 */
export function buildHistoryPage<A, R>(args: A[], map: (a: A) => R, sessionId: string): R[] {
  const out: R[] = [];
  for (const a of args) {
    try {
      out.push(withSessionImageBase(sessionId, () => map(a)));
    } catch (e: any) {
      bridgeLog('history', `skip unmappable message session=${sessionId.slice(0, 16)} seq=${(a as any)?.seq}: ${e?.message}`);
    }
  }
  const { kept, bytes } = fitHistoryPageToBudget(out);
  if (kept.length < out.length) bridgeLog('history', `page trimmed to budget: kept ${kept.length}/${out.length} (${bytes} bytes)`);
  return kept;
}

export function fitHistoryPageToBudget<T>(out: T[], budget = HISTORY_PAGE_BUDGET_BYTES): { kept: T[]; bytes: number } {
  let total = 0;
  let keepFrom = out.length;
  for (let i = out.length - 1; i >= 0; i--) {
    const size = jsonByteLength(out[i]);
    if (keepFrom < out.length && total + size > budget) break;
    total += size;
    keepFrom = i;
  }
  return { kept: keepFrom > 0 ? out.slice(keepFrom) : out, bytes: total };
}
