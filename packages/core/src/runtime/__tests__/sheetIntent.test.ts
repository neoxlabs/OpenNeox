import { describe, expect, test } from 'vitest';
import { promoteSheetIntent, SHEET_INTENT_RE } from '../sheetIntent';

describe('表格意图预解锁 (10-21 名单抄错)', () => {
  test('名单 / Excel / 附件 xlsx 命中; 普通话不命中', () => {
    for (const s of ['这是教室照片和学生名单', '帮我整理这个 Excel', '初二(3)班学生名单.xlsx', '看下成绩单', 'data.csv 里的数据']) {
      expect(SHEET_INTENT_RE.test(s)).toBe(true);
    }
    for (const s of ['帮我写个周报', '做个 PPT', '修一下登录 bug']) expect(SHEET_INTENT_RE.test(s)).toBe(false);
  });
  test('命中时把 sheet_get_range / sheet_describe 放到手边', () => {
    const got: string[][] = [];
    promoteSheetIntent({ promote: (n) => { got.push(n); return n; } }, '学生名单在附件里');
    expect(got).toEqual([['sheet_get_range', 'sheet_describe']]);
  });
});
