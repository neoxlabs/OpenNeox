/* 大 Markdown 分块渲染的切分规划 (S-05)。
 *
 * 现状: DocSurfaceViewer 等到整份内容读回来后, 一次性交给 react-markdown 解析
 * 几 MB 正文 —— 首屏内容要等全量解析 + 全量 DOM, 长文档能白好几秒。
 *
 * 做法: 复用流式渲染那套 splitMarkdownBlocks (它保证 blocks.join('') === md,
 * 且只在安全的顶层空行切), 先渲染第一块 (足够填满首屏), 其余块按空闲片追加。
 *
 * 本文件只做规划 (纯函数), 渲染进度由 ProgressiveMarkdown.tsx 控制。
 */

import { splitMarkdownBlocks } from '../../../../components/markdownBlocks';

/** 低于这个长度不分块 —— 普通文档保持原来的单次渲染, 行为完全不变。 */
export const MARKDOWN_CHUNK_THRESHOLD = 300_000;
/** 首块预算: 够铺满首屏, 又能在几十毫秒内解析完。 */
export const FIRST_CHUNK_CHARS = 20_000;
/** 后续每块的预算: 一次空闲片里解析这么多, 不阻塞交互。 */
export const NEXT_CHUNK_CHARS = 180_000;

export function shouldChunkMarkdown(content: string): boolean {
  return typeof content === 'string' && content.length > MARKDOWN_CHUNK_THRESHOLD;
}

/**
 * 把正文切成若干块, 保证 chunks.join('') === content (逐字不变)。
 * 单块本身就超过预算时不再强行切 (切了会改变渲染结果), 它独占一块。
 */
export function planMarkdownChunks(
  content: string,
  opts: { firstChunkChars?: number; nextChunkChars?: number } = {},
): string[] {
  if (!content) return [];
  if (!shouldChunkMarkdown(content)) return [content];

  const firstBudget = opts.firstChunkChars ?? FIRST_CHUNK_CHARS;
  const nextBudget = opts.nextChunkChars ?? NEXT_CHUNK_CHARS;
  const blocks = splitMarkdownBlocks(content);
  /* splitMarkdownBlocks 遇到脚注/引用式定义会整条退回一块 —— 那就老实单块渲染。 */
  if (blocks.length <= 1) return [content];

  const chunks: string[] = [];
  let current = '';
  let budget = firstBudget;
  for (const block of blocks) {
    if (current && current.length + block.length > budget) {
      chunks.push(current);
      current = '';
      budget = nextBudget;
    }
    current += block;
  }
  if (current) chunks.push(current);
  return chunks;
}
