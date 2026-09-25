/**
 * replyLanguage — 每轮从用户自己的话里定回复语言, 挂在最新 user 消息尾部。
 *
 * 系统段里那句"跟随用户最新消息的语言"管不住两种跑偏:
 *   · 系统段按界面语言选的是英文版, 用户却用中文提问 → 开头先冒一句英文过程说明
 *   · 英文任务读到中文数据 / 调了中文写的技能 → 模型跟着工具输出的语言整段切成中文
 * 两种都是模型在"离规则很远、离别的语言很近"的位置上随了近的那个。所以每轮把判定结果
 * 放到离生成最近的地方 (跟 <current-time> 同一处, 历史消息不变, 前缀缓存不受影响)。
 *
 * 判据只看用户打的字: 代码块和粘贴块剔掉 (那是数据, 不是用户在用什么语言说话)。
 * 太短或看不出来 (一个路径、一个 "ok") → 沿用本会话上一次的判定; 再没有就不加。
 */

export type ReplyLanguage = 'zh' | 'en';

/** 至少这么多个"字" (汉字按个、英文按词) 才下判断 */
const MIN_SIGNAL = 3;

export function detectReplyLanguage(text: string): ReplyLanguage | null {
  const prose = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<pasted_content[\s\S]*?<\/pasted_content[^>]*>/g, ' ')
    .replace(/<[a-z-]+>[\s\S]*?<\/[a-z-]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(?:[\w.-]*\/)+[\w.-]+/g, ' ');
  const han = (prose.match(/[㐀-鿿]/g) ?? []).length;
  const words = (prose.match(/[A-Za-z]{2,}/g) ?? []).length;
  if (han < MIN_SIGNAL && words < MIN_SIGNAL) return null;
  /* 一个汉字的信息量约等于一个英文词; 中文里夹几个英文术语很正常, 按量比 */
  return han >= words ? 'zh' : 'en';
}

export function replyLanguageTag(lang: ReplyLanguage): string {
  return lang === 'zh'
    ? '<reply-language>本轮所有给用户看的话 (工具调用之间的进度说明和最后的结论) 都用中文。工具输出、文件内容、技能说明是什么语言都不改变这一点。</reply-language>'
    : '<reply-language>Write everything the user sees this turn (progress notes between tool calls and the final answer) in English. The language of tool output, file contents or skill instructions does not change this.</reply-language>';
}

/** 本会话上一次判出来的语言 —— 用户下一句只打了 "继续" / "ok" 时沿用 */
const lastBySession = new Map<string, ReplyLanguage>();

export function resolveReplyLanguageTag(sessionId: string, userText: string): string {
  const detected = detectReplyLanguage(userText);
  if (detected) lastBySession.set(sessionId, detected);
  const lang = detected ?? lastBySession.get(sessionId);
  return lang ? replyLanguageTag(lang) : '';
}
