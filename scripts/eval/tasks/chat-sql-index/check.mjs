import { answerText, assert, assertAnyOf, runCheck } from '../../lib/check-helpers.mjs';

runCheck(async () => {
  const answer = answerText();
  assert(answer.trim().length > 60, '模型没有给出有效回答');

  assertAnyOf(answer, [/最左前缀|最左匹配|最左原则/], '没有提到最左前缀');
  assertAnyOf(
    answer,
    [/(跳过|没有|缺少|不用)[^。\n]{0,12}(a|第一列|首列)/, /(b|第二列)[^。\n]{0,20}(无法|不能|失效|用不上|不走索引)/, /范围查询[^。\n]{0,20}(后续|后面|b|c)[^。\n]{0,12}(失效|用不上|不能)/],
    '没有说明不满足最左前缀时索引失效',
  );
  assert(/覆盖索引/.test(answer), '没有解释覆盖索引');
  assert(/回表/.test(answer), '没有解释回表');
  assertAnyOf(answer, [/索引[^。\n]{0,10}顺序/, /顺序[^。\n]{0,10}(重要|影响)/], '没有说明索引列顺序的影响');
});
