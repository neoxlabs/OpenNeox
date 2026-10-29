/**
 * work:H-19 · 工具结果瘦身 (inspect / describe)。
 *
 * 事故形状: 一次自检把整份 inspect JSON (几十上百条 issue, 每条带长 message / shape 矩形)
 * 灌回给模型, 模型反而漏掉里面那 3 条 mustFix —— 信息越多, 注意力越散。
 *
 * 这里的口径:
 *   · 每个 issue 压成一行 `[定位] 问题`, **定位不许丢** (slide / location / index), 修的时候要能点到具体页;
 *   · 总字符数守住 `MAX_REPORT_CHARS` (1.5K, 方案验收线), 超了就按「mustFix 优先、再按原文顺序」截;
 *   · 截了必须**说清楚截了多少**, 并告诉模型怎么拿被截掉的部分 —— 静默截断会让模型以为改完了;
 *   · 不覆盖 mustFix (error) 条数: 预算再紧, 至少保留前几条 error, 剩下的只报计数。
 *
 * 只做「压缩 + 兜底」, 不做判定: 哪些算必须修由各格式自己的 inspect 决定。
 */

/** 方案验收线: inspect / describe 回给模型的正文不超过 1.5K 字符。 */
export const MAX_REPORT_CHARS = 1500;

export interface SizedIssue {
  /** 定位用的最短标识: "第 3 页" / "Sheet1!B4" / "index=2" */
  where: string;
  /** 问题本身, 一句话。 */
  text: string;
}

export interface CompactReportOptions {
  /** 总预算 (字符)。默认 MAX_REPORT_CHARS。 */
  maxChars?: number;
  /** 单条 issue 截断长度 (字符), 防止一条超长 message 吃掉整个预算。 */
  maxIssueChars?: number;
}

export interface CompactReport {
  /** 压好的 issue 行 (每条形如 "- [第 3 页] 标题文字溢出") */
  lines: string[];
  /** 实际塞进预算的条数 */
  shown: number;
  /** 因为预算没塞进去的条数 */
  dropped: number;
  /** 这部分渲染出来的字符数 (lines + 截断说明) */
  chars: number;
}

/** 单条 issue 压成一行 —— 定位在最前, 模型扫一眼就能点到页。 */
export function formatIssueLine(issue: SizedIssue, maxIssueChars = 160): string {
  const where = issue.where?.trim() || '(未标明位置)';
  let text = (issue.text || '').replace(/\s+/g, ' ').trim();
  if (!text) text = '(无描述)';
  if (text.length > maxIssueChars) text = text.slice(0, maxIssueChars - 1) + '…';
  return `- [${where}] ${text}`;
}

/**
 * 把 issue 列表压进预算。
 *
 * 优先级: 调用方已经按重要度排序 (mustFix 在前) —— 这里保持顺序, 顺序就是优先级。
 * 至少保留 `minKeep` 条 (只要列表非空), 否则预算一紧就一条都不给, 模型没有可修的东西。
 */
export function compactIssues(
  issues: SizedIssue[],
  options: CompactReportOptions & { minKeep?: number; limit?: number } = {},
): CompactReport {
  const maxChars = options.maxChars ?? MAX_REPORT_CHARS;
  const minKeep = options.minKeep ?? 1;
  /* limit = 最多从前面取几条参与挑选; dropped 仍按**全量**算, 不然截断了却报 0 条。 */
  const candidates = options.limit != null ? issues.slice(0, Math.max(0, options.limit)) : issues;
  const lines: string[] = [];
  let used = 0;
  for (const issue of candidates) {
    const line = formatIssueLine(issue, options.maxIssueChars);
    const cost = line.length + 1; /* +1 = 换行 */
    const roomForRest = issues.length - lines.length - 1;
    const reserve = roomForRest > 0 ? 40 : 0; /* 给「还有 N 条」留一行 */
    if (lines.length >= minKeep && used + cost + reserve > maxChars) break;
    lines.push(line);
    used += cost;
  }
  const dropped = issues.length - lines.length;
  if (dropped > 0) {
    const tail = `- …还有 ${dropped} 条未列出 (定位相同格式, 用对应 inspect 工具按页查)`;
    lines.push(tail);
    used += tail.length + 1;
  }
  return { lines, shown: issues.length - dropped, dropped, chars: used };
}

/**
 * 把 issue 清单装进**整个工具返回**的 1.5K 预算里。
 *
 *   只给 issue 留预算是不够的: error / next / path 这些固定字段也要占字符,
 *   各出口的固定文案长短不一。这里按真实序列化长度迭代 (issue 数量不大, 线性即可),
 *   直到整个返回 ≤ maxChars。
 *
 * @param build 把 issue 行放进返回体的真实位置, 返回完整 payload
 */
export function fitIssueLinesIntoPayload(
  build: (lines: string[]) => Record<string, unknown>,
  issues: SizedIssue[],
  options: CompactReportOptions & { minKeep?: number } = {},
): { payload: Record<string, unknown>; json: string; shown: number; dropped: number; chars: number } {
  const maxChars = options.maxChars ?? MAX_REPORT_CHARS;
  const minKeep = Math.min(options.minKeep ?? 1, issues.length);

  let best: { payload: Record<string, unknown>; json: string; shown: number; dropped: number } | null = null;
  /* 从多到少试: 第一个能装下的就是信息最多的那个 */
  for (let limit = issues.length; limit >= minKeep; limit--) {
    const compact = compactIssues(issues, { ...options, limit, minKeep });
    const payload = build(compact.lines);
    const json = JSON.stringify(payload);
    if (json.length <= maxChars) {
      best = { payload, json, shown: compact.shown, dropped: compact.dropped };
      break;
    }
  }

  if (!best) {
    /* 连 minKeep 条都装不下 —— 只报计数, 不能再灌细节 */
    const payload = build([]);
    payload.issuesOmitted = issues.length;
    payload.note = `问题清单 ${issues.length} 条太长, 已省略明细; 用对应 inspect 工具按页 / 按区域查。`;
    const json = JSON.stringify(payload);
    return { payload, json, shown: 0, dropped: issues.length, chars: json.length };
  }

  return { ...best, chars: best.json.length };
}

/**
 * describe 类结果 (纯计数字段) 的兜底: 超过预算就只留最关键的字段。
 *
 *   describe 本来就是「结构概览」, 真超预算只可能是 sheet 数量极多 (几十个 sheet);
 *   这时按名字截断并写清总数, 比整段 JSON 灌进去有用。
 */
export function compactDescribeJson(
  payload: Record<string, unknown>,
  options: CompactReportOptions = {},
): string {
  const maxChars = options.maxChars ?? MAX_REPORT_CHARS;
  const full = JSON.stringify(payload);
  if (full.length <= maxChars) return full;

  const trimmed: Record<string, unknown> = { ...payload };
  const sheets = trimmed.sheets;
  if (Array.isArray(sheets)) {
    const room = Math.max(1, Math.floor((maxChars - JSON.stringify({ ...trimmed, sheets: [] }).length) / 90));
    if (sheets.length > room) {
      trimmed.sheets = sheets.slice(0, room);
      trimmed.sheets_omitted = sheets.length - room;
      trimmed.note = `只列出前 ${room} 个 sheet; 其余 ${sheets.length - room} 个用 sheet_get_range 按名字直取。`;
    }
  }
  const out = JSON.stringify(trimmed);
  if (out.length <= maxChars) return out;
  /* 还是超 (单个 sheet 名字就巨长 / 字段过多) —— 只留计数, 别灌整段 */
  return JSON.stringify({
    source: payload.source,
    total_sheets: payload.total_sheets,
    mtime_ms: payload.mtime_ms,
    note: `结构概览过长已省略明细 (${full.length} 字符), 请按需用 sheet_describe 指定 workbook / sheet_get_range 取。`,
  });
}

/* ============================================================
 * 各格式的 issue → SizedIssue 适配 (定位字段一个都不丢)
 * ============================================================ */

interface PptxLikeIssue {
  slide?: number;
  severity: 'error' | 'warn';
  kind: string;
  message: string;
  shape?: { name?: string | null; id?: string | null };
}

/** pptx inspect issue → 一行。定位 = 第 N 页 (+ shape 名, 有就带上, 方便定位到框) */
export function pptxIssueToSized(issue: PptxLikeIssue, opts: { outlineIndex?: number; slideTitle?: string } = {}): SizedIssue {
  const parts: string[] = [];
  if (opts.outlineIndex != null) parts.push(`index=${opts.outlineIndex}`);
  if (issue.slide != null) parts.push(`第 ${issue.slide} 页`);
  if (opts.slideTitle) parts.push(`「${String(opts.slideTitle).slice(0, 20)}」`);
  if (issue.shape?.name) parts.push(`形状「${issue.shape.name}」`);
  return {
    where: parts.join(' '),
    text: `${issue.kind}: ${issue.message}`,
  };
}

interface OfficeLikeIssue {
  severity: 'error' | 'warn';
  kind: string;
  location: string;
  detail: string;
}

/** xlsx / docx inspect issue → 一行。定位 = "Sheet1!B4" / "第 3 页" (检查器已经填好) */
export function officeIssueToSized(issue: OfficeLikeIssue): SizedIssue {
  return { where: issue.location, text: `${issue.kind}: ${issue.detail}` };
}
