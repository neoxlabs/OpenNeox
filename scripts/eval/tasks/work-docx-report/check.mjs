import * as fs from 'node:fs';
import * as path from 'node:path';
import { readDocx } from '../../lib/docx.mjs';
import { assert, assertAnyOf, runCheck, workdirFromArgv } from '../../lib/check-helpers.mjs';

runCheck(async () => {
  const workdir = workdirFromArgv();
  const file = path.join(workdir, 'out/q3-report.docx');
  assert(fs.existsSync(file), '没有生成 out/q3-report.docx');

  const { paragraphs, headings } = readDocx(file);
  const headingText = headings.map((h) => h.text).join('\n');
  for (const title of ['指标', '事故', '下一步']) {
    assert(headingText.includes(title), `缺少标题「${title}」 (现有标题: ${headings.map((h) => h.text).join(' / ') || '无'})`);
  }

  const text = paragraphs.map((p) => p.text).join('\n');
  assert(/128[,，]?400/.test(text), '正文没有写活跃用户 128,400');
  assertAnyOf(text, [/12\.5\s*%/, /12\.5/], '正文没有写环比 12.5%');
  assertAnyOf(text, [/3\.8\s*%/, /3\.8/], '正文没有写付费转化 3.8%');
  assert(/INC-?3312/i.test(text), '正文没有写事故编号 INC-3312');
  assert(/幂等/.test(text), '正文没有写根因「幂等键」');
  for (const item of ['对账', '灰度', '知识库']) {
    assert(text.includes(item), `下一步没有写「${item}」`);
  }

  const nonEmpty = paragraphs.filter((p) => p.text.trim().length > 0).length;
  assert(nonEmpty >= 7, `文档内容太少 (非空段落 ${nonEmpty} 个)`);
});
