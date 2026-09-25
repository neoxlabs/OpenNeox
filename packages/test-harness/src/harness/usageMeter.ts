/**
 * usageMeter —— 一条 CDP 用例花了多少 token, 从**界面上**读。
 *
 * 从界面读取可见消耗，既避免直接依赖加密会话库，也保持报告与用户看到的数值一致。
 *
 * 口径：界面显示的是**这一轮累计**上下文消耗，包含缓存读取；
 * 报告使用 before/after 差值比较用例量级和成本回归，不代表账单。
 */
import type { CdpPage } from './cdp.js';

export interface UsageSnapshot {
  /** 页面上最后一条「共消耗 X」换算成的 token 数 (K/M 已展开)。读不到 = null。 */
  tokens: number | null;
  /** 最后一次可见的模型名 (报告里区分是谁跑的)。 */
  model: string | null;
  /** 最后那条页脚的指纹 (时间+速率+模型那一小段)。用来判断"到底有没有跑出新的一轮"。 */
  sig: string | null;
  at: number;
}

const USAGE_RE = /共消耗\s*([\d.]+)\s*([KM]?)/g;

/* 模型名就写在「共消耗」那一行的尾巴上 (共消耗 49.2K · 267 tok/s · glm-5.3-flash),
 * 所以锚在那儿取, 别在全页文本里用"名字里带 flash/pro"这类模式去猜 ——
 * 第一版就是那么写的, 结果既匹不上 `glm-5.3-flash` (连字符+数字段), 又会把
 * `approval-isolation.png` 这种截图文件名当成模型名。 */
const MODEL_TOKEN_RE = /\b([a-z][a-z0-9.]*(?:-[a-z0-9.]+){1,6})\b/gi;
const NOT_MODEL = /\.(png|jpe?g|webp|json|md|db|log)$|^tok$|^neox-test/i;

function pickModelNear(text: string, fromIndex: number): string | null {
  if (fromIndex < 0) return null;
  const window = text.slice(fromIndex, fromIndex + 200);
  const cands = [...window.matchAll(MODEL_TOKEN_RE)].map((m) => m[1]!).filter((s) => !NOT_MODEL.test(s));
  return cands.length ? cands[cands.length - 1]! : null;
}

function toTokens(num: string, unit: string): number {
  const n = Number.parseFloat(num);
  if (!Number.isFinite(n)) return 0;
  if (unit === 'M') return Math.round(n * 1_000_000);
  if (unit === 'K') return Math.round(n * 1_000);
  return Math.round(n);
}

export async function readUsage(page: CdpPage): Promise<UsageSnapshot> {
  const raw = await page.evaluate(() => document.body.innerText);
  const text = String(raw ?? '');
  let tokens: number | null = null;
  let model: string | null = null;
  let sig: string | null = null;
  const usages = [...text.matchAll(USAGE_RE)];
  if (usages.length) {
    const last = usages[usages.length - 1]!;
    const at = last.index ?? -1;
    tokens = toTokens(last[1]!, last[2] ?? '');
    model = pickModelNear(text, at);
    /* 页脚整段 (共消耗 / tok/s / 模型) 当指纹 —— 同一轮不会变, 新一轮必然变 */
    sig = at >= 0 ? text.slice(at, at + 120).replace(/\s+/g, ' ') : null;
  }
  return { tokens, model, sig, at: Date.now() };
}

export interface UsageDelta {
  before: number | null;
  after: number | null;
  /** after - before; 任一端读不到就是 null (别拿 0 冒充"没花钱")。 */
  delta: number | null;
  model: string | null;
}

/**
 * 一条用例花了多少 —— **取它跑完时的会话累计**, 不是前后差值。
 *
 * 每条用例使用独立会话，因此结果取该会话结束时的累计值；没有产生新轮次时返回 null，
 * 避免把旧页面数据归因给当前用例。
 */
export function diffUsage(before: UsageSnapshot, after: UsageSnapshot): UsageDelta {
  /* 页脚指纹没变 = 这条用例根本没跑出新的一轮 (比如只切档位、不发消息的用例)。
   * 这时页面上那个数是**上一条用例留下的**, 记到这条头上就是凭空扣账。
   * 报 null → 报告里显示 "-", 说"没测到"而不是编一个数。 */
  const producedTurn = !!after.sig && after.sig !== before.sig;
  return {
    before: before.tokens,
    after: after.tokens,
    delta: producedTurn ? after.tokens : null,
    model: producedTurn ? (after.model ?? before.model) : null,
  };
}

/** 人读的写法: 12345 → "12.3K"。null → "-" (读不到就说读不到, 不写 0)。 */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
