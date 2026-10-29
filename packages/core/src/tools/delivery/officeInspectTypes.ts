/**
 * officeInspectTypes — xlsx / docx 交付结构自检的公共类型与小工具 (work O-22)。
 *
 * 两种格式各写一个检查器 (sheet/xlsxInspect.ts、word/docxInspect.ts), 报告形状统一在这里,
 * 闸门 (officeDeliveryGate.ts) 与 open_surface 只认这一份结构。
 */

export type OfficeFormat = 'xlsx' | 'docx';

/**
 * 四类必拦问题 (方案 O-22 的验收口径) 在两种格式上的落点:
 *   · error_value    — xlsx: 单元格里是 #REF! / #VALUE! / #DIV/0! ... 或公式本身带 #REF!
 *   · empty_sheet    — xlsx: 空页 (整本没有一个非空格 / 多 sheet 里的空 sheet)
 *   · blank_page     — docx: 两个分页符之间没有任何内容 (打印出来就是一张白纸)
 *   · empty_document — docx: 正文完全为空
 *   · missing_image  — 引用了包里不存在的图片零件, 或外部图片文件已经没了
 *   · broken_link    — 超链接 / 外部链接指向的文件或内部锚点不存在
 *   · missing_part   — 包里该有的零件 (worksheet / drawing / 媒体) 缺了
 */
export type OfficeIssueKind =
  | 'error_value'
  | 'empty_sheet'
  | 'blank_page'
  | 'empty_document'
  | 'missing_image'
  | 'broken_link'
  | 'missing_part';

export interface OfficeIssue {
  /** error = 必须修, 交付闸门会拦; warn = 只提示, 不拦。 */
  severity: 'error' | 'warn';
  kind: OfficeIssueKind;
  /** 人能定位的位置: "Sheet1!B4" / "第 3 页" / "xl/drawings/drawing1.xml" */
  location: string;
  detail: string;
}

export interface OfficeInspectReport {
  ok: boolean;
  format: OfficeFormat;
  file: string;
  issues: OfficeIssue[];
  errorCount: number;
  warnCount: number;
  /** = errorCount: 闸门只对 error 拦 */
  mustFixCount: number;
  /** 各检查器自己填的计数 (sheet 数 / 段落数 / 图片数 ...), 只给人看 */
  stats: Record<string, number>;
}

export function finalizeReport(
  format: OfficeFormat,
  file: string,
  issues: OfficeIssue[],
  stats: Record<string, number> = {},
): OfficeInspectReport {
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warnCount = issues.length - errorCount;
  return {
    ok: errorCount === 0,
    format,
    file,
    issues,
    errorCount,
    warnCount,
    mustFixCount: errorCount,
    stats,
  };
}

export interface OfficeRelationship {
  id: string;
  type: string;
  target: string;
  targetMode?: string;
}

/** 解析 .rels XML (关系表)。解析不出来就返回空数组, 不抛。 */
export function parseRelationships(xml: string | null | undefined): OfficeRelationship[] {
  if (!xml) return [];
  const out: OfficeRelationship[] = [];
  for (const m of xml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const attrs: Record<string, string> = {};
    for (const a of m[0].matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1]] = a[2];
    if (!attrs.Id || !attrs.Target) continue;
    out.push({ id: attrs.Id, type: attrs.Type ?? '', target: attrs.Target, targetMode: attrs.TargetMode });
  }
  return out;
}

/** 包内相对 Target (相对 baseDir) → 包内绝对路径, 如 xl/drawings + ../media/a.png → xl/media/a.png */
export function resolvePartPath(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const stack = baseDir.split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') stack.pop();
    else stack.push(seg);
  }
  return stack.join('/');
}

/** 看起来是本地路径 (file:// 或没有 scheme 的相对/绝对路径) —— http(s)/mailto 之类不算。 */
export function isLocalLinkTarget(target: string): boolean {
  if (!target) return false;
  if (/^file:/i.test(target)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false;
  return true;
}
