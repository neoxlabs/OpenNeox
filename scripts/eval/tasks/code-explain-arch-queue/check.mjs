import { answerText, assert, assertAnyOf, runCheck, workdirFromArgv } from '../../lib/check-helpers.mjs';

runCheck(async () => {
  workdirFromArgv();
  const answer = answerText();
  assert(answer.trim().length > 40, '模型没有给出有效回答');

  assertAnyOf(answer, [/state\.json/i, /状态[^。\n]{0,20}json/i], '状态文件 .queue/state.json');
  assert(/store\.mjs/i.test(answer), '没有给出 store.mjs');
  assertAnyOf(answer, [/4\b/, /四/], '并发上限 4');
  assert(/MAX_CONCURRENCY/i.test(answer), '没有提到 MAX_CONCURRENCY');
  assertAnyOf(answer, [/\b3\b[^。\n]{0,10}(?:次|attempts?|尝试)/i, /(?:最多|总共|一共)[^。\n]{0,8}(?:3|三)\s*(?:次|尝试)/], '总共最多 3 次尝试');
  assertAnyOf(answer, [/500\s*(?:ms|毫秒)?/i], '第一次失败后应等 500ms');
  assertAnyOf(answer, [/1000\s*(?:ms|毫秒)?/i, /1\s*秒/, /2\s*\*\*|2\s*的\s*attempt\s*次方|指数退避/i], '第二次应等 1000ms/指数退避');
  assert(/runner\.mjs/i.test(answer), '没有给出 runner.mjs');

  const citations = answer.match(/[A-Za-z0-9_.-]+\.mjs[:：]\s*\d+/g) ?? [];
  assert(citations.length >= 2, `至少要给 2 处「文件名:行号」引用, 实际 ${citations.length} 处`);
});
