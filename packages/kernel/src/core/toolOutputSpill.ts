
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { takeUtf16SafeTail, truncateUtf16Safe } from '../utils/wireText.js';

/** 超过这个字符数的工具输出才考虑落盘（LOOP-14 的验收口径）。 */
export const TOOL_OUTPUT_SPILL_THRESHOLD_CHARS = 30_000;

/** 临时文件目录名（放在系统 tmp 下，随系统清理）。 */
export const TOOL_OUTPUT_SPILL_DIR_NAME = 'neox-tool-output';

/** 摘要里至少留给原文的字符数 —— 再小就不如直接走老的中段截断。 */
const MIN_HEAD_CHARS = 800;
/** 尾部保留比例与上限：错误/汇总行常在末尾。 */
const TAIL_SHARE = 0.15;
const MAX_TAIL_CHARS = 4_000;

const HEAD_LABEL = '--- 开头 ---';
const TAIL_LABEL = '--- 结尾 ---';

export interface SpillToolOutputOptions {
  toolName: string;
  /** 工具调用 id，只用于文件名，避免同秒同工具的两次输出互相覆盖。 */
  toolCallId?: string;
  content: string;
  /** 进上下文的总字符预算（含摘要头）。 */
  budgetChars: number;
  /** 落盘阈值，默认 TOOL_OUTPUT_SPILL_THRESHOLD_CHARS（测试可调）。 */
  thresholdChars?: number;
  /** 落盘目录，默认 <tmp>/neox-tool-output（测试注入）。 */
  dir?: string;
  /** 注入当前时间，默认 new Date()（测试固定文件名）。 */
  now?: Date;
}

export interface SpilledToolOutput {
  /** 进上下文的摘要文本（长度 ≤ budgetChars）。 */
  summary: string;
  /** 完整输出落盘的绝对路径。 */
  filePath: string;
  totalChars: number;
  totalLines: number;
}

function sanitizeSegment(raw: string): string {
  const cleaned = (raw || '').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 60);
  return cleaned || 'tool';
}

function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function stamp(now: Date): string {
  const p = (v: number, width = 2) => String(v).padStart(width, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${p(now.getMilliseconds(), 3)}`;
}

/**
 * 把超长工具输出写到临时文件，返回有界摘要。
 *
 * 返回 null 表示「不落盘」：没超阈值、预算太小、或写文件失败 —— 三种情况
 * 调用方都应退回原有的截断逻辑。
 */
export function spillToolOutput(options: SpillToolOutputOptions): SpilledToolOutput | null {
  const content = options.content ?? '';
  const threshold = options.thresholdChars ?? TOOL_OUTPUT_SPILL_THRESHOLD_CHARS;
  const budgetChars = Math.floor(options.budgetChars);

  if (content.length <= threshold) return null;
  /* 预算连「摘要头 + 一小段原文」都放不下时，落盘只会让模型拿到更少信息。 */
  if (!Number.isFinite(budgetChars) || budgetChars < MIN_HEAD_CHARS + 600) return null;

  const dir = options.dir ?? path.join(os.tmpdir(), TOOL_OUTPUT_SPILL_DIR_NAME);
  const fileName = `${stamp(options.now ?? new Date())}-${sanitizeSegment(options.toolName)}-${sanitizeSegment(options.toolCallId ?? 'call')}.txt`;
  const filePath = path.join(dir, fileName);

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    /* 0600: 工具输出可能含密钥 / 内网地址, 只给当前用户读。 */
    fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  } catch {
    return null;
  }

  const totalChars = content.length;
  const totalLines = content.split('\n').length;
  const header = [
    '[工具输出过大 · 完整结果已落盘]',
    `tool: ${options.toolName || 'unknown'} · ${formatCount(totalChars)} 字符 / ${formatCount(totalLines)} 行`,
    `file: ${filePath}`,
    '取法:',
    `- readfile ${JSON.stringify({ path: filePath, start_line: 1, num_lines: 500 })}  (按行分页读全文)`,
    `- execute_shell: grep -n "关键字" ${JSON.stringify(filePath)}  (只取需要的行)`,
  ].join('\n');

  /* 先按比例分头尾，再按真实开销回填 —— 摘要总长必须落在预算内，否则
   * 调用方还会再截一刀，路径提示可能正好被截掉。 */
  let tailChars = Math.min(MAX_TAIL_CHARS, Math.floor(budgetChars * TAIL_SHARE));
  const overhead = header.length + HEAD_LABEL.length + TAIL_LABEL.length + 8;
  let headChars = budgetChars - overhead - tailChars;
  if (headChars < MIN_HEAD_CHARS) {
    tailChars = 0;
    headChars = budgetChars - overhead;
  }
  if (headChars < MIN_HEAD_CHARS) return null;

  const head = truncateUtf16Safe(content, headChars);
  const tail = tailChars > 0 ? takeUtf16SafeTail(content, tailChars) : '';
  const parts = [header, HEAD_LABEL, head];
  if (tail) parts.push(TAIL_LABEL, tail);
  const summary = parts.join('\n');

  return { summary, filePath, totalChars, totalLines };
}
