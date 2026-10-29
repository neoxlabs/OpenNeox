
import type { Message } from '../../types/index.js';
import { getTextFromContent } from '../messageUtils.js';

/** 一节最多列多少份交付物 —— 再多会挤掉别的段。 */
const MAX_DELIVERABLES = 20;

/** 产出成品的工具: 真名 → 用户能看懂的说法。 */
const DELIVERABLE_TOOLS: Record<string, string> = {
  create_slides: '生成演示文稿',
  deck_export: '导出演示文稿',
  word_create: '生成 Word',
  word_export: '导出文件',
  word_to_pdf: '转 PDF',
  sheet_export_file: '导出表格',
  export_pdf: '导出 PDF',
  publish_page: '发布网页',
  render_video: '渲染视频',
};

/** 上屏工具 —— open_surface 不是"生产", 但它是「用户真正看到的那一份」的证据。 */
const SURFACE_TOOL = 'open_surface';

export interface DeliverableEntry {
  /** 文件路径 (或上屏目标), 已去重 */
  path: string;
  /** 生成它的工具 (用户看得懂的说法) */
  producedBy: string;
  /** 生成 / 导出次数 */
  producedCount: number;
  /** 被 open_surface 上屏的次数 */
  shownCount: number;
}

function parseArgs(raw: unknown): Record<string, any> | null {
  if (raw && typeof raw === 'object') return raw as Record<string, any>;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : null;
  } catch {
    return null;
  }
}

/** call_tool 动态派发: 真名和真参数都在入参里 (与 changedFilesDigest 同口径)。 */
function resolveCall(name: string, args: Record<string, any>): { name: string; args: Record<string, any> } {
  if (name.toLowerCase() !== 'call_tool') return { name: name.toLowerCase(), args };
  const realName = String(args.tool ?? args.name ?? args.tool_name ?? '').trim();
  const realArgs = parseArgs(args.args ?? args.arguments ?? args.input) ?? {};
  return { name: realName.toLowerCase(), args: realArgs };
}

/** 各工具的产物路径参数名不统一, 逐个认。 */
function deliverablePathOf(args: Record<string, any>): string | undefined {
  for (const key of ['outputPath', 'out_path', 'save_path', 'file_path', 'output_path', 'path', 'url']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/** open_surface 的目标: file 源取 path, inline 源没有文件就不算。 */
function surfaceTargetOf(args: Record<string, any>): string | undefined {
  const src = args.source;
  if (src && typeof src === 'object' && src.type === 'file' && typeof src.path === 'string' && src.path.trim()) {
    return src.path.trim();
  }
  return undefined;
}

/**
 * 从一段消息里按时间顺序收集交付物 (同一路径合并成一条)。
 * 返回顺序 = 首次出现的顺序 (即交付顺序)。
 */
export function collectDeliverables(messages: readonly Message[]): DeliverableEntry[] {
  const entries = new Map<string, DeliverableEntry>();

  const upsert = (filePath: string, toolLabel: string, isSurface: boolean): void => {
    const existing = entries.get(filePath);
    const next: DeliverableEntry = existing
      ? { ...existing }
      : { path: filePath, producedBy: toolLabel, producedCount: 0, shownCount: 0 };
    if (isSurface) next.shownCount += 1;
    else {
      next.producedCount += 1;
      /* 后发生的生成覆盖前面的说法 (例如 word_create 之后又 word_to_pdf) */
      next.producedBy = toolLabel;
    }
    entries.set(filePath, next);
  };

  for (const msg of messages) {
    if (!msg || msg.role !== 'assistant') continue;
    const calls = (msg as any).tool_calls;
    if (!Array.isArray(calls)) continue;

    for (const rawCall of calls) {
      const name = String(rawCall?.function?.name ?? '').trim();
      if (!name) continue;
      const args = parseArgs(rawCall?.function?.arguments);
      if (!args) continue;
      const call = resolveCall(name, args);

      if (call.name === SURFACE_TOOL) {
        const target = surfaceTargetOf(call.args);
        if (target) upsert(target, 'open_surface', true);
        continue;
      }
      const label = DELIVERABLE_TOOLS[call.name];
      if (!label) continue;
      const filePath = deliverablePathOf(call.args);
      if (!filePath) continue;
      upsert(filePath, label, false);
    }
  }

  return [...entries.values()].slice(0, MAX_DELIVERABLES);
}

function renderEntry(entry: DeliverableEntry): string {
  const bits: string[] = [];
  if (entry.producedCount > 0) bits.push(`${entry.producedBy} ${entry.producedCount} 次`);
  if (entry.shownCount > 0) bits.push(`开屏 ${entry.shownCount} 次`);
  if (bits.length === 0) bits.push('已交付');
  return `- \`${entry.path}\` — ${bits.join(' · ')}`;
}

/** 从摘要正文里取出 `### Deliverables` 那一节的行 (滚动压缩时携带旧记录)。 */
export function extractDeliverableLines(summaries: readonly Message[]): string[] {
  const lines: string[] = [];
  for (const msg of summaries) {
    const body = getTextFromContent((msg as any)?.content);
    if (!body) continue;
    let inSection = false;
    for (const line of body.split('\n')) {
      if (/^###\s+Deliverables\s*$/.test(line)) {
        inSection = true;
        continue;
      }
      if (inSection && /^###\s+/.test(line)) break;
      if (inSection && /^-\s+`/.test(line.trim())) lines.push(line.trim());
    }
  }
  return lines;
}

function pathFromLine(line: string): string | undefined {
  const m = line.match(/^-\s+`([^`]+)`/);
  return m ? m[1] : undefined;
}

/**
 * 渲染固定的交付物清单段。
 *
 *   路径相同 = 同一份交付物 (新记录覆盖旧记录), 所以滚动压缩之后不会出现
 *   「同一份 deck 列了两次」—— 这正是"用户拿到两个版本"的根源。
 *
 * @param entries 本次从消息里扫出的交付物 (按交付顺序)
 * @param priorLines 上一轮摘要里的清单行 (更早的交付, 只可能在这里)
 */
export function renderDeliverablesSection(
  entries: readonly DeliverableEntry[],
  priorLines: readonly string[] = [],
): string {
  const byPath = new Map<string, string>();
  for (const line of priorLines) {
    const p = pathFromLine(line);
    if (p) byPath.set(p, line);
  }
  for (const entry of entries) {
    byPath.set(entry.path, renderEntry(entry));
  }

  const lines = [...byPath.values()].slice(0, MAX_DELIVERABLES);
  if (lines.length === 0) lines.push('- (本轮还没有交付物)');
  return `### Deliverables\n${lines.join('\n')}`;
}

/** 摘要里是否已经带了一节 (供测试 / 调试断言用) */
export function hasDeliverablesSection(summaryText: string): boolean {
  return /^###\s+Deliverables\s*$/m.test(summaryText);
}
