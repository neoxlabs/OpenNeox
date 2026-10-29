import { answerText, assert, assertAnyOf, runCheck, workdirFromArgv } from '../../lib/check-helpers.mjs';

runCheck(async () => {
  workdirFromArgv();
  const answer = answerText();
  assert(answer.trim().length > 40, '模型没有给出有效回答');

  // 顺序: auth 在 rateLimit 之前
  const authAt = answer.search(/auth/i);
  const limitAt = answer.search(/rateLimit|限流/i);
  assert(authAt >= 0 && limitAt >= 0, '没有同时提到 auth 与 rateLimit');
  assert(authAt < limitAt, '中间件顺序写错了: auth 应在 rateLimit 之前');
  assert(/server\.mjs/i.test(answer), '没有给出 server.mjs');

  assert(/401/.test(answer), '没有提到 401');
  assert(/TOKEN_MISSING/i.test(answer), '没有提到错误码 TOKEN_MISSING');
  assert(/auth\.mjs/i.test(answer), '没有给出 auth.mjs');

  assertAnyOf(answer, [/\b100\b/, /一百/], '限流上限 100');
  assertAnyOf(answer, [/60\s*[,.]?000\s*(?:ms|毫秒)?/i, /60\s*秒/, /1\s*分钟/, /一分钟/], '限流窗口 60 秒');
  assert(/429/.test(answer), '没有提到 429');

  assert(/500/.test(answer), '没有提到未预期错误返回 500');

  const citations = answer.match(/[A-Za-z0-9_.-]+\.mjs[:：]\s*\d+/g) ?? [];
  assert(citations.length >= 2, `至少要给 2 处「文件名:行号」引用, 实际 ${citations.length} 处`);
});
