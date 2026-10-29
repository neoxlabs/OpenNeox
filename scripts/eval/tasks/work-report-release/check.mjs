import * as fs from 'node:fs';
import {
  assert,
  assertAnyOf,
  findFile,
  runCheck,
  workdirFromArgv,
} from '../../lib/check-helpers.mjs';

runCheck(async () => {
  const workdir = workdirFromArgv();
  const reportPath = findFile(workdir, (name) => /^report\.md$/i.test(name), { maxDepth: 2 });
  assert(reportPath, '没有找到 REPORT.md');
  const report = fs.readFileSync(reportPath, 'utf8');
  assert(report.trim().length > 50, 'REPORT.md 内容太少');

  const headings = [
    ['版本', /^#{1,3}\s*版本/m],
    ['修复', /^#{1,3}\s*修复/m],
    ['风险', /^#{1,3}\s*风险/m],
    ['下一步', /^#{1,3}\s*下一步/m],
  ];
  const missing = headings.filter(([, re]) => !re.test(report)).map(([name]) => name);
  assert(missing.length === 0, `缺少小节: ${missing.join(', ')}`);

  assert(/2\.1\.0/.test(report), '缺少版本号 2.1.0');

  // 三项修复按事实判: 素材 (fixture/notes/commits.txt) 里的三条 fix 各自点名即可,
  const fixItems = [
    {
      name: 'slug 连续空格 / 重音字符处理',
      patterns: [
        /slug[^\n。]{0,24}(?:空格|空白|whitespace)/i,
        /(?:空格|空白)[^\n。]{0,24}slug/i,
        /重音|变音(?:符号)?|diacritic/i,
      ],
    },
    {
      name: '4xx 不再重试',
      patterns: [
        /4xx[^\n。]{0,24}(?:重试|retry)/i,
        /(?:重试|retry)[^\n。]{0,24}4xx/i,
        /4\d{2}[^\n。]{0,24}(?:重试|retry)/i,
      ],
    },
    {
      name: 'xlsx 合计行公式引用错行',
      patterns: [
        /(?:xlsx|excel|电子表格)[^\n。]{0,24}(?:合计|公式|错行)/i,
        /合计行/,
        /公式[^\n。]{0,24}(?:错行|引用[^\n。]{0,4}(?:错|错误)[^\n。]{0,2}行|行号错)/,
      ],
    },
  ];
  const missingFixes = fixItems
    .filter((item) => !item.patterns.some((re) => re.test(report)))
    .map((item) => item.name);
  assert(missingFixes.length === 0, `缺少修复项: ${missingFixes.join('; ')}`);

  assertAnyOf(
    report,
    [/(?:1|一)\s*[个条项]?\s*(?:破坏性|breaking)/i, /(?:破坏性|breaking)[^\n。]{0,12}(?:1|一)/],
    '1 个破坏性变更',
  );
  assert(/240/.test(report), '缺少 p95 的 240ms');
  assert(/180/.test(report), '缺少 p95 的 180ms');
  assert(/INC-2041/i.test(report), '缺少事故编号 INC-2041');
  assert(/连接池/.test(report), '缺少根因「连接池」');
  // 只要出现数量 12 即可, 不要求紧挨「回归测试」; 避免把 120 / 121 之类的数字算进来。
  assertAnyOf(report, [/(?:^|[^\d])12(?!\d)/, /十二/], '下周要补 12 个回归测试');
});
