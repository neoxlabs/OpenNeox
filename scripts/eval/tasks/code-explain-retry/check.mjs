import {
  answerText,
  assert,
  assertAnyOf,
  runCheck,
  workdirFromArgv,
} from '../../lib/check-helpers.mjs';

runCheck(async () => {
  workdirFromArgv();
  const answer = answerText();
  assert(answer.trim().length > 0, '模型没有输出任何回答 (可能超时或报错)');

  assertAnyOf(
    answer,
    [/(?:最多|总共|一共|上限)[^。\n]{0,12}(?:4|四)\s*(?:次|attempts?)/i, /(?:4|四)\s*(?:次|attempts?)[^。\n]{0,10}(?:尝试|重试|attempt)/i],
    '最大尝试次数 4',
  );
  assert(/NEOX_RETRY_BASE_MS/i.test(answer), '没有提到环境变量 NEOX_RETRY_BASE_MS');
  assert(/404/.test(answer), '没有提到 404');
  assertAnyOf(
    answer,
    [/(?:不重试|不会重试|不再重试|直接(?:抛出|失败|报错|返回)|no retry|not retr|immediately|give up)/i],
    '4xx 不重试的行为',
  );
  assert(/retry\.mjs/i.test(answer), '没有给出依据文件 retry.mjs');
  assert(/(?:retry\.mjs[:：]\s*\d+|retry\.mjs[^\n]{0,16}第?\s*\d+\s*行)/i.test(answer), '没有给出行号');
});
