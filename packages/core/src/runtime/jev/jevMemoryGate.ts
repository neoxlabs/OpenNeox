/**
 * Jev 自动记忆闸 —— 每轮结束后, 先问 Jev 这一轮有没有值得长期记的东西, 没有就不调提取模型。
 *
 * 自动记忆每轮都用主模型读最近 30 条消息找「值得记的」, 绝大多数轮次什么也没有 (本机近三周
 * 基本全空), 等于每轮白付一次无缓存的主模型调用。Jev 问两题 (一次请求, ~0.4s, ~550 token):
 *   - rule:   用户有没有给出以后要沿用的规则 / 偏好 / 固定事实;
 *   - lesson: 助手有没有总结出以后都要遵守的做法。
 * 取两者较大值, ≥ MEMORY_GATE_THRESHOLD 才去提取。
 *
 * 阈值取 0.3: 按真实记忆条目还原的 8 条正例全过 (最低 0.38), 18 条真实空轮误放 1 条。
 * 误放只多花一次提取调用, 漏记会丢掉用户交代的事, 所以宁低勿高。
 * 请求失败返回 null, 调用方照常提取 (= 没有这个闸时的行为)。
 */
import { askJev, type JevSettings } from './jevClient.js';

export const MEMORY_GATE_THRESHOLD = 0.3;
const MAX_PART_LEN = 3000;
const REQUEST_TIMEOUT_MS = 3000;

type Msg = { role?: string; content?: unknown };

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c: any) => c && (c.type === 'text' || (c.type === undefined && typeof c.text === 'string')))
    .map((c: any) => c.text || '')
    .join('');
};

/** 最近一轮: 最后一条有文字的用户消息, 加它之后助手说的话。 */
export function lastExchange(messages: ReadonlyArray<Msg>): { user: string; reply: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    const user = textOf(m.content).trim();
    if (!user) continue;
    const reply = messages.slice(i + 1)
      .filter((x) => x?.role === 'assistant')
      .map((x) => textOf(x.content))
      .join('\n')
      .trim();
    return { user: user.slice(0, MAX_PART_LEN), reply: reply.slice(-MAX_PART_LEN) };
  }
  return null;
}

export interface MemoryGateVerdict {
  rule: number;
  lesson: number;
  ms: number;
}

export function worthRemembering(v: MemoryGateVerdict): boolean {
  return Math.max(v.rule, v.lesson) >= MEMORY_GATE_THRESHOLD;
}

export async function judgeWorthRemembering(
  settings: JevSettings,
  exchange: { user: string; reply: string },
): Promise<MemoryGateVerdict | null> {
  try {
    const r = await askJev(settings, { user: exchange.user, assistant: exchange.reply }, {
      rule: {
        type: 'noul',
        instructions: { question: '用户有没有要求以后都这样做（或以后都别这样做），或者告诉了一个以后还要用到的固定事实？' },
        criteria: {
          yes: '用户的话里有「以后/都/不要再/我们项目用/记一下」这类长期规则、偏好或固定事实',
          no: '用户只是提了这一次要做的事或问题，没有给出以后要沿用的规则、偏好或事实',
        },
      },
      lesson: {
        type: 'noul',
        instructions: { question: '助手有没有总结出一条以后都要遵守的做法（踩坑后的教训）？' },
        criteria: {
          yes: '回复里明确写了以后必须/一律/每次都要怎样做，并已据此改了配置或流程',
          no: '回复只是汇报这次做了什么、结果如何，没有定下以后沿用的规则',
        },
      },
    }, { timeoutMs: REQUEST_TIMEOUT_MS });
    const rule = r.answers.rule;
    const lesson = r.answers.lesson;
    if (rule?.type !== 'noul' || lesson?.type !== 'noul') return null;
    return { rule: rule.noul, lesson: lesson.noul, ms: r.ms };
  } catch {
    return null;
  }
}
