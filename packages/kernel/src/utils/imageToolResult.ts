/**
 * imageToolResult — 工具图片结果协议 (__NEOX_IMAGE_RESULT__) 的 kernel 侧解析
 *
 * ## 协议与注入策略
 * 协议由 core 侧工具产出 (readfile 读图片/PDF 转页、浏览器截图等, 见
 * neox-core/tools/image/imageProcessor.ts buildImageToolResult): 工具返回
 * `__NEOX_IMAGE_RESULT__` + JSON({images:[{data,media_type,label}]}) 单行文本。
 *
 * ## 注入策略 (provider 无关)
 * tool 角色消息在 OpenAI 协议下**不允许**携带 image parts (400), Anthropic 允许
 * tool_result 图片而 Gemini functionResponse 不允许 — 所以不在 tool 消息上做文章:
 *   1. tool 消息 = 纯文本摘要 (保住 tool_call/tool_result 配对, 全 provider 兼容)
 *   2. 紧随其后注入一条合成 user 消息: label 文本 part + image_url data-URL part 交错
 * 图片原样发给上游，label 文本 part 始终保留。
 *
 *  PREFIX 常量必须与 neox-core/tools/image/imageProcessor.ts 的 IMAGE_RESULT_PREFIX
 * 保持一致 (kernel 不能反向依赖 core, 只能双写)。
 */

import type { Message, MessageContentPart } from '../types/index.js';

export const IMAGE_RESULT_PREFIX = '__NEOX_IMAGE_RESULT__';

/** 兜底闸门: 单图 base64 硬性字节上限 (2MB)。kernel 没有 sharp 压不了图, 正常路径
 *  上游 (core compressImageDataUrlIfNeeded, ~1.2MB/1568px) 都该压好; 超过这个值
 *  说明有漏网入口, 直接替换为占位文本, 防巨图沉进历史每轮重传。 */
export const MAX_IMAGE_BASE64_BYTES = 2 * 1024 * 1024;

/** 超限占位文本 (给模型看的诚实说明) */
export function oversizedImagePlaceholder(label: string | undefined, bytes: number): string {
  const mb = (bytes / 1024 / 1024).toFixed(1);
  return `[图片${label ? ` "${label}"` : ''}过大 (base64 ~${mb}MB, 上限 2MB), 已省略未注入对话。请让上游入口先压缩(长边 1568px / JPEG)再重试。]`;
}

export interface ParsedToolImage {
  /** base64 (不带 data: 前缀) */
  data: string;
  mediaType: string;
  label?: string;
}

/** 非图片结果 / 解析失败返回 null (调用方按普通文本处理) */
export function parseImageToolResult(raw: string): ParsedToolImage[] | null {
  if (typeof raw !== 'string' || !raw.startsWith(IMAGE_RESULT_PREFIX)) return null;
  try {
    const parsed = JSON.parse(raw.slice(IMAGE_RESULT_PREFIX.length));
    if (!parsed || !Array.isArray(parsed.images)) return null;
    const images: ParsedToolImage[] = [];
    for (const img of parsed.images) {
      if (!img || typeof img.data !== 'string' || !img.data) continue;
      images.push({
        data: img.data,
        mediaType: typeof img.media_type === 'string' && img.media_type ? img.media_type : 'image/jpeg',
        label: typeof img.label === 'string' && img.label ? img.label : undefined,
      });
    }
    return images.length > 0 ? images : null;
  } catch {
    return null;
  }
}

/**
 * 工具整段输出里抽图片 —— 直接前缀, 或包在 Contextual ToolResult.content 里.
 *
 * computer_snapshot 读不到元素树时必须把窗口截图喂给模型 (click_at 靠眼睛),
 * 但 UI 卡片还要 ToolResult.metadata. 图走 content 协议, 外壳仍是 JSON.
 */
/** 慢工具会在 JSON 前面加 ` [...]` 头 (enrichToolResult), 截断也可能在尾巴留半截。 */
function parseLeadingJsonObject(raw: string): { content?: unknown } | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  const slice = start === 0 ? raw : raw.slice(start);
  try {
    return JSON.parse(slice) as { content?: unknown };
  } catch {
    const end = slice.lastIndexOf('}');
    if (end > 0) {
      try {
        return JSON.parse(slice.slice(0, end + 1)) as { content?: unknown };
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function extractToolImages(raw: string): ParsedToolImage[] | null {
  const direct = parseImageToolResult(raw);
  if (direct) return direct;
  const parsed = parseLeadingJsonObject(raw);
  if (parsed && typeof parsed.content === 'string') {
    return parseImageToolResult(parsed.content);
  }
  const idx = raw.indexOf(IMAGE_RESULT_PREFIX);
  if (idx > 0) return parseImageToolResult(raw.slice(idx));
  return null;
}

/** tool 角色消息的纯文本摘要 — 全 provider 兼容, 配对不破 */
export function extractToolImageText(raw: string): string | undefined {
  if (typeof raw !== 'string')
    return undefined;
  /* Wrapped in a Contextual ToolResult (browser_run with screenshots): the payload is an escaped
   * string inside the outer JSON, so find it the same way extractToolImages does. */
  if (!raw.startsWith(IMAGE_RESULT_PREFIX)) {
    const parsed = parseLeadingJsonObject(raw);
    if (parsed && typeof parsed.content === 'string' && parsed.content.startsWith(IMAGE_RESULT_PREFIX)) {
      return extractToolImageText(parsed.content);
    }
  }
  const idx = raw.indexOf(IMAGE_RESULT_PREFIX);
  if (idx < 0)
    return undefined;
  try {
    const parsed = JSON.parse(raw.slice(idx + IMAGE_RESULT_PREFIX.length));
    return typeof parsed?.text === 'string' && parsed.text.trim() ? parsed.text : undefined;
  }
  catch {
    return undefined;
  }
}
export function buildImageToolSummaryText(toolName: string, images: ParsedToolImage[], text?: string): string {
  const labels = images.map((img, i) => img.label ?? `image ${i + 1}`).join('; ');
  const head = `[${toolName} 返回了 ${images.length} 张图片: ${labels}] 图片内容已作为附件在下一条消息中提供。`;
  return text ? `${head}\n\n${text}` : head;
}

/** 合成的图片附件消息 (user 角色) — label 文本与图片交错, 剥图后 label 仍可见 */
export function buildImageAttachmentMessage(toolName: string, images: ParsedToolImage[]): Message {
  const parts: MessageContentPart[] = [
    {
      type: 'text',
      text: `[系统注入] 以下 ${images.length} 张图片是工具 ${toolName} 的返回内容, 不是用户的新消息:`,
    },
  ];
  for (const img of images) {
    if (img.label) parts.push({ type: 'text', text: img.label });
    // 兜底闸门: 超限巨图不进历史, 换占位文本(最后防线, 正常路径上游已压好)
    if (img.data.length > MAX_IMAGE_BASE64_BYTES) {
      parts.push({ type: 'text', text: oversizedImagePlaceholder(img.label, img.data.length) });
      continue;
    }
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${img.mediaType};base64,${img.data}`, detail: 'auto' },
    });
  }
  return { role: 'user', content: parts };
}
