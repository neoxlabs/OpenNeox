/**
 * workReceipt — 回执校验 (work:R-02 / R-05 / R-07)
 *
 * 三条要验的事:
 *   · R-02 回执的措辞由模型写, 代码只把**数字和文件路径**拿去跟工具结果对账;
 *   · R-05 关键数字必须带出处 (文件 / 单元格), 对不上的要挑出来;
 *   · R-07 失败回执是固定的三行 (哪步没过 / 我试了什么 / 建议你怎么走), 不贴堆栈。
 */
import { describe, test, expect } from 'vitest';
import type { Row } from '../timelineRows';
import {
  buildFailureReceipt,
  buildReceiptNote,
  checkReceipt,
  collectReceiptEvidence,
  parseReceiptNumbers,
  parseReceiptPaths,
  sanitizeFailureTitle,
  turnRowsBefore,
} from '../workReceipt';

let idSeq = 0;
function step(title: string, content?: unknown, status = 'done'): Row {
  return {
    kind: 'single',
    step: { kind: 'tool', id: `t${++idSeq}`, title, status, iconKind: 'read', content },
  } as unknown as Row;
}
function msg(role: 'user' | 'assistant', text: string): Row {
  return { kind: 'message', message: { kind: 'message', id: `m${++idSeq}`, role, text } } as unknown as Row;
}

describe('parseReceiptNumbers — 只挑值得核对的数字', () => {
  test('万 / 亿 / 千 / 百分号 折成绝对值, 记住小数位数', () => {
    const [n] = parseReceiptNumbers('合计 412.6 万');
    expect(n).toMatchObject({ value: 412.6, mult: 1e4, decimals: 1, unit: '万' });
    const [y] = parseReceiptNumbers('营收 1.2 亿');
    expect(y!.value * y!.mult).toBeCloseTo(1.2e8);
    const [p] = parseReceiptNumbers('同比 +8.3%');
    expect(p).toMatchObject({ value: 8.3, unit: '%' });
  });

  test('千分位逗号认, 去掉逗号再算', () => {
    const [n] = parseReceiptNumbers('填了 3,180 个格子');
    expect(n!.value).toBe(3180);
  });

  test('小整数 (页数 / 条数) 不算关键数字, 不然天天假警报', () => {
    expect(parseReceiptNumbers('做了 3 页幻灯片, 改了 5 条')).toEqual([]);
  });

  test('日期和时刻里的数字不是业务数字', () => {
    expect(parseReceiptNumbers('2026-10-18 10:30 交的')).toEqual([]);
  });

  test('同一个数说两遍只算一次', () => {
    expect(parseReceiptNumbers('412.6 万, 也就是 412.6 万').length).toBe(1);
  });
});

describe('parseReceiptPaths', () => {
  test('认交付物文件, 不认目录 / 代码文件', () => {
    const paths = parseReceiptPaths('做好了 `周报.xlsx`, 放在 工作/2026-10 里; 脚本 build.mjs 没交给你');
    expect(paths.map((p) => p.base)).toEqual(['周报.xlsx']);
  });
});

describe('collectReceiptEvidence — 从这一轮的工具结果里取凭据', () => {
  test('改动卡里的数值带文件 + 单元格出处', () => {
    const ev = collectReceiptEvidence([
      step('修改表格「周报」', { type: 'change', items: [{ label: 'B14', after: '4126000' }] }),
    ]);
    expect(ev.numbers).toEqual([
      expect.objectContaining({ value: 4126000, file: '周报', cell: 'B14', step: '修改表格「周报」' }),
    ]);
  });

  test('表格 cell 内容带文件 + 格号', () => {
    const ev = collectReceiptEvidence([
      step('核对表格「周报」', {
        type: 'office', kind: 'sheet', file: '/w/周报.xlsx',
        cells: [{ addr: 'B14', value: '412.6万' }],
      }),
    ]);
    expect(ev.numbers[0]).toMatchObject({ value: 4126000, cell: 'B14', file: '/w/周报.xlsx' });
    expect(ev.files).toContain('/w/周报.xlsx');
  });

  test('diff / 图片的产物路径进 files', () => {
    const ev = collectReceiptEvidence([
      step('写好「周报.xlsx」', { type: 'diff', file: '/w/周报.xlsx', addCount: 1, delCount: 0, lines: [] }),
      step('画图', { type: 'image', paths: ['/w/封面.png'] }),
    ]);
    expect(ev.files).toEqual(expect.arrayContaining(['/w/周报.xlsx', '/w/封面.png', '周报.xlsx']));
  });

  test('失败步骤记进 failures, 同一个动作做了几次算 attempts', () => {
    const ev = collectReceiptEvidence([
      step('修改表格「周报」', { type: 'change', items: [] }, 'failed'),
      step('修改表格「周报」', { type: 'change', items: [] }, 'failed'),
    ]);
    expect(ev.failures).toEqual([
      expect.objectContaining({ verb: '修改表格', obj: '周报', attempts: 2 }),
    ]);
  });

  test('改动卡的 label 不是格子时不当成单元格出处 (「填了 3 行」)', () => {
    const ev = collectReceiptEvidence([
      step('往表格里填数据', { type: 'change', items: [{ label: '填了 3 行', after: '一月 · 100' }] }),
    ]);
    expect(ev.numbers[0]).toMatchObject({ value: 100 });
    expect(ev.numbers[0]!.cell).toBeUndefined();
  });

  test('Work 模式技术步骤被换成 none → 证据有损, 不报对不上', () => {
    const ev = collectReceiptEvidence([
      step('新建表格「销售汇总」', { type: 'none' }),
      step('往表格里填数据', { type: 'change', items: [{ label: '填了 3 行', after: '一月 · 100' }] }),
    ]);
    /* 新建 / 保存这类步骤本来不带数字, 不算「看不见」 */
    expect(ev.complete).toBe(true);

    const evLossy = collectReceiptEvidence([
      step('核对表格「销售汇总」', { type: 'none' }),
      step('往表格里填数据', { type: 'change', items: [{ label: '填了 3 行', after: '一月 · 100' }] }),
    ]);
    expect(evLossy.complete).toBe(false);
    /* 什么都核不了就不打扰 —— 旁注整块不出 (null) */
    expect(buildReceiptNote('合计 300', evLossy, true)).toBeNull();
  });

  test('证据完整时, 对不上的数字照实挑出来', () => {
    const ev = collectReceiptEvidence([
      step('新建表格「销售汇总」', { type: 'none' }),
      step('修改表格「销售汇总」', { type: 'change', items: [{ label: 'B3', after: '350' }] }),
    ]);
    const note = buildReceiptNote('B3 现在是 800', ev, true)!;
    expect(note.unmatchedNumbers).toEqual(['800']);
  });

  test('标题里的产出名也算文件 (销售汇总 vs 销售汇总.xlsx)', () => {
    const ev = collectReceiptEvidence([step('新建表格「销售汇总」', { type: 'none' })]);
    const r = checkReceipt('做好了 销售汇总.xlsx', ev);
    expect(r.paths[0]!.verified).toBe(true);
  });
});

describe('checkReceipt — 回执里的数字 / 路径对账 (R-02 / R-05)', () => {
  const ev = collectReceiptEvidence([
    step('修改表格「周报」', { type: 'change', items: [{ label: 'B14', after: '4126000' }] }),
    step('写好「周报.xlsx」', { type: 'diff', file: '/w/周报.xlsx', addCount: 1, delCount: 0, lines: [] }),
  ]);

  test('412.6 万 对得上 4126000, 带出处', () => {
    const r = checkReceipt('合计 412.6 万', ev);
    expect(r.numbers[0]).toMatchObject({ raw: '412.6 万', verified: true });
    expect(r.numbers[0]!.source).toMatchObject({ value: 4126000, cell: 'B14' });
  });

  test('按回执给的精度对 —— 412.6 万 容得下 4126123', () => {
    const ev2 = collectReceiptEvidence([
      step('修改表格「周报」', { type: 'change', items: [{ label: 'B14', after: '4126123' }] }),
    ]);
    expect(checkReceipt('合计 412.6 万', ev2).numbers[0]!.verified).toBe(true);
    /* 但差得远的不算对上 */
    expect(checkReceipt('合计 431.2 万', ev2).numbers[0]!.verified).toBe(false);
  });

  test('工具结果里没有的数字标成没出处', () => {
    const r = checkReceipt('合计 412.6 万, 比上月 +8.3%', ev);
    const pct = r.numbers.find((n) => n.raw.includes('%'))!;
    expect(pct.verified).toBe(false);
  });

  test('百分比: 工具结果存 0.083 也算 8.3% 对得上', () => {
    const ev2 = collectReceiptEvidence([
      step('核对表格「周报」', { type: 'office', kind: 'sheet', file: '/w/周报.xlsx', cells: [{ addr: 'C1', value: '0.083' }] }),
    ]);
    expect(checkReceipt('同比 +8.3%', ev2).numbers[0]!.verified).toBe(true);
  });

  test('文件路径按文件名对; 没产出的文件标成没对上', () => {
    const r = checkReceipt('做好了 `周报.xlsx`, 旧稿 `上周.xlsx` 也更新了', ev);
    expect(r.paths.find((p) => p.raw.includes('周报'))!.verified).toBe(true);
    expect(r.paths.find((p) => p.raw.includes('上周'))!.verified).toBe(false);
  });
});

describe('失败回执三行 (R-07)', () => {
  const ev = collectReceiptEvidence([
    step('修改表格「周报」', { type: 'change', items: [] }, 'failed'),
    step('修改表格「周报」', { type: 'change', items: [] }, 'failed'),
  ]);

  test('哪步没过 / 我试了什么 / 建议怎么走', () => {
    const f = buildFailureReceipt(ev, true)!;
    expect(f.failedStep).toBe('修改表格「周报」');
    expect(f.tried).toBe('试了 2 次「修改表格」');
    expect(f.suggestion).toContain('告诉我要改哪一处');
  });

  test('英文版也有三行', () => {
    const f = buildFailureReceipt(ev, false)!;
    expect(f.tried).toContain('2 times');
    expect(f.suggestion.length).toBeGreaterThan(0);
  });

  test('没有失败就没有失败回执', () => {
    expect(buildFailureReceipt(collectReceiptEvidence([step('修改表格「周报」', { type: 'change', items: [] })]), true)).toBeNull();
  });

  test('中途失败后又换个办法做成了 —— 不算失败回执', () => {
    const ev = collectReceiptEvidence([
      step('修改表格「周报」', { type: 'change', items: [] }, 'failed'),
      step('修改表格「周报」', { type: 'change', items: [{ label: 'B14', after: '4126000' }] }),
    ]);
    expect(ev.endedInFailure).toBe(false);
    expect(buildFailureReceipt(ev, true)).toBeNull();
  });

  test('堆栈和异常前缀从标题里剔掉 —— 无堆栈直出', () => {
    expect(sanitizeFailureTitle('生成演示稿\n    at foo (bar.js:1:2)')).toBe('生成演示稿');
    expect(sanitizeFailureTitle('Error: boom')).toBe('boom');
  });
});

describe('buildReceiptNote — 界面那一层', () => {
  const ev = collectReceiptEvidence([
    step('修改表格「周报」', { type: 'change', items: [{ label: 'B14', after: '4126000' }] }),
  ]);

  test('对得上的数字连出处给出来', () => {
    const note = buildReceiptNote('合计 412.6 万', ev, true)!;
    expect(note.verifiedNumbers).toEqual([expect.objectContaining({ raw: '412.6 万' })]);
    expect(note.verifiedNumbers[0]!.source.cell).toBe('B14');
  });

  test('对不上的挑出来', () => {
    const note = buildReceiptNote('合计 999.9 万', ev, true)!;
    expect(note.unmatchedNumbers).toEqual(['999.9 万']);
  });

  test('一步工具都没调 (自我介绍) 不报「没找到出处」; 版本号不算业务数字', () => {
    expect(buildReceiptNote('我是工作 Agent, 跑在 2.6 版上', collectReceiptEvidence([]), true)).toBeNull();
    expect(parseReceiptNumbers('模型 DeepSeek V4.1 / GPT-5.5')).toEqual([]);
  });

  test('没什么可说的就不打扰 (返回 null)', () => {
    expect(buildReceiptNote('做好了。', ev, true)).toBeNull();
  });

  test('有失败时只出三行, 不再啰嗦数字', () => {
    const evFail = collectReceiptEvidence([step('修改表格「周报」', { type: 'change', items: [] }, 'failed')]);
    const note = buildReceiptNote('出错了', evFail, true)!;
    expect(note.failure!.failedStep).toBe('修改表格「周报」');
    expect(note.verifiedNumbers).toEqual([]);
    expect(note.unmatchedNumbers).toEqual([]);
  });
});

describe('turnRowsBefore — 只取这一轮', () => {
  test('从回执往回数到上一条用户消息为止', () => {
    const rows = [
      msg('user', '上一轮'),
      step('修改表格「上周」'),
      msg('assistant', '上一轮结论'),
      msg('user', '这一轮'),
      step('修改表格「周报」'),
      msg('assistant', '这一轮结论'),
    ];
    const turn = turnRowsBefore(rows, 5);
    /* 只到这一条用户消息为止: 上一轮的结论 / 步骤都不能混进来 */
    expect(turn).toEqual([rows[4]]);
  });
});
