import {
  CHAT_PERSONAS,
  chatPersonaKey,
  type ChatPersonaStyle,
} from './chatPersona.generated.js';

export type ChatPromptLanguage = 'zh' | 'en';

export interface ChatToolAvailability {
  /** web_search 在本轮工具表里 */
  search: boolean;
  /** generate_image 在本轮工具表里 */
  image: boolean;
}

const ALL_TOOLS: ChatToolAvailability = { search: true, image: true };

/** 聊天档的人格段 — 从单一源取一条已经拼好的变体。
 *
 * [style] 只影响「来源怎么给」这一句:
 *   · `links` (桌面, 默认): 暂时没有来源卡, 让模型在正文末尾列 2~3 条真实链接;
 *   · `card`  (手机): 正文不贴链接, 来源由界面展示。
 * 等桌面接上来源卡 (chat plan C3-10) 就把默认值改成 `card`, 两端的文本就完全一样。 */
export function buildChatLightPersona(
  lang: ChatPromptLanguage,
  available: ChatToolAvailability = ALL_TOOLS,
  style: ChatPersonaStyle = 'links',
): string {
  const key = chatPersonaKey(lang, available.search, available.image, style);
  const text = CHAT_PERSONAS[key];
  if (!text) {
    throw new Error(`[chatLightPrompt] 缺人设变体 ${key} —— 改人设后跑 node scripts/bake-chat-persona.mjs`);
  }
  return text;
}

const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WEEKDAY_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function chatDayStamp(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** 本机时区名 (Asia/Shanghai) + 当时的偏移 (UTC+08:00)。 */
export function localTimeZoneLabel(now: Date): { name: string; offset: string } {
  let name = 'local';
  try {
    name = Intl.DateTimeFormat().resolvedOptions().timeZone || name;
  } catch { /* 老运行时没有 Intl 就只写偏移 */ }
  const minutes = -now.getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return { name, offset: `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}` };
}

/**
 * 时间 / 时区 / 语言段。**天级**信息, 不含分钟 —— 分钟级时刻已经在最新 user 消息尾部的
 * `<current-time>` 里, 这里再放一份会让 system 段每轮变一次 (前缀缓存的命)。
 */
export function buildChatTimeContext(
  lang: ChatPromptLanguage,
  now: Date = new Date(),
  timeZone?: string,
): string {
  const tz = localTimeZoneLabel(now);
  const tzName = timeZone || tz.name;
  const date = chatDayStamp(now);
  if (lang === 'en') {
    return `Right now it is ${date} ${WEEKDAY_EN[now.getDay()]} (${tzName}, ${tz.offset}). Answer "what\'s the date / what day is it / what time is it" from this — do not guess and do not call a tool. The <current-time> tag at the end of the latest user message is the exact moment; if the two disagree, trust the tag (the system adds it — never repeat it in your reply). Relative expressions like "this month" or "last week" are counted from this date. UI language: English.`;
  }
  return `现在是 ${date} ${WEEKDAY_ZH[now.getDay()]}（${tzName}，${tz.offset}）。问「今天几号」「今天周几」「现在几点」按这个时间回答，不要猜，也不用去搜。最新一条用户消息尾部的 <current-time> 是那一刻的准确时刻，两边不一致时以它为准（这是系统自动附的，回复里不要写它）。「这个月」「上周」这类相对时间以这个日期为基准算。界面语言: 中文。`;
}
