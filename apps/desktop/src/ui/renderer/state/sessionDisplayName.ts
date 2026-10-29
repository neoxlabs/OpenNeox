/**
 * 会话名的**展示层**反解 —— 库里存什么不动, 只管显示成人话。
 * ═══════════════════════════════════════════════════════════════════════════
 * core 的 sessionStore 建会话时写死的默认名是 `New Chat - <toLocaleTimeString()>`,
 * 在全中文界面里顶出来就是 "New Chat - 10:18:36 PM" —— 英文 + 12 小时制, 一眼出戏。
 *
 * 但**不能**改成往库里写中文: 落库存结构不存渲染文案 (存了就等于把语言焊死,
 * 英文用户看到的会是中文, 而且历史数据也改不回来)。所以只在展示时反解:
 *   · 认出技术味默认名 → 按当前语言 + 会话创建时间渲染 "新会话 · 22:18"
 *   · 用户自己改过名字 / Agent 起过标题 → 原样显示, 一个字不动
 * 老会话不用迁移, 打开就是新样子。
 */

/** 只认真正的默认名; 用户自己起的名字绝不能被改写 */
const TECHNICAL_DEFAULT_RE = /^New Chat\b/i;

const BARE_ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|session-\d{10,}-[0-9a-z]+|[0-9a-f]{24,})$/i;

function hhmm(ts: number | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * @param name      库里存的会话名
 * @param createdAt 会话创建时间 (ms); 没有就只显示"新会话"
 * @param isZh      当前界面语言
 */
export function displaySessionName(
  name: string | null | undefined,
  createdAt: number | undefined,
  isZh: boolean,
): string {
  const n = (name ?? '').trim();
  const fallback = isZh ? '新会话' : 'New chat';
  if (!n || TECHNICAL_DEFAULT_RE.test(n) || BARE_ID_RE.test(n)) {
    const t = hhmm(createdAt);
    return t ? `${fallback} · ${t}` : fallback;
  }
  return n;
}
