
/** 一段里最多念几句 (语音通话里多给一句, 那时模型被要求只说一到三句) */
export const LEAD_SENTENCES = 2;
export const LEAD_SENTENCES_VOICE = 3;
/** 口播段字数上限 —— 到了句末就停; 一句话写成一大段没有句号的, 到这里按逗号断 */
const LEAD_SOFT_CHARS = 90;
const LEAD_HARD_CHARS = 160;

const TERMINATOR = /[。！？!?]|\.(?=\s|$)/g;
/** 段落 / 结构开始: 空行, 或新起一行是列表 / 编号 / 表格 / 标题 / 引用 / 代码围栏 */
const STRUCTURE = /\n\s*\n|\n\s*(?:[-*+•]\s|\d+[.、)]\s|\||#{1,6}\s|>|```)|```/;

/**
 * text 里该念的那一截 (从头算)。done=false 表示还在流, 切点没出现就整段先放行。
 * 返回 { lead, closed }: closed=true 说明切点已经出现, 后面的都不念了。
 */
export function spokenLeadOf(text: string, maxSentences: number = LEAD_SENTENCES): { lead: string; closed: boolean } {
  let cut = text.length;
  let closed = false;
  const s = STRUCTURE.exec(text);
  if (s) { cut = s.index; closed = true; }
  /* 第 N 句句末; 加上这一句就超过软上限、而前面已经有整句了 → 停在前一句 (实录: 第二句是一长串参数, 念到一半被截) */
  TERMINATOR.lastIndex = 0;
  let count = 0;
  let prevEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = TERMINATOR.exec(text)) && m.index < cut) {
    count++;
    const end = m.index + m[0].length;
    if (end > LEAD_SOFT_CHARS && prevEnd > 0) { cut = prevEnd; closed = true; break; }
    if (count >= maxSentences || end >= LEAD_SOFT_CHARS) { cut = end; closed = true; break; }
    prevEnd = end;
  }
  /* 第一句就写成一大段: 到上限按最近的逗号 / 分号断 (不断在顿号上 —— 那是列举, 断开念出来是「--top、」) */
  if (cut > LEAD_HARD_CHARS) {
    const head = text.slice(0, LEAD_HARD_CHARS);
    const comma = Math.max(head.lastIndexOf('，'), head.lastIndexOf(','), head.lastIndexOf('；'), head.lastIndexOf(';'), head.lastIndexOf('：'));
    cut = comma > 40 ? comma + 1 : LEAD_HARD_CHARS;
    closed = true;
  }
  return { lead: text.slice(0, cut), closed };
}

/**
 * 念出来别扭的东西换成能听的 (在 markdown 清洗之后用):
 *   路径 shift-test4/README.md → README.md, 目录 shift-test4/ → shift-test4
 *   链接 → 「链接」
 *   括号里的英文代号 (fyi) (P0) → 删掉
 */
export function speakableText(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, '链接')
    /* 路径: 至少一个斜杠, 段里有字母 —— 1/2 这种分数不碰 */
    .replace(/(?:~|\.{1,2})?(?:\/?[\w.\-一-龥]+\/)+([\w.\-一-龥]*)/g, (whole, last: string) => {
      if (!/[a-zA-Z一-龥]/.test(whole) || /^\d+\/\d+$/.test(whole)) return whole;
      if (last) return last;
      const segs = whole.split('/').filter(Boolean);
      return segs[segs.length - 1] ?? whole;
    })
    .replace(/[（(]\s*[A-Za-z][A-Za-z0-9_\-]{0,11}\s*[)）]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
