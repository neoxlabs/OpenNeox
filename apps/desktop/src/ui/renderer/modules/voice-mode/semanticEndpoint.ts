
/** 尾部悬挂词 — 句子停在这些词上 = 句法未闭合, 后面必然还有话 (即使 ASR 顺手补了标点)。
 * 只收无歧义的连接词/介词/领起词; "看/说/查"这类可作句尾动词的不进名单 (宁慢勿错)。 */
const DANGLING_TAIL = new RegExp(
  '(的|地|得|和|跟|与|及|或|或者|还有|然后|接着|但是|不过|可是|因为|所以|如果|要是|虽然|而且|并且|以及|还是|就是|比如|例如|包括|关于|对于|把|被|让|请|麻烦'
  + '|帮我|给我|我要|我想|在|从|向|往|为'
  + '|and|or|but|the|a|an|to|of|in|on|at|for|with|so|because|if|when|please)$',
  'i',
);

const QUESTION_PARTICLE = /(吗|呢|吧|么|嘛)$/;

/** 明确疑问/请求句式收尾 — "上海天气怎么样" "现在几点" 这类无标点也判完整 */
const QUESTION_PHRASE = new RegExp(
  '(怎么样|怎样|如何|多少|多少钱|几点|几号|星期几|哪里|哪儿|叫什么|是什么|干什么|做什么|为什么'
  + '|好不好|行不行|可不可以|可以吗|是不是|对不对|有没有|在不在|能不能|要不要|多久|多远|多大)$',
);

/** ASR partial 是否已是语义完整的一句话 (VoiceMode 语义收口用, 纯函数) */
export function isSemanticallyComplete(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  /* 有效内容太少 ("嗯。" "好的") — 碎片不早收, 让 700ms 兜底把后文等进来 */
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const words = (t.match(/[a-zA-Z]+(?:'[a-z]+)?/g) || []).length;
  if (cjk + words * 2 < 4) return false;
  /* 剥掉尾部标点/空白, 看最后一个实词 — 悬挂连接词一票否决 (ASR 会给半句也补逗号) */
  const core = t.replace(/[\s。．.!！?？;；,，、…~～”"'）)】》>-]+$/u, '');
  if (!core || DANGLING_TAIL.test(core)) return false;
  /* ① 终止标点收尾 → 完整; 英文句点排除 "3." 小数/序号断口, 且要求 ≥3 个词成句 */
  if (/[。!！?？…]$/.test(t)) return true;
  if (/\.$/.test(t) && !/\d\.$/.test(t) && words >= 3) return true;
  /* ② 疑问语气词 / 明确疑问句式收尾 (partial 常无标点) → 完整 */
  if (QUESTION_PARTICLE.test(core)) return true;
  if (QUESTION_PHRASE.test(core)) return true;
  /* 陈述句无标点 — 说完没说完拿不准, 交给 700ms 兜底 */
  return false;
}

export default isSemanticallyComplete;
