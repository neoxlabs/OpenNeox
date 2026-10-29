/* 聚光卡 (Spotlight) —— 偶尔弹出来的一张「上图下文」卡片: 功能引导、新功能、活动宣传共用。
 *
 *   卡片只是数据。什么时候弹、弹哪张、弹过记在哪, 在 spotlightScheduler; 长什么样在 SpotlightCard。
 *   内置卡只放共享代码里真实存在的功能; 商业版的活动 / 订阅宣传用 registerSpotlightCards 从外面接进来,
 *   这里不许 import 账号 / 计费目录 (check-edition-boundaries 会拦)。
 *
 *   文案规矩: 一张卡 = 一个标题 + 一句话 + 一颗按钮。写成第二句就是在写说明书了。
 */
import { NeoxIllus } from '../../media/illus';

export type SpotlightKind = 'tip' | 'new' | 'promo';

export type SpotlightText = { zh: string; en: string };

export type SpotlightAction =
  /** 打开设置页的某一页 (tab id 见 SettingsPage 的 SettingsTab) */
  | { type: 'settings'; tab: string }
  /** 派一个 window 事件 —— 功能自己接 (比如 neox:open-model-connect) */
  | { type: 'event'; name: string; detail?: unknown }
  /** 用系统浏览器打开 (活动页之类) */
  | { type: 'url'; url: string };

export interface SpotlightContext {
  now: number;
  /** 有账号体系的发行版 (手机端 / 订阅这类卡只在这里有意义) */
  hasAccount: boolean;
  /** 已经能发消息 (登录或配了 BYOK) —— 没模型的人先别推功能, 输入框上的提示条会带他去接 */
  modelReady: boolean;
}

export interface SpotlightCardDef {
  /** 稳定 id —— 「看过没有」按它记, 改了就等于一张新卡 */
  id: string;
  kind: SpotlightKind;
  /** 上半部分的图。优先用 NeoxIllus 这套等距插画 (带透明底, 深浅主题通用) */
  image: string;
  title: SpotlightText;
  body: SpotlightText;
  cta?: { label: SpotlightText; action: SpotlightAction };
  /** 同一轮里被抽中的相对权重, 默认 1 */
  weight?: number;
  /** 活动窗口 (ISO 日期), 窗口外不出 */
  startsAt?: string;
  endsAt?: string;
  /** 看过之后隔多少天可以再出; 不填 = 只出一次 */
  repeatAfterDays?: number;
  /** 额外条件 */
  when?: (ctx: SpotlightContext) => boolean;
}

const BUILTIN: SpotlightCardDef[] = [
  {
    id: 'mcp-2026-09',
    kind: 'tip',
    image: NeoxIllus.mcp,
    title: { zh: '给 Agent 接上外部工具', en: 'Plug tools into your agent' },
    body: {
      zh: '用 MCP 把数据库、浏览器、设计稿交给 Agent 直接用。',
      en: 'Use MCP to hand databases, browsers and design files straight to the agent.',
    },
    cta: { label: { zh: '添加 MCP', en: 'Add MCP' }, action: { type: 'settings', tab: 'mcp' } },
  },
  {
    id: 'skills-2026-09',
    kind: 'tip',
    image: NeoxIllus.skill,
    title: { zh: '把固定流程写成技能', en: 'Turn routines into skills' },
    body: {
      zh: '写一次做法, 遇到同类任务 Agent 会自己调出来用。',
      en: 'Write the steps once — the agent picks them up whenever the task comes around.',
    },
    cta: { label: { zh: '看看技能', en: 'Open skills' }, action: { type: 'settings', tab: 'skills' } },
  },
  {
    id: 'memory-2026-09',
    kind: 'tip',
    image: NeoxIllus.memory,
    title: { zh: 'Neox 记得你的习惯', en: 'Neox remembers how you work' },
    body: {
      zh: '偏好和项目约定会记下来, 随时能查看和删除。',
      en: 'Preferences and project conventions are kept — view or delete them anytime.',
    },
    cta: { label: { zh: '查看记忆', en: 'View memory' }, action: { type: 'settings', tab: 'memory' } },
  },
  {
    id: 'websearch-2026-09',
    kind: 'tip',
    image: NeoxIllus.web,
    title: { zh: '让 Agent 先查再答', en: 'Search before answering' },
    body: {
      zh: '配好联网搜索, 需要最新资料时 Agent 会先去查。',
      en: 'Set up web search and the agent looks things up when it needs fresh facts.',
    },
    cta: { label: { zh: '配置联网搜索', en: 'Set up search' }, action: { type: 'settings', tab: 'websearch' } },
  },
  {
    id: 'pet-2026-09',
    kind: 'new',
    image: NeoxIllus.pet,
    title: { zh: '领一只桌面伙伴', en: 'Meet your desk buddy' },
    body: {
      zh: '输入框旁边住一只小家伙, 陪你一起干活。',
      en: 'A little companion that sits by the composer while you work.',
    },
    cta: { label: { zh: '去挑一只', en: 'Pick one' }, action: { type: 'settings', tab: 'pet' } },
    weight: 0.6,
  },
  {
    id: 'mobile-2026-09',
    kind: 'new',
    image: NeoxIllus.anywhere,
    title: { zh: '手机上也能用', en: 'Neox on your phone' },
    body: {
      zh: '在手机上发任务, 这台电脑接着执行。',
      en: 'Send a task from your phone and this computer carries it out.',
    },
    cta: { label: { zh: '连接手机', en: 'Connect phone' }, action: { type: 'settings', tab: 'mobile' } },
    when: (ctx) => ctx.hasAccount,
  },
];

const extra = new Map<string, SpotlightCardDef>();
const listeners = new Set<() => void>();

/** 从外面加卡 (商业版活动 / 远端下发)。同 id 覆盖内置卡。返回撤销函数。 */
export function registerSpotlightCards(cards: SpotlightCardDef[]): () => void {
  for (const c of cards) extra.set(c.id, c);
  listeners.forEach((fn) => fn());
  return () => {
    for (const c of cards) if (extra.get(c.id) === c) extra.delete(c.id);
    listeners.forEach((fn) => fn());
  };
}

export function onSpotlightCardsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getSpotlightCards(): SpotlightCardDef[] {
  const byId = new Map<string, SpotlightCardDef>();
  for (const c of BUILTIN) byId.set(c.id, c);
  for (const [id, c] of extra) byId.set(id, c);
  return [...byId.values()];
}

export function getSpotlightCard(id: string): SpotlightCardDef | undefined {
  return getSpotlightCards().find((c) => c.id === id);
}
