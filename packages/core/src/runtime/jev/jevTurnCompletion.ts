/**
 * Jev 收尾判定 —— 模型说了「接下来我去改 X」却没调工具就要结束这一轮时, 拦一次让它直接去做。
 *
 * 现状: kernel 的正则守卫只在 finish_reason ≠ stop 时生效, 正常收尾的「我先看一下 config.ts。」
 * 就这么交给用户了, 用户只能再打一句「继续」—— 一整个人工往返。跨轮自动续跑默认关。
 *
 * 只在这些条件都满足时才问 (绝大多数收尾一次都不问, 不给结束加延迟):
 *   - 本 run 调过工具 (纯问答不管);
 *   - 正文不长 (≤ 400 字): 「宣布下一步就停」都是一两句话, 长篇是在交结果;
 *   - 不是在问用户 (末尾有问号 = 把决定交回给用户, 本来就该停)。
 * 每个 run 最多拦 2 次, 同一次退出只拦 1 次 (模型第二次还停就放行, 不跟它死磕)。
 *
 * 问法: 只看正文时 20 条收尾句 20/20, 但「只要计划 / 先别动」的请求只看正文会全部误拦,
 * 所以必须同时问用户是不是让它先停, 见 judgeUnfinished。
 */
import { askJev, type JevSettings } from './jevClient.js';

export const UNFINISHED_THRESHOLD = 0.85;
/** 用户让它先停的概率到这就不拦 (宁可漏拦, 不能违背用户) */
const HOLD_THRESHOLD = 0.5;
export const UNFINISHED_MAX_NUDGES_PER_RUN = 2;
const MAX_TEXT_LEN = 400;
const MAX_REQUEST_LEN = 3000;
const REQUEST_TIMEOUT_MS = 3000;

/**
 * 「宣布下一步」的说法。只用来决定问不问 Jev, 判不由它 —— 没有这层的话, 每个调过工具、
 * 以一两句话收尾的轮次 (绝大多数) 都要在结束前多等一次请求 (0.5–1s)。
 */
const ANNOUNCE_CUE = /接下来|下一步|我先|我来|我去|我会|我将|让我|现在(去|开始|来)|马上|开始(执行|修改|处理)|准备(去|开始)?|\b(let me|let's|i'll|i will|i'm going to|next,? i|now i|going to)\b/i;

/** 值不值得问一次。 */
export function shouldAskUnfinished(text: string, totalToolCalls: number): boolean {
  if (totalToolCalls <= 0) return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_TEXT_LEN) return false;
  if (/[?？]\s*$/.test(trimmed) || /[?？]/.test(trimmed.slice(-40))) return false;
  return ANNOUNCE_CUE.test(trimmed.slice(-160));
}

export interface UnfinishedVerdict {
  /** 正文以「宣布下一步」收尾的概率 */
  announced: number;
  /** 用户请求本身就只要分析 / 计划 / 等确认 / 答完就停的概率 */
  hold: number;
  ms: number;
}

/** 该不该拦: 宣布了下一步, 且用户没让它停在这。 */
export function isUnfinished(v: UnfinishedVerdict): boolean {
  return v.announced >= UNFINISHED_THRESHOLD && v.hold < HOLD_THRESHOLD;
}

/**
 * 两个问题并行问 (一次请求)。只看正文会误拦「先别改, 说下一步打算」这类请求 —— 只问正文时
 * 只要计划的请求全被判成没做完 (p≈0.97); 加上「用户是不是让它先停」后 14 条 13 对、零误拦,
 * 漏判只是不拦 (= 没有这个闸时的行为)。请求失败返回 null (= 放行)。
 */
export async function judgeUnfinished(
  settings: JevSettings,
  request: string,
  text: string,
): Promise<UnfinishedVerdict | null> {
  try {
    const r = await askJev(settings, { request: request.trim().slice(0, MAX_REQUEST_LEN), reply: text.trim() }, {
      announced: {
        type: 'noul',
        instructions: { question: 'Does `reply` end by announcing an action the agent is about to take (and has not done yet)?' },
        criteria: {
          yes: 'It says what it will do next (let me / next I will / 接下来 / 我先 / 现在去 …) and stops there',
          no: 'It reports results, gives a final answer, or explains why it cannot continue',
        },
      },
      hold: {
        type: 'noul',
        instructions: {
          question: 'Does `request` tell the agent NOT to carry out the work yet '
            + '(only analyze / plan / describe the next step / wait for confirmation / stop after replying)?',
        },
        criteria: {
          yes: 'The request limits the agent to looking, explaining or planning, or says not to change anything yet',
          no: 'The request asks the agent to get the work done',
        },
      },
    }, { timeoutMs: REQUEST_TIMEOUT_MS });
    const a = r.answers.announced;
    const h = r.answers.hold;
    if (a?.type !== 'noul' || h?.type !== 'noul') return null;
    return { announced: a.noul, hold: h.noul, ms: r.ms };
  } catch {
    return null;
  }
}

export function unfinishedNudge(english: boolean): string {
  return english
    ? '⚠ Your last message announced the next step but you tried to end the turn without doing it. '
      + 'Do that step now with the tools. If it is actually already done, or needs the user to decide, say so in one line and finish.'
    : '⚠ 你上一条说了接下来要做的事, 但没调用工具就要结束这一轮。现在直接去做那一步。'
      + '如果其实已经做完、或需要用户来决定, 用一句话说明后再结束。';
}
