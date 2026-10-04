/**
 * 账本 → 报告 (重做)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 【这里只做渲染, 不做取舍】
 * 代码是 harness: 定死"报告有哪几块、表怎么画、图什么规则、什么必须校验";
 * **内容全部来自模型的归纳** (ledger.narrative, 见 synthesis.ts), 章节标题、分析、
 * 表格列、图表数据都由它基于全部子 agent 的证据自己发挥 —— 代码不可能预知一次调研
 * 会有哪些维度，固定某一种报告结构会限制不同主题的研究结果。
 *
 * 【为什么没有逐条结论、没有引句、没有来源表】
 * 所以: **cid 只用于校验, 渲染前一律剥掉**; 引句、出处编号、来源清单、附录全部不出现。
 * 证据的可靠性靠 synthesis 那一层保证 (每句话/每行表格都要挂得上账本里真实存在的
 * 结论编号, 挂不上就整条丢掉), 而不是把账本摊在读者面前。
 *
 * 原始证据没有丢: 账本 ledger.json 和原文快照 archive/ 都在盘上, 要查随时查。
 */

import type { ResearchLedger, ClaimStatus, SourceKind, NarrativeTable, NarrativeChart } from './ledger.js';
import { ledgerStats } from './ledger.js';

const STATUS_LABEL: Record<ClaimStatus, string> = {
  supported: '多来源支持',
  'single-source': '单一来源',
  disputed: '有分歧',
  unverified: '未核实',
};

/**
 * 剥掉依据编号。
 *
 * `[C12]` 是**给代码看的**: synthesis 用它校验每句话都挂得上真实结论, 挂不上就丢。
 * 校验完就该消失 —— 读者要的是一份报告, 不是带着内部编号的账本转储。
 */
function stripCites(text: string): string {
  return String(text ?? '')
    .replace(/\[C\d+\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([，。、；：!?)）])/g, '$1')
    .trim();
}

/** 表格单元格: 竖线要转义、换行要压掉, 否则整张表散架 */
function cell(text: string): string {
  return stripCites(text).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

/** 跟 rehype-slug 同规则 —— 目录要跳得动 */
/**
 * 超长段落按句子断开 —— 模型不分段时的兜底。
 *
 * 提示词要求分段，渲染层在模型未分段时提供兜底，确保 anchor 仍有可用段落。
 *
 * 断在句末标点上 (。！？；), 不在句子中间硬切; 攒够 ~140 字才断, 免得断成碎片。
 * 短段原样返回, 不动模型已经分好的段。
 */
export function splitLongParas(paras: string[], softMax = 190, target = 140): string[] {
  const out: string[] = [];
  for (const p of paras) {
    if (p.length <= softMax) { out.push(p); continue; }
    /* 连标点一起留在句子里 (split 会丢标点, 所以用 match) */
    const sents = p.match(/[^。！？；!?;]+[。！？；!?;]*/g) ?? [p];
    let buf = '';
    for (const s of sents) {
      buf += s;
      if (buf.length >= target) { out.push(buf.trim()); buf = ''; }
    }
    if (buf.trim()) {
      /* 收尾太短就并回上一段, 免得掉出一个孤零零的半句 */
      if (buf.trim().length < 40 && out.length > 0) out[out.length - 1] += buf.trim();
      else out.push(buf.trim());
    }
  }
  return out;
}

/**
 * 给"我们自己要加粗"的那几行用: 剥 cid **再剥掉模型自带的强调符**。
 *
 * 模型可能在 lead 中自行添加强调符；渲染层统一剥除，避免与外层强调嵌套。
 */
/** 几何信息图 —— 走图表卡的同名形态, 不是文字型结构件 */
const GEO_INFO = new Set(['pyramid', 'funnel', 'target', 'river']);

export function plain(text: string): string {
  return stripCites(text).replace(/\*\*/g, '').replace(/__/g, '').trim();
}

function slug(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

function renderTable(t: NarrativeTable, no: number): string[] {
  const headers = t.headers.map((h) => cell(h));
  const width = headers.length;
  const rows = t.rows
    .map((r) => {
      const cells = r.slice(0, width).map((c) => cell(c));
      while (cells.length < width) cells.push('');
      return `| ${cells.join(' | ')} |`;
    });
  return [
    /* 题注给**独立类名**而不是加粗段落 : 执行摘要的主句同样是加粗段落,
     * 靠 CSS 的 :has(strong) 去认题注会把那些主句一起改了。类名是确定的锚点。 */
    `<p class="nx-figcap">表 ${no} · ${cell(t.title)}</p>`,
    '',
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows,
    '',
  ];
}

/**
 * 柱状图使用产品自带的 chart 卡，以保持报告与界面的一致视觉和尺寸约束。
 * mermaid 的 xychart 是默认皮: 粗黑坐标轴、等宽字体、柱子铺满整格、没有数值标签,
 * 而且 svg 带 width:100%, 正文宽 860 时被等比放成 860×614, 一张图吃掉大半页。
 *
 * 产品自带的 chart 卡是同一套设计语言: 浅网格线 + 柱顶数值 + 正文同款字体 + 主题色 token,
 * 高度只有 mermaid 的三分之一; 纵轴恒从 0 起 (niceMax), 不会出现"自动基线把差距抹平";
 * 标签太长或条目超过 8 个会自动降级成横条图, 长标签在左侧一列放得下全名。
 * 导出 PDF 抓的是**已渲染 DOM**, 所以这张卡在 PDF 里同样成立。
 */
function renderChart(c: NarrativeChart, no: number): string[] {
  const safe = (s: string) => cell(s).replace(/"/g, '');
  /* 标签原样交给卡片，由卡片按长度和条目数选择横条布局。 */
  const payload = {
    /* 标题不进卡片: 上面那行「图 N · …」已经是题注, 卡片再来一遍就是重复。
     * 形态由模型按数据性质选 (synthesis 那层已经过白名单), 没给就按类别对比画柱状。 */
    type: c.type || 'column',
    /* 报告画幅 —— 聊天里的图是压扁的文中插图, 报告里的图是主角, 见 ChartData.size */
    size: 'report',
    ...(c.yLabel ? { unit: safe(c.yLabel) } : {}),
    series: c.labels.map((l, i) => ({ label: safe(l), value: c.values[i] })),
    /* 多系列: labels 当横轴类别, 每个 series 一种颜色 —— 颜色这才编码了信息。
     * 单系列时不发这个字段, 卡片照旧画单色渐变柱 (一根柱一个色只是彩虹)。 */
    ...(c.series && c.series.length > 1
      ? { multi: c.series.slice(0, 4).map((s) => ({ name: safe(s.name), values: s.values })) }
      : {}),
  };
  return [
    `<p class="nx-figcap">图 ${no} · ${cell(c.title)}</p>`,
    '',
    '```neox-card:chart',
    JSON.stringify(payload),
    '```',
    '',
    /* 图说在图**下面**、来源**上面**: 标题给结论, 图说说该看哪儿, 来源给可核对性 */
    ...(c.note ? [`<p class="nx-fignote">${cell(c.note)}</p>`, ''] : []),
  ];
}

export interface RenderReportOptions {
  /** 报告标题, 默认用账本的 topic */
  title?: string;
}

/** 把账本渲染成一份可交付的 markdown 报告。 */
export function renderReportMarkdown(ledger: ResearchLedger, opts: RenderReportOptions = {}): string {
  const st = ledgerStats(ledger);
  const nar = ledger.narrative;
  const parts: string[] = [];

  parts.push(`# ${opts.title || ledger.topic}`, '');
  parts.push(
    `**调研期间** ${ledger.startedAt.slice(0, 10)} ｜ **覆盖** ${st.domains} 个站点 · ${st.sources} 篇资料`
    + ` ｜ **方法** 多路并行检索 + 逐条原文核对`,
    '',
  );

  /* 归纳没跑成 —— 照实说, 但**绝不**回落成逐条转储 (那正是用户骂了四轮的东西) */
  if (!nar) {
    parts.push(
      '> [!WARNING]',
      '> 这一轮的归纳没有完成，报告正文写不出来。',
      `> 已核对的材料都在账本里（${st.claims} 条结论 / ${st.sources} 篇资料），可以重跑归纳。`,
      '',
    );
    return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  /* 这份正文是上一轮留下的 —— 必须在最显眼的位置说清楚, 否则读者会当成本轮结论 */
  if (nar.stale) {
    parts.push(
      '> [!WARNING]',
      `> 下面的正文来自**上一轮归纳**（${nar.generatedAt.slice(0, 16).replace('T', ' ')}），本轮的收尾归纳没有跑成。`,
      '> 账本里的证据已经是最新的，但结论段落还没跟上 —— 重跑一次归纳即可。',
      '',
    );
  }

  /* ── 执行摘要 ── SCR/金字塔: 加粗主句给判断, 子弹只放数字。
   * 只读加粗那几行就该拿到完整论点 —— 这是咨询报告和"要点罗列"的分界线。
   * 老账本没有 execSummary, 退回到 summary 那版列表, 不能因为字段新增就渲不出来。 */
  const exec = nar.execSummary ?? [];
  if (exec.length > 0) {
    parts.push('## 执行摘要', '');
    for (const b of exec) {
      parts.push(`**${plain(b.lead)}**`, '');
      for (const p of b.points) parts.push(`- ${plain(p)}`);
      parts.push('');
    }
  } else if (nar.summary.length > 0) {
    parts.push('## 摘要', '');
    for (const s of nar.summary) parts.push(`- ${stripCites(s)}`);
    parts.push('');
  }

  /* ── 关键指标 ── 顶在正文之前, 三秒拿到量级; 最后一列是判断不是数据 */
  if (nar.kpis && nar.kpis.rows.length > 0) {
    const hasChange = nar.kpis.rows.some((r) => !!r.change);
    parts.push(
      '## 关键指标',
      '',
      hasChange ? '| 指标 | 数值 | 变化 | 怎么读 |' : '| 指标 | 数值 | 怎么读 |',
      hasChange ? '|---|---|---|---|' : '|---|---|---|',
      ...nar.kpis.rows.map((r) => (hasChange
        ? `| ${cell(r.name)} | ${cell(r.value)} | ${cell(r.change || '—')} | ${stripCites(cell(r.read))} |`
        : `| ${cell(r.name)} | ${cell(r.value)} | ${stripCites(cell(r.read))} |`)),
      '',
    );
    if (nar.kpis.source) parts.push(`<p class="nx-figsrc">数据来源：${cell(nar.kpis.source)}</p>`, '');
  }

  /* ── 目录 ── */
  const toc = nar.sections.map((s, i) => `- [${i + 1}. ${s.title}](#${slug(`${i + 1}. ${s.title}`)})`);
  if (nar.disputes.length > 0 || nar.openQuestions.length > 0) {
    toc.push(`- [未定论：分歧在哪、靠什么能定](#${slug('未定论：分歧在哪、靠什么能定')})`);
  }
  if (nar.recommendations.length > 0) toc.push(`- [接下来看什么](#${slug('接下来看什么')})`);
  if (toc.length > 2) parts.push('## 目录', '', ...toc, '');

  /* ── 正文 ── 章节、表、图全由模型定 */
  let tableNo = 0;
  let chartNo = 0;
  nar.sections.forEach((sec, i) => {
    parts.push(`## ${i + 1}. ${sec.title}`, '');
    /* 章首先给结论再展开论证 —— 顺序反过来读者就得读完整章才知道要点 */
    if (sec.lead) parts.push(`**${plain(sec.lead)}**`, '');
    /* 正文按空行分段 —— 图要能挂在具体某一段之后 (见 NarrativeChart.anchor) */
    const paras = splitLongParas(
      stripCites(sec.body).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean),
    );
    /* ── 图的排版 ── 窄的两两并排, 宽的独占一行 (用户第二次说这件事:
     *「有的信息图感觉宽度用不到, 你就可以显示为两个信息图, 两列」)。
     *
     * 哪些算"宽": 河流和折线/面积把信息摊在**横轴**上, 半宽会把时间点挤在一起;
     * 其余形态 (柱状、饼、靶心、山峰、漏斗、词云) 的图形本身只占容器一半左右,
     * 独占一行就是右边白掉一片。
     *
     * 配对按顺序两两成组, 奇数时最后一张独占 —— 不重排顺序, 因为图是跟着正文讲的。 */
    const WIDE = new Set(['river', 'line', 'area']);
    type Fig = { wide: boolean; lines: string[]; anchor?: number };
    const figs: Fig[] = [
      ...sec.charts.map((c): Fig => {
        chartNo += 1;
        return {
          wide: WIDE.has(c.type || 'column'),
          ...(c.anchor !== undefined ? { anchor: c.anchor } : {}),
          /* 来源行贴着图走 —— 专业报告里图表下面这一行说清机构/日期/口径, 缺了就是没出处的数 */
          lines: [...renderChart(c, chartNo), ...(c.source ? [`<p class="nx-figsrc">数据来源：${cell(c.source)}</p>`, ''] : [])],
        };
      }),
      /* 信息图跟图共用「图 N」编号 —— 对读者来说它们都是图, 分两套号只会让引用变乱 */
      /* 渲染层也要挡一次"没数值的几何图" : 归纳层已经加了守卫, 但
       * **旧账本里已经躺着**没有 value 的 items —— 重渲同样会画出一圈等大的环、
       * 三层等宽的漏斗、一条平直的河流, 每个数字都是 0。那种图看着像正经图,
       * 读者会从等大的环里读出"差不多"这个完全错误的结论, 比没有图糟得多。 */
      ...(sec.infographics ?? []).filter((g) => {
        if (!GEO_INFO.has(g.kind)) return true;
        const nums = g.items.map((it) => Number(String(it.value ?? '').replace(/[^\d.-]/g, '')));
        return nums.some((v) => Number.isFinite(v) && v !== 0);
      }).map((g): Fig => {
        chartNo += 1;
        return {
          wide: false,
          lines: [
            `<p class="nx-figcap">图 ${chartNo} · ${cell(g.title)}</p>`,
            '',
            /* 几何信息图 (山峰/漏斗/靶心/河流) 走**图表卡**的同名形态, 数据是 labels/values;
             * 文字型那三种 (metrics/timeline/steps) 各有自己的卡。分流在这里做, 因为
             * 卡片名和 kind 只有这三种是同名的。 */
            GEO_INFO.has(g.kind) ? '```neox-card:chart' : `\`\`\`neox-card:${g.kind}`,
            /* 信息图 items 统一经过 cell/stripCites，避免内部引用编号出现在报告中。 */
            GEO_INFO.has(g.kind)
              ? JSON.stringify({
                type: g.kind,
                size: 'report',
                series: g.items.map((it) => ({
                  label: cell(String(it.label ?? '')),
                  value: Number(String(it.value ?? '').replace(/[^\d.-]/g, '')) || 0,
                })),
              })
              : JSON.stringify({
                title: cell(g.title),
                /* 报告态标记 —— 时间线在报告里要换成带刻度轴的版式, 聊天里那版是
                 * 带竖线的列表 (需求： 「这个样式太丑了, 还跟他妈全是文字一样」) */
                size: 'report',
                items: g.items.map((it) => Object.fromEntries(
                  Object.entries(it).map(([k, v]) => [k, cell(String(v ?? ''))]),
                )),
              }),
            '```',
            '',
            ...(g.source ? [`<p class="nx-figsrc">数据来源：${cell(g.source)}</p>`, ''] : []),
          ],
        };
      }),
    ];
    const pushPair = (a: Fig, b: Fig) => {
      parts.push('<div class="nx-figs">', '');
      for (const f of [a, b]) parts.push('<div class="nx-fig">', '', ...f.lines, '</div>', '');
      parts.push('</div>', '');
    };
    /** 同一批图: 窄的两两并排, 宽的独占一行 */
    const pushGroup = (group: Fig[]) => {
      for (let k = 0; k < group.length;) {
        const cur = group[k];
        const next = group[k + 1];
        if (!cur.wide && next && !next.wide) { pushPair(cur, next); k += 2; } else { parts.push(...cur.lines); k += 1; }
      }
    };

    /* ── 图文交错 ── 每张图挂在它支撑的那一段之后 (需求：「不应该是每一个
     * 论点、每一个报告文字、段落和图都对应吗? 你现在有点不平均」)。
     * 没写 anchor 的、或者 anchor 超出段数的, 一律挂到章末 —— 不猜, 也不丢。 */
    const byPara = new Map<number, Fig[]>();
    const tail: Fig[] = [];
    figs.forEach((f) => {
      const at = f.anchor;
      if (at === undefined || at >= paras.length) { tail.push(f); return; }
      byPara.set(at, [...(byPara.get(at) ?? []), f]);
    });
    paras.forEach((p, pi) => {
      parts.push(p, '');
      const here = byPara.get(pi);
      if (here) pushGroup(here);
    });
    pushGroup(tail);
    for (const t of sec.tables) {
      tableNo += 1;
      parts.push(...renderTable(t, tableNo));
      if (t.source) parts.push(`<p class="nx-figsrc">数据来源：${cell(t.source)}</p>`, '');
    }
  });

  /* ── 争议 ── 整个功能最值钱的东西: 两边都摆出来, 再给判断 */
  if (nar.disputes.length > 0) {
    /* 争议使用独立小节，分别呈现双方说法和判断，避免长文本挤在表格单元格中。 */
    parts.push('## 未定论：分歧在哪、靠什么能定', '');
    nar.disputes.forEach((d, i) => {
      parts.push(
        `### 争点 ${i + 1} · ${stripCites(d.point)}`,
        '',
        ...(d.sideA ? [`**一方**：${stripCites(d.sideA)}`, ''] : []),
        ...(d.sideB ? [`**另一方**：${stripCites(d.sideB)}`, ''] : []),
        ...(d.judgement ? [`**判断**：${stripCites(d.judgement)}`, ''] : []),
        ...(d.resolver ? [`**怎么能定**：${stripCites(d.resolver)}`, ''] : []),
      );
    });
    /* 未成对的疑问并入同一节，避免重复表达未决状态。 */
    if (nar.openQuestions.length > 0) {
      parts.push('### 还缺的证据', '', ...nar.openQuestions.map((q) => `- ${stripCites(q)}`), '');
    }
  }

  /* “接下来看什么”只列观察点、触发条件和受影响的判断，不复述正文。 */
  if (nar.recommendations.length > 0) {
    parts.push('## 接下来看什么', '', ...nar.recommendations.map((r) => `- ${stripCites(r)}`), '');
  }

  /* ── 方法与局限 ── 正经报告都有这一节: 什么没覆盖、哪些证据弱 */
  const limits = [...nar.limits.map(stripCites)];
  /* 模型已覆盖来源范围时不重复追加统计。 */
  const saidCoverage = limits.some((l) => /单一来源|未进入|覆盖面/.test(l));
  if (!saidCoverage && st.singleSource > 0 && st.claims > 0) {
    limits.push(`本轮 ${st.claims} 条核对过的结论中，${st.singleSource} 条只有单一来源支撑，`
      + `${st.disputed} 条各来源说法不一。`);
  }
  limits.push('未覆盖到的问题不会出现在上面；原始材料与网页快照已归档，可回溯核对。');
  parts.push('## 方法与局限', '', ...limits.map((l) => `- ${l}`), '');

  /* 来源折叠放在末尾；summary 后的空行保证列表按 Markdown 解析。 */
  if (ledger.sources.length > 0) {
    const line = (s: ResearchLedger['sources'][number]) => {
      const title = cell(s.title || s.hostname).slice(0, 60);
      const when = (s.publishedAt || s.fetchedAt || '').slice(0, 10);
      return `- [${title}](${s.url})${when ? ` · ${when}` : ''}`;
    };
    parts.push(
      '<details>',
      `<summary>来源（${ledger.sources.length}）</summary>`,
      '',
      ...ledger.sources.map(line),
      '',
      '</details>',
      '',
    );
  }

  /* 保留 Markdown 结构所需的空行，再压缩多余空行。 */
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/**
 * 给右栏看板用的结构 (不落渲染文案 —— 按仓库规矩, 渲染层自己决定怎么画)。
 */
export interface ResearchBoardData {
  topic: string;
  stats: ReturnType<typeof ledgerStats>;
  claims: Array<{
    cid: string;
    text: string;
    status: ClaimStatus;
    statusLabel: string;
    support: Array<{ sid: string; url: string; hostname: string; quote: string; loc?: string }>;
    contradict: Array<{ sid: string; url: string; hostname: string; quote: string; loc?: string }>;
    lean?: string;
  }>;
  sources: Array<{ sid: string; url: string; title: string; hostname: string; kind: SourceKind; publishedAt?: string; fetchedAt: string }>;
}

export function buildBoardData(ledger: ResearchLedger): ResearchBoardData {
  const resolve = (ev: { sid: string; quote: string; loc?: string }) => {
    const src = ledger.sources.find((s) => s.sid === ev.sid);
    return { sid: ev.sid, url: src?.url ?? '', hostname: src?.hostname ?? '', quote: ev.quote, loc: ev.loc };
  };
  return {
    topic: ledger.topic,
    stats: ledgerStats(ledger),
    claims: ledger.claims.map((c) => ({
      cid: c.cid,
      text: c.text,
      status: c.status,
      statusLabel: STATUS_LABEL[c.status],
      support: c.support.map(resolve),
      contradict: c.contradict.map(resolve),
      lean: c.lean,
    })),
    sources: ledger.sources.map((s) => ({
      sid: s.sid, url: s.url, title: s.title, hostname: s.hostname,
      kind: s.kind, publishedAt: s.publishedAt, fetchedAt: s.fetchedAt,
    })),
  };
}
