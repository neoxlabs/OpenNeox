
import type { Message, MessageContentPart } from '@neoxlabs/kernel/types/index.js';
import type { RuntimeMetadata } from './runtimeTypes.js';

export const MAX_TOOL_OUTPUT_PREVIEW = 12000;

/** Task context for recovery, never a new message to append. */
export function getLastUserTask(messages: ReadonlyArray<{ role: string; content: unknown }>): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const text = userContentText(message.content);
    /* 续跑/自动续推的控制消息不是用户的任务 —— 重试时把它当任务重发, 模型只会再"继续"一次 */
    if (isControlPrompt(text)) continue;
    return text;
  }
  return undefined;
}

function userContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('\n');
  }
  return '';
}

/**
 * 系统替用户发的控制消息 ([NEOX_RESUME] 续跑、[NEOX_TARGET_CONTINUE] 自动续推 ……)。
 * 前面可能垫着 system-reminder 块, 跳过它们再看开头。
 */
export function isControlPrompt(content: unknown): boolean {
  return userContentText(content)
    .replace(/^\s*(?:<system-reminder>[\s\S]*?<\/system-reminder>\s*)*/, '')
    .startsWith('[NEOX_');
}

export function realUserMessages<T extends { role: string; content: unknown }>(messages: readonly T[]): T[] {
  return messages.filter((m) => m.role === 'user' && !isControlPrompt(m.content));
}

export function estimatePostCompactContext(p: {
  postEstimate: number;
  preEstimate: number;
  realBefore: number;
  additiveOverhead: number;
  fixedBase: number | null;
}): number {
  const { postEstimate, preEstimate, realBefore, additiveOverhead, fixedBase } = p;
  if (fixedBase != null && Number.isFinite(fixedBase) && preEstimate > 0 && realBefore > fixedBase) {
    const ratio = Math.min(4, Math.max(1, (realBefore - fixedBase) / preEstimate));
    return Math.round(postEstimate * ratio + fixedBase);
  }
  return postEstimate + additiveOverhead;
}

export function buildInjectedUserMessage(
  text: string,
  images?: Array<{ mediaType: string; data: string; name?: string }>,
): Message {
  const content: MessageContentPart[] = [];

  if (text) content.push({ type: 'text', text });

  for (const img of images ?? []) {
    const raw = typeof img?.data === 'string' ? img.data : '';
    if (!raw) continue;
    const url = raw.startsWith('data:')
      ? raw
      : `data:${img.mediaType || 'image/png'};base64,${raw}`;
    content.push({ type: 'image_url', image_url: { url, detail: 'auto' } });
  }

  const only = content.length === 1 ? content[0] : null;
  return {
    role: 'user',
    content: only && only.type === 'text' ? only.text : content,
  };
}

/** AgentRuntimeHost.prepareTaskInput 的方法体 (不依赖 this), 原样挪出. */
export function prepareTaskInputText(userInput: string, metadata?: RuntimeMetadata): string {
    let result = userInput;

    /**  但是现在基本都是走的url 不包含图片 - 图片单独作为多模态内容处理 **/
    const urlAttachments = metadata?.attachments?.filter(att => att.type === 'url') || [];
    if (urlAttachments.length > 0) {
      const lines = urlAttachments.map((att, index) => `Attachment ${index + 1}: [URL: ${att.data}]`);
      result = `Attachments:\n${lines.join('\n')}\n\n${result}`;
    }

    /** 文档附件 — 两条路径:
     *
     * v2 (Files API 范式, 推荐): type='file' + att.fileId 非空 — 不塞全文进 prompt,
     *   只拼 metadata + 提示 agent 用 read_document 工具读. 多轮对话不重发, 省 token 99%+.
     *
     * 旧路径 (兼容): type='file' + data 非空 (无 fileId) — 用户拖纯文本 readAsText 读到内存,
     *   小文件直接拼 prompt. 历史会话 / NeoxCloud 解析降级时走这条.
     *
     * image 走 multimodal block (extractImageUrls), 跟这无关. */
    const fileAtts = (metadata?.attachments || []).filter(att => att.type === 'file');
    if (fileAtts.length > 0) {
      const docSections: string[] = [];
      for (const att of fileAtts) {
        const name = att.name || 'document';
        const fileId = (att as any).fileId;
        if (fileId && typeof fileId === 'string') {
          /* v2: file_id 引用 — agent 自己用 read_document(fileId) 按需读. */
          const chars = (att as any).chars;
          const pages = (att as any).pages;
          const channel = (att as any).channel;
          const meta = [
            chars ? `${chars} chars` : null,
            pages ? `${pages} pages` : null,
            channel ? `parsed via ${channel}` : null,
          ].filter(Boolean).join(', ');
          docSections.push(
            `[已上传文档: ${name}] (file_id=${fileId}${meta ? ', ' + meta : ''}) — call read_document with this file_id to read the full markdown content`,
          );
        } else if (typeof att.data === 'string' && att.data.length > 0) {
          /* 旧路径: 全文直接拼 */
          docSections.push(`[已上传文档: ${name}]\n\`\`\`\n${att.data}\n\`\`\``);
        }
      }
      if (docSections.length > 0) {
        result = `${result}\n\n${docSections.join('\n\n')}`;
      }
    }

    /** 问答模式 不执行tool！ 然后加上prompt **/
    if (metadata?.mode === 'ask') {
      result = `Mode: ASK (respond conversationally and avoid unnecessary tool calls).\n\n${result}`;
    }
    return result.trim();
}

/** 累加的正文末尾正好是作废的那段才撤; 对不上 (已被别的路径重置过) 就原样不动 */
export function dropDiscardedTail(text: string, discarded: string): string {
  return discarded && text.endsWith(discarded) ? text.slice(0, -discarded.length) : text;
}

export function runnerStreamRetryToUi(data: Record<string, any> | undefined, fullResponse: string) {
  const d = data || {};
  const discardedText = typeof d.discardedText === 'string' ? d.discardedText : '';
  return {
    fullResponse: dropDiscardedTail(fullResponse, discardedText),
    event: {
      type: 'stream_retry' as const,
      error: String(d.error ?? ''),
      errorCode: String(d.errorCode || 'STREAM_ERROR'),
      attempt: Number(d.attempt) || 1,
      maxRetries: Number(d.maxRetries) || 0,
      delayMs: Number(d.delayMs) || 0,
      isRateLimit: d.isRateLimit === true,
      isStreamTimeout: d.isStreamTimeout === true,
      isNetworkError: d.isNetworkError === true,
      discardedText,
      discardPartialToolCalls: d.discardPartialToolCalls === true,
    },
  };
}
