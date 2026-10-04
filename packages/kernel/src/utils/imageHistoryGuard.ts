/**
 * imageHistoryGuard — 在历史发送前省略较早轮次的 base64 图片
 *
 * ## 设计
 *
 * 历史轮次的图片会在后续请求中重复发送，因此仅保留最近 N 个 user turn 的图片，
 * 更早的图片替换为占位文本。
 *   · 上传、转发和 prefill 每轮都会重复处理图片数据, 增加首 token 延迟。
 *   · prompt cache 未命中时, 图片 token 需要再次计算。
 *   · 上下文用量被图片吃满。
 *
 * 函数不修改原始消息；当前保留窗口、文本内容和工具配对保持不变。
 *
 * ## 安全性
 *   · 纯函数, 不改 this.memory 里存的原始消息(只产出发给 LLM 的副本)→ UI/持久化不受影响。
 *   · 当前 turn(最后一个 user 消息起)的图片**始终保留**, 不会弄瞎模型对刚发图片的感知。
 *   · 只动 image_url 类 base64 data URL; 文本、工具消息原样保留 → 不碰 tool_call 配对。
 *
 * ## 与「入口压缩」的分工(重要)
 * 第一防线是 imageProcessor.compressImageDataUrlIfNeeded —— 图片进会话时就压到预算内。
 * 本模块是第二防线: 默认保留最近 3 个 user turn 的图片, 更早的换占位文本
 * (NEOX_KEEP_IMAGE_TURNS=N 覆盖, =off 禁用)。
 */

import type { Message, MessageContentPart } from '../types/index.js';

const PLACEHOLDER_ZH = '[早前轮次的图片已省略以节省上下文/延迟;如需重新查看请让用户再发一次]';

/**
 * 返回保留的 user turn 数；null = 禁用图片剥离。
 */
const DEFAULT_KEEP_IMAGE_TURNS = 3;
function readKeepTurns(): number | null {
  const raw = process.env.NEOX_KEEP_IMAGE_TURNS;
  if (raw === undefined || raw === '') return DEFAULT_KEEP_IMAGE_TURNS;
  if (/^(off|false|never|disable[d]?)$/i.test(raw.trim())) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function isBase64ImagePart(part: MessageContentPart): boolean {
  return (
    !!part &&
    typeof part === 'object' &&
    (part as any).type === 'image_url' &&
    typeof (part as any).image_url?.url === 'string' &&
    (part as any).image_url.url.startsWith('data:image')
  );
}

function messageHasBase64Image(msg: Message): boolean {
  const c = (msg as any).content;
  return Array.isArray(c) && c.some(isBase64ImagePart);
}

export interface StripStaleImagesResult {
  messages: Message[];
  /** 被剥离的图片个数 */
  strippedImages: number;
  /** 估算释放的字节数(base64 字符串长度) */
  bytesFreed: number;
}

/**
 * 把"早于最近 keepTurns 个 user turn"的 base64 图片替换为占位文本。
 * 返回**新数组**(仅被改的消息是新对象, 其余原样引用), 绝不 mutate 入参。
 */
export function stripStaleImages(
  messages: Message[],
  opts: { keepTurns?: number } = {},
): StripStaleImagesResult {
  const keepTurns = opts.keepTurns ?? readKeepTurns();

  // 未启用(默认)→ 不剥离, 原样返回。主防线是入口压缩(compressImageDataUrlIfNeeded)。
  if (keepTurns === null) {
    return { messages, strippedImages: 0, bytesFreed: 0 };
  }

  // 找"保留窗口"的起点: 从尾部往前数第 keepTurns 个 user 消息的下标。
  // 该下标(含)及之后的图片全部保留; 之前的剥离。
  let userSeen = 0;
  let keepFromIdx = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      userSeen += 1;
      if (userSeen >= keepTurns) {
        keepFromIdx = i;
        break;
      }
    }
  }
  // keepTurns=0 → 全部剥离(keepFromIdx 保持 0 但下面用 > 截断需特殊处理)
  const keepBoundary = keepTurns === 0 ? messages.length : keepFromIdx;

  let strippedImages = 0;
  let bytesFreed = 0;

  const out = messages.map((msg, idx) => {
    if (idx >= keepBoundary) return msg; // 保留窗口内, 原样
    if (!messageHasBase64Image(msg)) return msg;

    const parts = (msg as any).content as MessageContentPart[];
    const newParts: MessageContentPart[] = parts.map((p) => {
      if (isBase64ImagePart(p)) {
        strippedImages += 1;
        bytesFreed += ((p as any).image_url.url as string).length;
        return { type: 'text', text: PLACEHOLDER_ZH } as MessageContentPart;
      }
      return p;
    });
    return { ...msg, content: newParts } as Message;
  });

  return { messages: out, strippedImages, bytesFreed };
}

/* 图片能力由上游决定, 请求层保留用户提交的图片。
 * 本文件只负责减少较早历史轮次的重复图片, 不根据本地模型能力表删除图片。 */
