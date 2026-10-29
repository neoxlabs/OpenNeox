import { answerText, assert, assertAnyOf, runCheck } from '../../lib/check-helpers.mjs';

runCheck(async () => {
  const answer = answerText();
  assert(answer.trim().length > 30, '模型没有给出有效回答');
  assert(answer.replace(/\s+/g, '').length <= 400, '回答太长 (要求 200 字以内)');
  assertAnyOf(answer, [/三次/, /3\s*次/], '没有回答三次握手');
  assertAnyOf(
    answer,
    [/历史|旧|失效|重复|延迟|过期/],
    '没有提到「防止历史/失效的连接请求」这个原因',
  );
  assertAnyOf(
    answer,
    [/序列号|seq|isn/i, /(双方|双向|收发).{0,10}(能力|确认)/],
    '没有提到序列号同步或双方收发能力确认',
  );
});
