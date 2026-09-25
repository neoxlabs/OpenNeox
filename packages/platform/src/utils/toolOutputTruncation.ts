/**
 * Tool Output Truncation — platform facade.
 *
 * 实现已收口到 `@neoxlabs/kernel/utils/toolOutputTruncation` (Neox Wire Text).
 * 本文件只做 re-export, 保持历史 import 路径不断.
 */

export {
  TOOL_OUTPUT_MAX_BYTES,
  ANTHROPIC_TOOL_OUTPUT_MAX_BYTES,
  REQUEST_BODY_MAX_BYTES,
  REQUEST_BODY_WARNING_THRESHOLD,
  truncateToolOutput,
  needsTruncation,
  getTruncationStats,
  estimateObjectSize,
  formatResponseHeaders,
} from '@neoxlabs/kernel/utils/toolOutputTruncation.js';
