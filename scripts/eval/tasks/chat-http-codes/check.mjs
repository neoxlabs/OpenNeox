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
  assert(answer.trim().length > 20, '模型没有给出有效回答');

  for (const code of ['301', '302', '307', '308']) {
    assert(new RegExp(code).test(answer), `没有提到状态码 ${code}`);
  }

  assertAnyOf(answer, [/永久|permanent/i], '301/308 的永久性');
  assertAnyOf(answer, [/临时|temporary/i], '302/307 的临时性');

  assertAnyOf(answer, [/(?:307|308)[^。\n]{0,40}(?:方法|method)/i, /(?:方法|method)[^。\n]{0,40}(?:307|308)/i], '307/308 与方法的关系');
  assertAnyOf(answer, [/不变|保持|保留|原样|same|retain|preserve|keep/i], '方法保持不变的结论');

  // 差异的本质: 301/302 历史上会把 POST 改成 GET
  assertAnyOf(
    answer,
    [/(?:GET|POST)[\s\S]{0,90}(?:改|变|转换|变成|change|convert)/i, /(?:方法|method)[\s\S]{0,70}(?:改|变|change)/i],
    '301/302 会改变请求方法',
  );
});
