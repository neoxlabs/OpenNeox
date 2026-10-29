export const SHEET_INTENT_RE = /\.(xlsx|xlsm|xls|csv)\b|excel|表格|名单|花名册|成绩单|报表|工作表/i;

export function promoteSheetIntent(
  engine: { promote: (names: string[]) => string[] },
  prompt: string,
  log?: (msg: string) => void,
): void {
  if (!SHEET_INTENT_RE.test(prompt)) return;
  const pre = engine.promote(['sheet_get_range', 'sheet_describe']);
  if (pre.length > 0) log?.(`意图预解锁 sheet: ${pre.join(', ')}`);
}
