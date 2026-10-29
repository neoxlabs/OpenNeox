import { answerText, assert, assertAnyOf, runCheck } from '../../lib/check-helpers.mjs';

runCheck(async () => {
  const answer = answerText();
  assert(answer.trim().length > 60, '模型没有给出有效回答');

  assertAnyOf(answer, [/合并提交|merge commit|保留.{0,8}(分叉|分支历史|历史)/], '没有说明 merge 会保留分叉/产生合并提交');
  assertAnyOf(answer, [/重写|改写|变基|重建.{0,6}提交|新的?\s*(hash|哈希|提交)/i], '没有说明 rebase 会重写历史/生成新提交');
  assertAnyOf(
    answer,
    [/(已推送|推送过|公共分支|共享分支|远程分支)[^。\n]{0,30}(不要|避免|别|禁止|慎用|风险)/, /(不要|避免|别)[^。\n]{0,20}(已推送|公共分支|共享分支)/, /强推|force[- ]?push/i],
    '没有说明 rebase 已推送/公共分支的风险',
  );
});
