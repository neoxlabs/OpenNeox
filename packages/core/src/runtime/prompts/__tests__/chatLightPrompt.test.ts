/**
 * 聊天档提示词 (chatLightPrompt.ts / chatPrompt.ts) —— 单一源 + 人格段内容。
 *
 * 锁五件:
 *   1. 人格段来自唯一源 chatPersona.source.json (chat:C2-05): 生成文件必须跟源重新拼出来的一致;
 *   2. 只提手上真有的两个工具, 不出现工作 / 编码模式的工具名;
 *   3. 没有「请切到 Agent 模式」这类劝退句 (C2-03);
 *   4. 回答长度分三档且可判定 (chat:C2-06), 中文整段 ≤350 字符 (chat:C2-04);
 *   5. 时间 / 时区 / 语言段是单独一段 (天级, 不含分钟), 不混进人格段开头;
 *      轻档 (Agent 模式 + Jev 判成纯聊天, Work / Code 在用) 的提示词**逐字没变**。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildChatPrompt } from '../chatPrompt.js';
import { buildChatLightPersona, buildChatTimeContext, chatDayStamp } from '../chatLightPrompt.js';
import { CHAT_PERSONAS, CHAT_PERSONA_SOURCE_SHA, chatPersonaKey } from '../chatPersona.generated.js';

const FORBIDDEN = [
  'readfile', 'execute_shell', 'browser_navigate', 'office_edit', 'workspace_files',
  'tool_search', 'start_task', 'deep_research', 'edit',
  '切到 Agent 模式', 'switch to Agent mode',
];

/* ── 单一源: 读 JSON 自己重新拼一遍, 跟生成文件比对 ─────────────────────────── */

const SOURCE_URL = new URL('../chatPersona.source.json', import.meta.url);
const SOURCE_RAW = readFileSync(SOURCE_URL, 'utf-8').replace(/\r\n/g, '\n');
const SOURCE = JSON.parse(SOURCE_RAW) as {
  zh: PersonaBlocks;
  en: PersonaBlocks;
};

interface PersonaBlocks {
  core: string;
  toolsHeader: Record<string, string>;
  tool: { search: string; image: string };
  missing: { search: string; image: string; none: string };
  closing: { card: string; links: string };
  noFiles: string;
}

/** 跟 scripts/bake-chat-persona.mjs 的 composePersona 同一套顺序。 */
function compose(blocks: PersonaBlocks, search: boolean, image: boolean, style: 'card' | 'links'): string {
  const lines = [blocks.core];
  const count = (search ? 1 : 0) + (image ? 1 : 0);
  lines.push(blocks.toolsHeader[String(count)]);
  if (search) lines.push(blocks.tool.search);
  if (image) lines.push(blocks.tool.image);
  if (!search) lines.push(blocks.missing.search);
  if (!image) lines.push(blocks.missing.image);
  if (count === 0) lines.push(blocks.missing.none);
  if (search && style === 'links') lines.push(blocks.closing.links);
  else if (count > 0) lines.push(blocks.closing.card);
  lines.push(blocks.noFiles);
  return lines.join('\n');
}

const AVAILABILITIES = [
  { search: true, image: true },
  { search: true, image: false },
  { search: false, image: true },
  { search: false, image: false },
] as const;
const STYLES = ['card', 'links'] as const;

describe('单一源 (chat:C2-05): 桌面与手机是同一份人设', () => {
  it('源 JSON 的 sha 跟生成文件里记的一致 —— 改了源没烘焙会红', () => {
    const sha = createHash('sha256').update(SOURCE_RAW, 'utf-8').digest('hex');
    expect(CHAT_PERSONA_SOURCE_SHA).toBe(sha);
  });

  it('每个变体都等于从源重新拼出来的文本 (生成文件没被手改)', () => {
    for (const lang of ['zh', 'en'] as const) {
      for (const { search, image } of AVAILABILITIES) {
        for (const style of STYLES) {
          const key = chatPersonaKey(lang, search, image, style);
          expect(CHAT_PERSONAS[key], key).toBe(compose(SOURCE[lang], search, image, style));
        }
      }
    }
  });

  it('两端的生成文件出自同一份源 (手机 Dart 文件里记的是同一个 sha)', () => {
    const dart = readFileSync(
      new URL('../../../../../../apps/mobile/lib/core/local_agent/chat_persona.g.dart', import.meta.url),
      'utf-8',
    );
    expect(dart).toContain(`kChatPersonaSourceSha = '${CHAT_PERSONA_SOURCE_SHA}'`);
  });

  it('两端的 zh 人格段逐字节相同 (只有「来源怎么给」这一句允许不同)', () => {
    const card = buildChatLightPersona('zh', { search: true, image: true }, 'card');
    const links = buildChatLightPersona('zh', { search: true, image: true }, 'links');
    expect(card).not.toBe(links);
    /* 去掉来源那句之后必须一字不差 */
    const strip = (s: string) => s.replace(/正文(不贴链接、不写「我将调用」；结果由界面展示|不写「我将调用」；末尾列 2~3 个真实来源链接)。/, '');
    expect(strip(card)).toBe(strip(links));
  });
});

describe('聊天档人格段', () => {
  for (const lang of ['zh', 'en'] as const) {
    it(`[${lang}] 只提 web_search / generate_image 两个工具`, () => {
      const p = buildChatLightPersona(lang);
      expect(p).toContain('web_search');
      expect(p).toContain('generate_image');
      for (const bad of FORBIDDEN) expect(p).not.toContain(bad);
    });

    it(`[${lang}] 写了搜索 / 画图可以一轮并发多个, 并明确不能动用户的文件和电脑`, () => {
      const p = buildChatLightPersona(lang);
      /* 总控裁决第六节: 提示词要告诉模型「要查多个方面就一次并发发出多个搜索」,
       * 画图多张也一样 —— 不再写「一轮最多 3 次 / 1 张」这种会挡住正常需求的小额度。 */
      expect(p).toMatch(lang === 'zh' ? /并发/ : /at once|concurrently/);
      expect(p).not.toMatch(/最多 3 次|最多 1 张|At most 3 searches|at most 1 image/);
      expect(p).toMatch(/文件|files/);
    });
  }

  it('buildChatPrompt(chat) 就是这份人格段 —— 不含日期 (时间单独一段, 不占开头)', () => {
    for (const lang of ['zh', 'en'] as const) {
      const p = buildChatPrompt('chat', lang);
      expect(p).toBe(buildChatLightPersona(lang));
      expect(p).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });

  it('chat:C2-04 人格段压到 ≤350 字符 (手机 card 变体; 桌面 links 变体只多一句来源, ≤360)', () => {
    for (const { search, image } of AVAILABILITIES) {
      for (const style of STYLES) {
        const p = buildChatLightPersona('zh', { search, image }, style);
        expect(p.length, `zh ${search}${image} ${style}`)
          .toBeLessThanOrEqual(style === 'card' ? 350 : 360);
      }
    }
    /* 英文上限 1000 字符 (≈280 token), 同样只降不升 */
    expect(buildChatLightPersona('en').length).toBeLessThan(1000);
  });
});

describe('chat:C2-06 回答长度跟问题复杂度走 —— 规则可判定', () => {
  const p = buildChatLightPersona('zh', { search: true, image: true }, 'card');

  it('三档各有可判定的条件与硬上限', () => {
    expect(p).toContain('回答长度跟问题复杂度走');
    /* 一档: 打招呼 / 是非题 —— 最多 2 句, 不列点 */
    expect(p).toMatch(/打招呼\/是非题: 最多 2 句，不列点/);
    /* 二档: 普通问题 —— 先结论, 1~3 句理由, 列点 ≤5 条 */
    expect(p).toMatch(/普通问题: 先结论，再 1~3 句理由；列点≤5 条/);
    /* 三档: 多步 / 对比 / 长内容 —— 才允许小标题、表格 */
    expect(p).toMatch(/多步\/对比\/长文: 才用小标题、表格/);
  });

  it('三档按「由短到长」排列 (模型从上往下读到第一个匹配的档)', () => {
    const simple = p.indexOf('打招呼/是非题');
    const ordinary = p.indexOf('普通问题');
    const complex = p.indexOf('多步/对比');
    expect(simple).toBeGreaterThan(-1);
    expect(ordinary).toBeGreaterThan(simple);
    expect(complex).toBeGreaterThan(ordinary);
  });

  it('「选哪个」只给一个建议, 不摊优缺点; 不写开场白 / 结尾套话', () => {
    expect(p).toMatch(/选哪个」: 一个建议 \+ 一句理由/);
    expect(p).toContain('好的我来帮你');
    expect(p).toContain('结尾套话');
  });

  it('英文版三档同样可判定', () => {
    const en = buildChatLightPersona('en');
    expect(en).toMatch(/two sentences at most, no bullets/);
    expect(en).toMatch(/1-3 sentences of why; at most 5 bullets/);
    expect(en).toMatch(/only then use short headings or a table/);
  });
});

describe('工具缺口如实反映 (池子没装好 / 没登录时不许照样声称有)', () => {
  it('[zh] 没有画图: 不提 generate_image, 也不承诺「结果由界面展示」', () => {
    const p = buildChatLightPersona('zh', { search: true, image: false });
    expect(p).toContain('web_search');
    expect(p).not.toContain('generate_image');
    expect(p).toMatch(/不能画图/);
  });

  it('[zh] 没有搜索: 不提 web_search, 也不承诺列来源', () => {
    const p = buildChatLightPersona('zh', { search: false, image: true });
    expect(p).toContain('generate_image');
    expect(p).not.toContain('web_search');
    expect(p).toMatch(/没有联网搜索/);
    expect(p).not.toMatch(/来源/);
  });

  it('[zh] 两件都没有: 明说没有工具, 并禁止手写调用语法 (DSML 上屏的根因)', () => {
    const p = buildChatLightPersona('zh', { search: false, image: false });
    expect(p).toContain('没有任何工具');
    expect(p).not.toContain('web_search');
    expect(p).not.toContain('generate_image');
    expect(p).toMatch(/手写工具调用语法/);
  });

  it('[en] 缺件同样不出现工具名', () => {
    const noImage = buildChatLightPersona('en', { search: true, image: false });
    expect(noImage).toContain('web_search');
    expect(noImage).not.toContain('generate_image');

    const noSearch = buildChatLightPersona('en', { search: false, image: true });
    expect(noSearch).toContain('generate_image');
    expect(noSearch).not.toContain('web_search');
    expect(noSearch).not.toMatch(/sources/);

    const none = buildChatLightPersona('en', { search: false, image: false });
    expect(none).toContain('no tools');
    expect(none).toMatch(/tool-call syntax/);
  });

  it('buildChatPrompt(chat) 把可用性透给聊天档', () => {
    expect(buildChatPrompt('chat', 'zh', { search: false, image: false }))
      .toBe(buildChatLightPersona('zh', { search: false, image: false }));
    /* 不传 = 两件都有 (轻档 / 老调用方行为不变) */
    expect(buildChatPrompt('chat', 'zh')).toBe(buildChatLightPersona('zh'));
  });
});

describe('时间 / 时区 / 语言段', () => {
  const now = new Date(2026, 9, 17, 21, 4, 0);

  for (const lang of ['zh', 'en'] as const) {
    it(`[${lang}] 带当天日期、星期、时区名与偏移、界面语言`, () => {
      const s = buildChatTimeContext(lang, now, 'Asia/Shanghai');
      expect(s).toContain('2026-10-17');
      expect(s).toContain(lang === 'zh' ? '周六' : 'Saturday');
      expect(s).toContain('Asia/Shanghai');
      expect(s).toMatch(/UTC[+-]\d{2}:\d{2}/);
      expect(s).toMatch(lang === 'zh' ? /界面语言/ : /UI language/);
    });
  }

  it('不含分钟级时刻 (天级信息才能放 system 段; 时区偏移 UTC+08:00 不算时刻)', () => {
    for (const lang of ['zh', 'en'] as const) {
      const withoutOffset = buildChatTimeContext(lang, now).replace(/UTC[+-]\d{2}:\d{2}/, '');
      expect(withoutOffset).not.toMatch(/\d{1,2}:\d{2}/);
    }
  });

  it('同一天不同时刻生成同一段 (不随轮次变)', () => {
    const a = buildChatTimeContext('zh', new Date(2026, 9, 17, 9, 0, 0));
    const b = buildChatTimeContext('zh', new Date(2026, 9, 17, 23, 59, 0));
    expect(a).toBe(b);
  });
});

describe('chatDayStamp (聊天档 prompt 缓存键里的「天」)', () => {
  it('按本地日期出 YYYY-MM-DD, 跨零点才换', () => {
    expect(chatDayStamp(new Date(2026, 9, 17, 9, 0))).toBe('2026-10-17');
    expect(chatDayStamp(new Date(2026, 9, 17, 23, 59))).toBe('2026-10-17');
    expect(chatDayStamp(new Date(2026, 9, 18, 0, 1))).toBe('2026-10-18');
  });

  it('时间段落里的日期跟它一致 (键变了, 重发的日期也是新的)', () => {
    const now = new Date(2026, 9, 17, 21, 4);
    expect(buildChatTimeContext('zh', now)).toContain(chatDayStamp(now));
  });
});

describe('轻档提示词 (Work / Code 在用) —— 快照, 逐字未变', () => {
  const LITE_ZH = [
    '你是 Neox，用户在 Neox 应用里对话的 AI 助手。',
    '',
    '用用户最近一条消息的语言回复。',
    '你的真实底层型号见本提示词末尾的运行时段；末尾没有写就不要猜型号或厂商。',
    '',
    '- 直接、有用：先给答案，再补真正有帮助的细节。',
    '- 需要时用 Markdown（列表、代码块、小表格）；闲聊就自然地聊。',
    '- 拿不准的事实直说不确定，不要编。',
    '- 这个对话里你看不到用户的文件、屏幕或项目，也不能运行任何东西。不要假装做过。',
    '',
    '## 开始干活',
    '这个对话以轻量方式开始。用户要做的事如果需要工具——读或改文件、看用户的项目和代码、跑命令、上网搜索、开浏览器、操作用户的电脑——先调用 `start_task`，它会解锁全部工具；然后在同一次回复里接着把事做完。不用先问用户要不要调。',
  ].join('\n');

  const LITE_EN = [
    'You are Neox, an AI assistant the user talks to inside the Neox app.',
    '',
    "Reply in the language of the user's latest message.",
    'Your real underlying model is stated in the runtime section at the end of this prompt; if it is missing, do not guess a model or vendor.',
    '',
    '- Be direct and useful; answer first, then add only the detail that helps.',
    '- Use Markdown when it aids reading (lists, code blocks, short tables); keep casual chat casual.',
    '- If you are not sure about a fact, say so instead of making it up.',
    "- You cannot see the user's files, screen or project in this conversation, and you cannot run anything. Do not pretend you did.",
    '',
    '## Starting a task',
    'This conversation starts lightweight. If the user asks for something that needs tools — reading or changing files, looking at their project or code, running commands, searching the web, opening a browser, or acting on their computer — call `start_task` first. It unlocks the full toolset; then carry on with the request in the same reply. Do not ask the user for permission to call it.',
  ].join('\n');

  it('zh 快照', () => expect(buildChatPrompt('lite', 'zh')).toBe(LITE_ZH));
  it('en 快照', () => expect(buildChatPrompt('lite', 'en')).toBe(LITE_EN));
  it('轻档保留 start_task 升级路径', () => {
    expect(buildChatPrompt('lite', 'zh')).toContain('start_task');
    expect(buildChatPrompt('lite', 'en')).toContain('start_task');
  });
});
