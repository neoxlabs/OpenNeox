
import type { Row } from './timelineRows';
import {
  isThinkingRow,
  rowStepStatus,
  rowStepTitle,
  rowStepToTimelineStep,
} from './timelineRows';
import { splitPlainTitle } from './workProgress';
import type { StepContent } from './types';

/* ── 这一轮的真实凭据 ────────────────────────────────────────────────
 * 「凭据」= 工具结果里确实出现过的东西。回执里的数字 / 路径只能拿它来对。 */

export interface ReceiptNumber {
  /** 数字本身 (已把 万 / 亿 折成绝对值) */
  value: number;
  /** 原始写法, 例如 `412.6 万` / `3,180` */
  raw: string;
  /** 出处: 文件名 (有才给) */
  file?: string;
  /** 出处: 单元格 / 页码 (有才给) */
  cell?: string;
  /** 出处: 哪一步 (步骤标题的白话) */
  step?: string;
}

export interface ReceiptFailure {
  /** 步骤的白话标题 (「修改表格「周报」」), 已去掉堆栈 / 技术原文 */
  title: string;
  /** 动作 (「修改表格」) —— 数「试了几次」用 */
  verb: string;
  /** 对象 (「周报」) */
  obj: string;
  attempts: number;
}

export interface ReceiptEvidence {
  numbers: ReceiptNumber[];
  /** 这一轮工具结果里真实出现过的文件 (完整路径或标题里给的名字) */
  files: string[];
  failures: ReceiptFailure[];
  /** 证据是否完整 —— Work 模式把技术步骤的内容换成了白话, 常常是**有损**的:
   *  这时「没对上」不代表模型编了数, 只代表我们看不见, 所以不报「没找到出处」。 */
  complete: boolean;
  /** 这一轮是不是**以失败收尾** (最后一步就是失败的) —— 中途失败后又做成了不算 */
  endedInFailure: boolean;
}

/* ── 数字解析 ────────────────────────────────────────────────────────
 * 回执里的写法五花八门: 「412.6 万」「3,180」「+8.3%」「1.2 亿」。
 * 统一折成 { value, mult, decimals } 才能跟工具结果里的绝对数对得上。 */

export interface ParsedNumber {
  raw: string;
  /** 原始数值 (未乘单位), 例如 `412.6` */
  value: number;
  /** 单位倍数: 万=1e4 / 亿=1e8 / 千=1e3 / %=1 */
  mult: number;
  /** 原始数值的小数位数 —— 决定「412.6 万」的容差是 ±500 */
  decimals: number;
  /** 单位字符 (`万` / `%` / 空) */
  unit: string;
}

const UNIT_MULT: Record<string, number> = { 亿: 1e8, 万: 1e4, 千: 1e3 };

function maskDates(text: string): string {
  return text
    /* 版本号 / 型号 (「V4.1」「GPT-5.5」「iOS17.2」) 也不是业务数字 */
    .replace(/[A-Za-z]-?\d+(?:\.\d+)+/g, ' ')
    .replace(/\d{4}-\d{1,2}-\d{1,2}/g, ' ')
    .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ')
    .replace(/\d{4}\s*年\s*(\d{1,2}\s*月)?(\d{1,2}\s*日)?/g, ' ');
}

const NUMBER_TOKEN = /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(亿|万|千|%)?/g;

/** 文本 → 数字候选。只留「值得核对」的 (见 isKeyNumber)。 */
export function parseReceiptNumbers(text: string): ParsedNumber[] {
  if (!text) return [];
  const out: ParsedNumber[] = [];
  const seen = new Set<string>();
  const masked = maskDates(text);
  NUMBER_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUMBER_TOKEN.exec(masked))) {
    const rawNum = m[1]!.replace(/,/g, '');
    const unit = m[2] ?? '';
    const value = Number(rawNum);
    if (!Number.isFinite(value)) continue;
    const dot = rawNum.indexOf('.');
    const decimals = dot < 0 ? 0 : rawNum.length - dot - 1;
    const parsed: ParsedNumber = {
      raw: `${m[1]}${unit ? ` ${unit}` : ''}`,
      value,
      mult: UNIT_MULT[unit] ?? 1,
      decimals,
      unit,
    };
    if (!isKeyNumber(parsed)) continue;
    const key = `${parsed.value}|${parsed.mult}|${parsed.unit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }
  return out;
}

/** 小整数 (「3 页」「5 条」) 是计数不是业务数字, 核它只会制造假警报。 */
function isKeyNumber(n: ParsedNumber): boolean {
  if (n.unit === '万' || n.unit === '亿' || n.unit === '千' || n.unit === '%') return true;
  if (n.decimals > 0) return true;
  return Math.abs(n.value) >= 100;
}

/** 「412.6 万」的容差 = 0.5 × 1e4 × 1e-1 = 500 —— 按回执给出的精度对, 不按绝对值对。 */
function numberMatches(n: ParsedNumber, evidenceValue: number): boolean {
  const tol = Math.max(0.5 * n.mult * Math.pow(10, -n.decimals), 1e-9);
  const candidates = [n.value * n.mult];
  /* 百分比: 工具结果里可能存的是 0.083, 回执写 8.3% */
  if (n.unit === '%') candidates.push(n.value / 100);
  return candidates.some((v) => Math.abs(evidenceValue - v) <= tol + 1e-9);
}

/* ── 路径解析 ────────────────────────────────────────────────────────
 * 只认带交付物扩展名的路径 (回执里说「周报.xlsx」), 不认目录 / 代码文件。
 * 不含空格 —— 否则「文件名是 销售汇总.xlsx」会把前面的中文一起吞进来。 */
const RECEIPT_PATH = /[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5.\-/\\]*\.(pptx?|xlsx?|xlsm|csv|docx?|pdf|png|jpe?g|webp|gif|mp4|zip|md|txt)\b/gi;

export interface ParsedPath {
  raw: string;
  /** 小写文件名, 用来跟工具结果比 (回执只说名字, 工具结果里是完整路径) */
  base: string;
}

export function parseReceiptPaths(text: string): ParsedPath[] {
  if (!text) return [];
  const out: ParsedPath[] = [];
  const seen = new Set<string>();
  RECEIPT_PATH.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RECEIPT_PATH.exec(text))) {
    const raw = m[0]!.trim();
    const base = (raw.split(/[/\\]/).pop() ?? raw).toLowerCase();
    if (!base || seen.has(base)) continue;
    seen.add(base);
    out.push({ raw, base });
  }
  return out;
}

/* ── 从这一轮的 rows 里收集凭据 ─────────────────────────────────────── */

function basenameOf(p: string): string {
  return (p.split(/[/\\]/).pop() ?? p).trim();
}

/** 比文件名时把扩展名也去掉 —— 回执写「销售汇总.xlsx」, 标题里是「新建表格「销售汇总」」 */
function stemOf(p: string): string {
  return basenameOf(p).replace(/\.[A-Za-z0-9]{1,5}$/, '').toLowerCase();
}

function pushFile(files: string[], p: unknown): void {
  if (typeof p !== 'string') return;
  const s = p.trim();
  if (!s) return;
  if (!files.includes(s)) files.push(s);
}

/** 文本里出现过的数字 (工具输出 / 改动卡的数值) —— 只收绝对值, 不造出处 */
function collectNumbersFromText(text: string, into: ReceiptNumber[], extra: { file?: string; cell?: string; step?: string }): void {
  for (const n of parseReceiptNumbers(text)) {
    into.push({ value: n.value * n.mult, raw: n.raw, ...extra });
  }
}

/** 单元格地址 (A1 / B14 / AA3)。改动卡的 label 不一定是格子 —— 「填了 3 行」「加了一段」也在 label 里 */
const CELL_ADDR = /^[A-Z]{1,3}\d{1,5}$/i;

/** 这几类步骤本来就不带数字 (建/存/开/导), 它们看不见不算「证据不完整」 */
const NUMBERLESS_VERB = /^(新建|保存|打开|导出|Create|Save|Open|Export)/;

/** 改动卡 (Work 模式 sheet / word 的「改了什么」) —— 值是工具参数, 是真实写入的内容 */
function collectFromChange(content: Extract<StepContent, { type: 'change' }>, into: ReceiptNumber[], step: string, file?: string): void {
  for (const it of content.items) {
    if (!it.after) continue;
    const cell = it.label && CELL_ADDR.test(it.label.trim()) ? it.label.trim() : undefined;
    collectNumbersFromText(it.after, into, { step, file, ...(cell ? { cell } : {}) });
  }
}

/** 表格单元格 (legacy office) —— 有文件 + 格子, 是最好的出处 */
function collectFromOfficeSheet(content: Extract<StepContent, { type: 'office' }>, into: ReceiptNumber[], files: string[], step: string): void {
  if (content.kind !== 'sheet') return;
  const file = content.file?.trim() || undefined;
  if (file) pushFile(files, file);
  for (const c of content.cells) {
    collectNumbersFromText(c.value, into, { step, ...(file ? { file } : {}), ...(c.addr ? { cell: c.addr } : {}) });
  }
}

export function collectReceiptEvidence(rows: readonly Row[]): ReceiptEvidence {
  const numbers: ReceiptNumber[] = [];
  const files: string[] = [];
  const failedVerbs = new Map<string, { title: string; obj: string; attempts: number }>();
  const verbCounts = new Map<string, number>();
  let lossy = false;
  let lastStatus = '';
  let toolSteps = 0;

  const visit = (list: readonly Row[]): void => {
    for (const r of list) {
      if (r.kind === 'activity' || r.kind === 'turn_fold' || r.kind === 'work_progress') {
        visit(r.rows);
        continue;
      }
      if (r.kind === 'group' || r.kind === 'cluster') {
        for (const s of r.items) step(s);
        continue;
      }
      if (r.kind === 'single') step(r.step);
    }
  };

  const step = (s: Parameters<typeof rowStepTitle>[0]): void => {
    if (isThinkingRow({ kind: 'single', step: s } as Row)) return;
    const title = rowStepTitle(s).trim();
    if (!title) return;
    toolSteps += 1;
    const { verb, obj } = splitPlainTitle(title);
    if (verb) verbCounts.set(verb, (verbCounts.get(verb) ?? 0) + 1);

    /* 标题里的对象就是这一轮动过的产出 (「新建表格「销售汇总」」「写好「周报.xlsx」」)。
     * Work 模式把工具结果换成了白话, 文件路径本身不剩 —— 标题里的名字是唯一的线索,
     * 所以不管带不带扩展名都记下来, 比对时按「去掉扩展名的名字」比。 */
    if (obj) pushFile(files, obj);

    const content = rowStepToTimelineStep(s).content;
    /* Work 模式里技术步骤的内容被换成 none / log (原始结果不留), 这一轮看到的证据就**不完整**。
     * 不完整时不能报「没找到出处」—— 看不见不等于模型编的。
     * 但「新建 / 保存 / 打开 / 导出」这类步骤本来就不带数字, 它们看不见不影响核对,
     * 否则每一轮都有这几步, 「没找到出处」永远不会触发。 */
    if ((!content || content.type === 'none' || content.type === 'log') && !NUMBERLESS_VERB.test(title)) {
      lossy = true;
    }
    if (content) {
      switch (content.type) {
        case 'change':
          collectFromChange(content, numbers, title, obj || undefined);
          break;
        case 'office':
          if (content.kind === 'sheet') collectFromOfficeSheet(content, numbers, files, title);
          else {
            if (content.file) pushFile(files, content.file);
            for (const t of [content.before, content.after]) if (t) collectNumbersFromText(t, numbers, { step: title, ...(content.file ? { file: content.file } : {}) });
          }
          break;
        case 'diff':
          pushFile(files, content.file);
          break;
        case 'image':
          for (const p of content.paths) pushFile(files, p);
          break;
        case 'data': {
          for (const f of content.fields ?? []) collectNumbersFromText(f.v, numbers, { step: title });
          for (const rec of content.records ?? []) {
            for (const v of Object.values(rec ?? {})) {
              if (typeof v === 'number') numbers.push({ value: v, raw: String(v), step: title });
              else if (typeof v === 'string') collectNumbersFromText(v, numbers, { step: title });
            }
          }
          break;
        }
        case 'code':
          /* 通用文本输出 (sheet_get_range / word_get 的原始结果也走这里) —— 数字是真的从工具结果来的 */
          for (const line of content.lines) collectNumbersFromText(line.text, numbers, { step: title });
          break;
        case 'tool_card':
          /* 工具卡 (天气 / 日程 / MCP …) 的数都来自工具结果; 不收的话「周三 100% 降雨」会被报成没出处 (10-21) */
          collectNumbersFromText(JSON.stringify(content.card), numbers, { step: title });
          break;
        default:
          break;
      }
    }

    if (rowStepStatus(s) === 'failed' && verb) {
      const prev = failedVerbs.get(verb);
      if (!prev) failedVerbs.set(verb, { title, obj, attempts: 1 });
      else prev.attempts += 1;
    }
    lastStatus = rowStepStatus(s);
  };

  visit(rows);

  const failures: ReceiptFailure[] = [...failedVerbs.entries()].map(([verb, f]) => ({
    title: sanitizeFailureTitle(f.title),
    verb,
    obj: f.obj,
    attempts: verbCounts.get(verb) ?? f.attempts,
  }));

  /* 中途失败、后面又换个办法做成了 —— 那不是「失败回执」, 用户不需要知道。
   * 只有这一轮**最后一步**就是失败的, 才按失败三行收尾 (R-07)。 */
  return { numbers, files, failures, complete: !lossy && toolSteps > 0, endedInFailure: failures.length > 0 && lastStatus === 'failed' };
}

/**
 * 回执所属那一轮的行 —— 从这条消息往回数, 到上一条用户消息为止 (不含)。
 * 回执要对的是**这一轮**的工具结果, 不是整条会话。
 */
export function turnRowsBefore(rows: readonly Row[], index: number): Row[] {
  const out: Row[] = [];
  for (let i = index - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.kind === 'message' && r.message.role === 'user') break;
    out.push(r);
  }
  return out.reverse();
}

/* ── 回执对账 ──────────────────────────────────────────────────────── */

export interface CheckedNumber {
  raw: string;
  value: number;
  verified: boolean;
  /** 对上了就是它的出处 */
  source?: ReceiptNumber;
}

export interface CheckedPath {
  raw: string;
  verified: boolean;
  /** 工具结果里对上的那个文件 */
  matched?: string;
}

export interface ReceiptCheck {
  numbers: CheckedNumber[];
  paths: CheckedPath[];
}

export function checkReceipt(text: string, evidence: ReceiptEvidence): ReceiptCheck {
  const numbers: CheckedNumber[] = parseReceiptNumbers(text).map((n) => {
    const abs = n.value * n.mult;
    const source = evidence.numbers.find((e) => numberMatches(n, e.value));
    return { raw: n.raw, value: abs, verified: !!source, ...(source ? { source } : {}) };
  });
  const paths: CheckedPath[] = parseReceiptPaths(text).map((p) => {
    const stem = p.base.replace(/\.[A-Za-z0-9]{1,5}$/, '');
    const matched = evidence.files.find((f) => basenameOf(f).toLowerCase() === p.base || stemOf(f) === stem);
    return { raw: p.raw, verified: !!matched, ...(matched ? { matched } : {}) };
  });
  return { numbers, paths };
}

/* ── 失败回执三行 (R-07) ────────────────────────────────────────────
 * 「哪一步没过 / 我试了什么 / 建议你怎么走」。
 * 一律从结构里拼, 不贴堆栈、不贴原始报错 —— 用户看不懂也不需要看。 */

/** 把堆栈 / 异常原文从标题里剔掉 (正常标题里不会有, 兜的是模型把报错塞进标题的情况) */
export function sanitizeFailureTitle(title: string): string {
  const first = title.split(/\r?\n/)[0] ?? '';
  return first
    .replace(/\s+at\s+[\w$.<>]+.*$/, '')
    .replace(/^(Error|TypeError|RangeError|SyntaxError|Uncaught)\s*:\s*/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 80);
}

export interface FailureReceipt {
  /** 哪一步没过 */
  failedStep: string;
  /** 我试了什么 */
  tried: string;
  /** 建议你怎么走 */
  suggestion: string;
}

/** 建议按动作类别给 —— 用户要的是「我下一步做什么」, 不是错误码 */
function suggestionFor(verb: string, obj: string, zh: boolean): string {
  const s = `${verb} ${obj}`;
  if (/上网|网页|调研|搜|web|search|fetch/i.test(s)) {
    return zh ? '看看网络通不通, 或者让我换个说法再查一次' : 'Check the connection, or let me try the search again another way';
  }
  if (/表格|文档|演示稿|幻灯片|sheet|word|deck|slide/i.test(s)) {
    return zh ? '告诉我要改哪一处, 或者让我重试这一步' : 'Tell me which part to change, or let me retry this step';
  }
  if (/发消息|邮件|message|mail|send/i.test(s)) {
    return zh ? '确认收件人和内容后, 我再发一次' : 'Confirm the recipient and content, then I will send again';
  }
  return zh ? '告诉我换个做法, 或者让我重试这一步' : 'Tell me another way to do it, or let me retry this step';
}

export function buildFailureReceipt(evidence: ReceiptEvidence, zh: boolean): FailureReceipt | null {
  if (!evidence.endedInFailure) return null;
  const f = evidence.failures[evidence.failures.length - 1];
  if (!f) return null;
  const failedStep = f.obj ? `${f.verb}「${f.obj}」` : f.verb;
  const tried = f.attempts > 1
    ? (zh ? `试了 ${f.attempts} 次「${f.verb}」` : `tried “${f.verb}” ${f.attempts} times`)
    : (zh ? `试了一次「${f.verb}」` : `tried “${f.verb}” once`);
  return { failedStep, tried, suggestion: suggestionFor(f.verb, f.obj, zh) };
}

/* ── 给界面用的一层收口 ──────────────────────────────────────────────
 * 回执下面那几行提示: 默认什么都不说 (对得上就不吵), 对不上才说一句。
 * 失败时换成三行结构。 */

export interface ReceiptNote {
  /** 失败三行 (有失败才有) */
  failure: FailureReceipt | null;
  /** 核对上的关键数字 (带出处), 最多 3 条 */
  verifiedNumbers: Array<{ raw: string; source: ReceiptNumber }>;
  /** 对不上的数字 (回执说了但工具结果里没有) */
  unmatchedNumbers: string[];
  /** 对不上的文件 (回执说了但这一轮没产出) */
  unmatchedPaths: string[];
}

export const RECEIPT_MAX_VERIFIED = 3;
export const RECEIPT_MAX_UNMATCHED = 3;

export function buildReceiptNote(text: string, evidence: ReceiptEvidence, zh: boolean): ReceiptNote | null {
  const failure = buildFailureReceipt(evidence, zh);
  if (failure) return { failure, verifiedNumbers: [], unmatchedNumbers: [], unmatchedPaths: [] };

  const check = checkReceipt(text, evidence);
  /* 只报「能指到出处」的: 说「核对过」却不说是哪个文件哪一格, 用户没法自己核,
   * 反而像在替模型背书 (R-05: 关键数字必须带来源)。 */
  const verifiedNumbers = check.numbers
    .filter((n) => n.verified && n.source && (n.source.file || n.source.cell))
    .slice(0, RECEIPT_MAX_VERIFIED)
    .map((n) => ({ raw: n.raw, source: n.source! }));
  /* 证据有损时只说核对上的, 不说对不上的 —— 看不见 ≠ 编的 */
  const unmatchedNumbers = !evidence.complete
    ? []
    : check.numbers
      .filter((n) => !n.verified)
      .slice(0, RECEIPT_MAX_UNMATCHED)
      .map((n) => n.raw);
  const unmatchedPaths = !evidence.complete
    ? []
    : check.paths
      .filter((p) => !p.verified)
      .slice(0, RECEIPT_MAX_UNMATCHED)
      .map((p) => p.raw);

  if (verifiedNumbers.length === 0 && unmatchedNumbers.length === 0 && unmatchedPaths.length === 0) return null;
  return { failure: null, verifiedNumbers, unmatchedNumbers, unmatchedPaths };
}
