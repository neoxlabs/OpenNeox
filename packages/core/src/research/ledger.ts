/**
 * 证据账本 —— Deep Research 的核心
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 一句话: **每条结论必须能回溯到一段原文, 这件事由数据结构保证, 不由提示词保证。**
 *
 * 为什么非这么做不可: 业界 deep research 的引用准确率在 78%~94% 之间 (OpenAI DR ~78%,
 * Claude with search ~94%), 也就是 6%~22% 的引用是错的或干脆是编的。根源在顺序 ——
 * 它们是**先写报告再回头补引用** (Anthropic 的 CitationAgent 就是最后一步跑的), 先有结论
 * 再找台阶, 幻觉当然挡不住。
 *
 * 这里把顺序倒过来:
 *   1. 证据先入账, 入账时拿**归档原文**做子串校验 —— 引句在原文里找不到就**拒绝入账**
 *   2. 写报告时只能从账本里取, 取不到的就是没有
 * 于是"引用了一段原文里不存在的话"在物理上不可能发生, 而不是"我们会更努力地检查"。
 *
 * 另两条硬规则:
 *   · **冲突不合并**。同一条结论拿到互相矛盾的证据, 标 disputed, 两边都留着并排呈现。
 *     Claude Code 的 /deep-research 是 "vote on claims" (多数来源一致就提高置信度) ——
 *     这在真实调研里有害: 三篇互相抄的博客能把一篇厂商官方文档投掉。
 *   · **单来源要标出来**。single-source 是独立状态, 读者有权知道这条只有一个出处。
 *
 * 落盘布局 (跟项目走, 能进 git):
 *   <workDir>/.neox/research/<slug>/
 *     ledger.json          账本本体
 *     archive/S1.md        每个来源的原文快照 (断链之后还能查, 也是引句校验的依据)
 */

import fs from 'fs/promises';
import path from 'path';

/* ══════════════════════════════════════════════════════════════════════════
 * 类型
 * ══════════════════════════════════════════════════════════════════════════ */

/** 来源性质，用于区分厂商自述、第一方资料和独立资料的权重。 */
export type SourceKind = 'primary' | 'secondary' | 'vendor' | 'unknown';

export interface ResearchSource {
  /** S1 / S2 … —— 报告里引用就写这个号 */
  sid: string;
  url: string;
  title: string;
  hostname: string;
  kind: SourceKind;
  /** 发布时间 (web_search 给的, 可能没有) */
  publishedAt?: string;
  /** **抓取时刻** —— 页面事后改了也能说清当时读到的是哪一版 */
  fetchedAt: string;
  /** 原文快照, 相对账本目录 (archive/S1.md) */
  archivePath: string;
  chars: number;
}

export type ClaimStatus =
  /** 两个及以上独立来源支持, 且没有反证 */
  | 'supported'
  /** 只有一个来源支持 —— 不是错, 但读者有权知道 */
  | 'single-source'
  /** 拿到了互相矛盾的证据 —— 不合并, 并排呈现 */
  | 'disputed'
  /** 一条支持证据都没有 —— 能进账本但必须在产出里显式标出来 */
  | 'unverified';

export interface ClaimEvidence {
  /** 指向 sources[].sid */
  sid: string;
  /** 原文引句 —— 必须能在该来源的归档里字面命中 (空白归一后) */
  quote: string;
  /** 章节/页码一类的定位, 可选 */
  loc?: string;
}

export interface ResearchClaim {
  /** C1 / C2 … */
  cid: string;
  /** 结论本身 */
  text: string;
  support: ClaimEvidence[];
  contradict: ClaimEvidence[];
  status: ClaimStatus;
  /** disputed 时给出的倾向和理由 (比如「S1 是厂商官方文档, S4 是三年前的博客」)。
   * 只是倾向 —— 两边的证据永远都留着, 不允许据此删掉一边。 */
  lean?: string;
  /**
   * 反证是否来自**别的**来源。
   *
   * 同一来源的自我限定不等同于两个来源之间的分歧，两类证据都保留但分别标记:
   *   crossSource=true 两家说法不一, 读者要自己判断信谁
   *   crossSource=false 同一份文档内部的自我限定, 是这条结论的注脚
   * 只在有反证时才有意义, 没反证时不写。
   */
  crossSource?: boolean;
  /**
   * 这条结论属于哪个**调研角度**。
   *
   * 该字段让报告按调研课题成章，而不是按证据状态堆叠结论。
   *
   * 由 research_record 记账时带上 (worker 的提示词里给了它自己那一条)。
   * 缺少该字段的旧账本归入「未归类」，不影响报告生成。
   */
  angle?: string;
}

/**
 * 收敛出来的导读。
 *
 * 调研收尾执行一次归纳，结果存进账本而不是在渲染报告时临时生成。
 * 报告因此保持为账本的可复现投影，并包含聚合后的结论分析。
 *
 * 每条里的 [C12] 是对结论的引用, 生成后逐个校验过: 账本里没有的编号会被剔掉。
 */
export interface NarrativeTable {
  title: string;
  headers: string[];
  /** 每行的单元格; 行数与 rowCites 一一对应 */
  rows: string[][];
  /** 表下面那行「数据来源：机构 · 日期 · 口径说明」 */
  source?: string;
}

export interface NarrativeChart {
  title: string;
  /**
   * 图的形态, 由模型按数据性质选 (需求： 「你没有引入饼图等更多折线图的
   * 这种渲染形式, 都太单一」)。白名单之外的一律回落 column。
   *   column=类别对比 · line/area=随时间变化 · pie/donut=构成占比
   *   hbar=条目多或标签长 · cloud=热词/槽点这种没有可比量纲的分布
   *
   * 后四种是**信息图形状** (用户点名, 自己画不引库): 讲结构不讲刻度,
   * 数据同样是 labels/values —— pyramid=分层(上尖下宽) · funnel=一路走下来的流失 ·
   * target=由外到内的收敛 · river=随时间变粗变细的带子。
   */
  type?: 'column' | 'line' | 'area' | 'pie' | 'donut' | 'hbar' | 'cloud'
    | 'pyramid' | 'funnel' | 'target' | 'river';
  labels: string[];
  values: number[];
  /**
   * 多系列 (需求：「我们的柱状图为什么不能是多彩的呢?」)。
   *
   * 真相是: 单系列的图**不该**多彩 —— 一根柱子一个颜色只是彩虹, 颜色没编码任何信息。
   * 人家报告里的多彩图全是多系列: 广东/浙江/江苏三色、2023 vs 2024 双色, 颜色区分的是
   * **系列**。所以要多彩, 先得能画多系列: labels 是横轴类别, 每个 series 是一条对比线。
   * 给了 series 就画分组柱/多条折线并带图例; 没给就还是单系列 (values)。
   */
  series?: Array<{ name: string; values: number[] }>;
  /**
   * 图说 —— 图下面那一两句解读 ("此图整合了…上半部分展示了…")。
   * 专业报告里每张图都有: 标题给结论, 图说告诉读者该看哪里、这图为什么值得看。
   */
  note?: string;
  yLabel?: string;
  /** 图下面那行「数据来源：机构 · 日期 · 口径说明」—— 专业报告里每张图都有 */
  source?: string;
  /**
   * 这张图挂在正文第几段之后 (0 = 第一段之后)。缺省挂到章末。
   *
   * 为什么要它 (用户): 「不应该是每一个论点、每一个这个报告文字、段落和图
   * 都对应吗? 你现在有点不平均」。在这之前正文是一整块、图全堆在正文后面 —— 图和它
   * 支撑的那句话被隔开好几段, 读者得自己找对应关系, 图也就挤成一堆。
   */
  anchor?: number;
}

/**
 * 信息图 —— 不是坐标轴图表, 而是"把结构讲清楚"的那类图。
 *
 * 信息图用于表达结构关系，适合调研报告和后续演示文稿复用。
 *
 * 三种形态直接复用产品已有的卡 (components/NeoxCards):
 *   metrics — 关键数字组: 几个大数 + 变化, 适合"这一章先给量级"
 *   timeline — 事件轴: 时间 + 事件 + 一句说明, 适合上市节奏 / 政策节点
 *   steps — 步骤: 有序的做法或流程, 适合"怎么引用这些数据""验证路径"
 * (flow 那张现在把边堆成图下一行文字, 还不够报告级, 暂不放开。)
 */
export interface NarrativeInfographic {
  /**
   * 前三种是**文字型**结构件 (复用产品已有的卡); 后四种是**几何图形**
   * (山峰 / 漏斗 / 靶心 / 河流), 走图表卡的同名形态, items 只要 {label, value}。
   * 后四种形态属于白名单，使用与图表卡一致的 items 数据。
   */
  kind: 'metrics' | 'timeline' | 'steps' | 'pyramid' | 'funnel' | 'target' | 'river';
  title: string;
  /** metrics: {label,value,delta} · timeline: {time,title,desc} · steps: {title,desc} */
  items: Array<Record<string, string>>;
  source?: string;
}

export interface NarrativeSection {
  title: string;
  /** 章首那句结论 (加粗单独成行) —— 只读每章第一句就能拿到全篇论点 */
  lead?: string;
  /** 分析正文 (markdown 段落) */
  body: string;
  tables: NarrativeTable[];
  charts: NarrativeChart[];
  /** 信息图 (见 NarrativeInfographic) —— 老账本没有这个字段, 渲染要照常 */
  infographics?: NarrativeInfographic[];
}

/**
 * 执行摘要的一块 —— 咨询报告的 SCR/金字塔写法:
 * 加粗主句给判断, 下面的子弹只放支撑它的数字。只读加粗那几行就该拿到完整论点。
 */
export interface NarrativeExecBlock {
  lead: string;
  points: string[];
}

/** 关键指标表 —— 最后一列是"怎么读", 那是判断不是数据 */
export interface NarrativeKpis {
  rows: Array<{ name: string; value: string; change?: string; read: string }>;
  source?: string;
}

/**
 * 一份**写好的报告** —— 代码只当 harness (定章节骨架/每章要什么/图表规则/校验规则),
 * 内容由模型基于全部子 agent 的证据自己发挥。
 *
 * 章节、表格和图表由模型根据账本证据决定，代码只定义结构和校验规则，
 * 以适配不同主题的研究维度。
 */
export interface ResearchNarrative {
  /**
   * 配图规划 —— 模型在写正文**之前**先逐章排一遍图。
   *
   * 预先规划图表以控制各章节的分布，避免图表集中在少数章节。
   * 这份计划不渲染进报告，只用于约束图表分布并校验执行结果。
   */
  figurePlan?: Array<{
    section: string;
    /**
     * 这一章要出的图 —— **一章可以不止一张, 而且信息图也在里面**。
     *
     * 使用数组使每章可以规划多张图，并将信息图纳入同一计划。
     */
    figures: Array<{ kind: 'chart' | 'info'; type: string; shows: string }>;
  }>;
  /** 执行摘要 (SCR): 2-4 块, 每块一句加粗判断 + 支撑它的数字 */
  execSummary?: NarrativeExecBlock[];
  /** 关键指标表: 顶在正文之前, 让读者三秒拿到量级 */
  kpis?: NarrativeKpis;
  /** 摘要: 3-5 条关键判断。execSummary 缺席时的退路, 也用于卡片 */
  summary: string[];
  /** 正文各章 —— 标题、分析、表、图全由模型定 */
  sections: NarrativeSection[];
  /** 真正打架的点 (争点 / 一方 / 另一方 / 判断) */
  /** resolver = 靠什么能把这条定下来 (某个事件 / 某份数据 / 某个时间点) —— 少了它,
   * 缺少 resolver 时只能重复“不确定”，因此该字段描述可解决分歧的依据。 */
  disputes: Array<{ point: string; sideA: string; sideB: string; judgement: string; resolver?: string }>;
  /** 接下来看什么: 观察点 (盯什么信号 + 何时能看到 + 会改变哪条判断), 不是正文复述 */
  recommendations: string[];
  /** 还缺的证据 (并进「未定论」那一节, 不再自己占一节) */
  openQuestions: string[];
  /** 方法与局限 */
  limits: string[];
  /** 谁写的 —— 复盘时要知道是哪个模型归纳的 */
  model?: string;
  generatedAt: string;
  /**
   * stale 表示本轮归纳失败而账本仍保留上一轮 narrative，渲染层据此标记结果过期。
   */
  stale?: boolean;
}

export interface ResearchLedger {
  topic: string;
  slug: string;
  startedAt: string;
  updatedAt: string;
  sources: ResearchSource[];
  claims: ResearchClaim[];
  /** 收尾那一趟归纳的产物; 没有它报告照常出, 只是回落到"算出来的"摘要 */
  narrative?: ResearchNarrative;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 路径
 * ══════════════════════════════════════════════════════════════════════════ */

export function slugifyTopic(topic: string): string {
  const s = topic
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || `research-${Date.now()}`;
}

export function researchDir(workDir: string, slug: string): string {
  return path.join(workDir, '.neox', 'research', slug);
}

function ledgerPath(workDir: string, slug: string): string {
  return path.join(researchDir(workDir, slug), 'ledger.json');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 引句校验 —— 整个账本的闸
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 归一到"可比"的形态再做子串匹配。
 *
 * 抓回来的正文经过 HTML→markdown, 空白、软换行、全角标点跟页面上看到的不完全一致;
 * 模型复制引句时也常顺手改掉空格。所以比之前先:
 *   · 各种空白 (含不间断空格/零宽) 压成单个空格
 *   · markdown 强调符号去掉 (**粗体** 在原文里可能有、引句里没有)
 *   · 全角标点折成半角, 各种引号/破折号统一
 *   · 大小写忽略
 *
 * 刻意**不做**同义改写、不做模糊匹配 —— 那就等于放行"大意是这么说的", 闸就白上了。
 */
export function normalizeForQuoteMatch(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[​-‍﻿]/g, '')
    .replace(/[*_`~]/g, '')
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[—–−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 引句太短就失去校验意义 ("is not" 在任何文档里都命中) */
export const MIN_QUOTE_CHARS = 12;

export interface QuoteCheck {
  ok: boolean;
  reason?: string;
}

/** 引句必须在归档原文里字面命中 (归一化之后)。 */
export function verifyQuote(archiveText: string, quote: string): QuoteCheck {
  const q = quote?.trim() ?? '';
  if (q.length < MIN_QUOTE_CHARS) {
    return { ok: false, reason: `引句太短 (<${MIN_QUOTE_CHARS} 字符), 校验没有意义` };
  }
  const nq = normalizeForQuoteMatch(q);
  if (!nq) return { ok: false, reason: '引句归一化之后是空的' };
  if (!normalizeForQuoteMatch(archiveText).includes(nq)) {
    return { ok: false, reason: '引句在该来源的原文快照里找不到 —— 不许转述, 原样复制一段' };
  }
  return { ok: true };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 账本读写
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 开一个账本 —— **同题目已有账本就接着用, 不重开**。
 *
 * 同一题目的账本复用已有来源和结论，避免续跑时丢失证据。
 * 调研天然可续：每条来源带 fetchedAt，报告也保留抓取时间，
 * 续跑复用已有证据并保留抓取时间；要开始全新一轮则使用新的 slug。
 */
export async function createLedger(workDir: string, topic: string): Promise<ResearchLedger> {
  const slug = slugifyTopic(topic);
  await fs.mkdir(path.join(researchDir(workDir, slug), 'archive'), { recursive: true });

  const existing = await loadLedger(workDir, slug);
  if (existing) {
    /* slug 相同时更新 topic 展示文本，但保留全部证据。 */
    existing.topic = topic;
    return existing;
  }

  const now = new Date().toISOString();
  const ledger: ResearchLedger = { topic, slug, startedAt: now, updatedAt: now, sources: [], claims: [] };
  await saveLedger(workDir, ledger);
  return ledger;
}

export async function loadLedger(workDir: string, slug: string): Promise<ResearchLedger | null> {
  try {
    const raw = await fs.readFile(ledgerPath(workDir, slug), 'utf-8');
    const parsed = JSON.parse(raw) as ResearchLedger;
    /* 结构坏了当"读不出来", 不当空账本 —— 空账本会让调用方以为什么都没查过 */
    if (!parsed || !Array.isArray(parsed.sources) || !Array.isArray(parsed.claims)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveLedger(workDir: string, ledger: ResearchLedger): Promise<void> {
  ledger.updatedAt = new Date().toISOString();
  const dir = researchDir(workDir, ledger.slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(ledgerPath(workDir, ledger.slug), JSON.stringify(ledger, null, 2), 'utf-8');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 来源
 * ══════════════════════════════════════════════════════════════════════════ */

export interface AddSourceInput {
  url: string;
  title: string;
  content: string;
  hostname?: string;
  kind?: SourceKind;
  publishedAt?: string;
  fetchedAt?: string;
}

/**
 * 收一个来源: 原文落归档 + 登记进账本。
 *
 * **按 URL 去重** —— 同一个页面被两个 worker 各抓一次是常态 (滑动窗口下尤其),
 * 重复登记会让"几个独立来源支持"这个判断失真, 那正是 single-source 想防的事。
 * 命中已有来源时返回现有记录并保留归档，确保 fetchedAt 对应的快照不变。
 */
export async function addSource(
  workDir: string,
  ledger: ResearchLedger,
  input: AddSourceInput,
): Promise<ResearchSource> {
  const url = input.url.trim();
  const existing = ledger.sources.find((s) => s.url === url);
  if (existing) return existing;

  let hostname = input.hostname?.trim() || '';
  if (!hostname) {
    try { hostname = new URL(url).hostname; } catch { hostname = 'unknown'; }
  }

  const sid = `S${ledger.sources.length + 1}`;
  const archiveRel = path.join('archive', `${sid}.md`);
  const dir = researchDir(workDir, ledger.slug);
  await fs.mkdir(path.join(dir, 'archive'), { recursive: true });
  await fs.writeFile(path.join(dir, archiveRel), input.content, 'utf-8');

  const source: ResearchSource = {
    sid,
    url,
    title: input.title.trim() || url,
    hostname,
    kind: input.kind ?? 'unknown',
    fetchedAt: input.fetchedAt ?? new Date().toISOString(),
    archivePath: archiveRel,
    chars: input.content.length,
    ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
  };
  ledger.sources.push(source);
  await saveLedger(workDir, ledger);
  return source;
}

/** 读某个来源的原文快照 (引句校验和报告取证都要它) */
export async function readArchive(workDir: string, ledger: ResearchLedger, sid: string): Promise<string | null> {
  const src = ledger.sources.find((s) => s.sid === sid);
  if (!src) return null;
  try {
    return await fs.readFile(path.join(researchDir(workDir, ledger.slug), src.archivePath), 'utf-8');
  } catch {
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 结论
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 状态由证据算出来, **不由调用方指定** —— 否则模型可以自己宣布"已核实"。
 *
 * 有反证 → disputed (压倒一切: 有分歧这件事本身比"几个人支持"重要)
 * 无支持 → unverified
 * 支持来自 1 个来源 → single-source
 * 否则 → supported
 */
export function computeClaimStatus(support: ClaimEvidence[], contradict: ClaimEvidence[]): ClaimStatus {
  if (contradict.length > 0) return 'disputed';
  const distinct = new Set(support.map((e) => e.sid));
  if (distinct.size === 0) return 'unverified';
  if (distinct.size === 1) return 'single-source';
  return 'supported';
}

export interface AddClaimInput {
  text: string;
  support?: ClaimEvidence[];
  contradict?: ClaimEvidence[];
  lean?: string;
  /** 这条结论属于哪个调研角度 —— 报告按它成章, 见 ResearchClaim.angle */
  angle?: string;
}

export interface AddClaimResult {
  ok: boolean;
  claim?: ResearchClaim;
  /** 被拒的引句 —— 逐条说清为什么, 让模型能改对而不是瞎试 */
  rejected?: Array<{ sid: string; quote: string; reason: string }>;
}

/**
 * 入账一条结论。**每一条引句都要过校验**, 有一条不过就整条拒绝。
 *
 * 为什么是"整条拒绝"而不是"丢掉坏的留下好的": 结论的分量取决于它站在几条证据上,
 * 悄悄丢掉一条会把 disputed 变成 supported、把 supported 变成 single-source ——
 * 那是在替模型粉饰。让它自己改对。
 */
export async function addClaim(
  workDir: string,
  ledger: ResearchLedger,
  input: AddClaimInput,
): Promise<AddClaimResult> {
  const support = input.support ?? [];
  const contradict = input.contradict ?? [];
  const rejected: Array<{ sid: string; quote: string; reason: string }> = [];

  const archives = new Map<string, string | null>();
  for (const ev of [...support, ...contradict]) {
    if (!archives.has(ev.sid)) archives.set(ev.sid, await readArchive(workDir, ledger, ev.sid));
    const archive = archives.get(ev.sid) ?? null;
    if (archive === null) {
      rejected.push({ sid: ev.sid, quote: ev.quote, reason: `账本里没有 ${ev.sid} 这个来源, 或它的原文快照读不出来` });
      continue;
    }
    const check = verifyQuote(archive, ev.quote);
    if (!check.ok) rejected.push({ sid: ev.sid, quote: ev.quote, reason: check.reason! });
  }

  if (rejected.length > 0) return { ok: false, rejected };

  /* 同一来源的同一句引文按 (sid, 归一化引句) 去重，避免重复证据增加支持数量。 */
  const dedupe = (list: ClaimEvidence[]): ClaimEvidence[] => {
    const seen = new Set<string>();
    const out: ClaimEvidence[] = [];
    for (const e of list) {
      const key = `${e.sid}::${normalizeForQuoteMatch(e.quote)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
    return out;
  };

  const dedupedSupport = dedupe(support);
  const dedupedContradict = dedupe(contradict);

  /* 反证里有没有"支持方之外"的来源 —— 见 ResearchClaim.crossSource */
  const supportSids = new Set(dedupedSupport.map((e) => e.sid));
  const crossSource = dedupedContradict.length > 0
    ? dedupedContradict.some((e) => !supportSids.has(e.sid))
    : undefined;

  const claim: ResearchClaim = {
    cid: `C${ledger.claims.length + 1}`,
    text: input.text.trim(),
    support: dedupedSupport,
    contradict: dedupedContradict,
    status: computeClaimStatus(dedupedSupport, dedupedContradict),
    ...(crossSource === undefined ? {} : { crossSource }),
    ...(input.lean ? { lean: input.lean } : {}),
    ...(input.angle?.trim() ? { angle: input.angle.trim() } : {}),
  };
  ledger.claims.push(claim);
  await saveLedger(workDir, ledger);
  return { ok: true, claim };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 概览
 * ══════════════════════════════════════════════════════════════════════════ */

export interface LedgerStats {
  sources: number;
  domains: number;
  claims: number;
  supported: number;
  singleSource: number;
  disputed: number;
  unverified: number;
  archivedChars: number;
}

export function ledgerStats(ledger: ResearchLedger): LedgerStats {
  const byStatus = (s: ClaimStatus) => ledger.claims.filter((c) => c.status === s).length;
  return {
    sources: ledger.sources.length,
    domains: new Set(ledger.sources.map((s) => s.hostname)).size,
    claims: ledger.claims.length,
    supported: byStatus('supported'),
    singleSource: byStatus('single-source'),
    disputed: byStatus('disputed'),
    unverified: byStatus('unverified'),
    archivedChars: ledger.sources.reduce((n, s) => n + s.chars, 0),
  };
}
