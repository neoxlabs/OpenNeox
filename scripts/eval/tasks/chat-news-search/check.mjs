import { answerText, assert, assertAnyOf, runCheck } from '../../lib/check-helpers.mjs';
import { calledTools } from '../../lib/session-log.mjs';

runCheck(async () => {
  const answer = answerText();
  assert(answer.trim().length > 80, '模型没有给出有效回答');

  const tools = await calledTools(process.env.BENCH_DB_PATH);
  assert(tools.has('web_search'), `没有调用联网搜索工具 (本次调用的工具: ${[...tools].join(', ') || '无'})`);

  const urls = [...new Set((answer.match(/https?:\/\/[^\s)\]<>"']+/g) ?? []).map((u) => u.replace(/[.,;]+$/, '')))];
  assert(urls.length >= 3, `至少要给 3 条来源链接, 实际 ${urls.length} 条`);
  const domains = new Set(urls.map((u) => {
    try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
  }).filter(Boolean));
  assert(domains.size >= 2, `来源太单一, 至少来自 2 个网站 (实际 ${[...domains].join(', ')})`);

  assertAnyOf(
    answer,
    [/2026[-/年]\s*1?0[-/月]\s*\d{1,2}/, /\d{1,2}\s*月\s*\d{1,2}\s*日/, /最近一周|本周/],
    '没有给出发布日期',
  );
});
