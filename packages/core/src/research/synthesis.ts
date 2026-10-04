/**
 * 收敛 —— 把一账本发现归纳成结论
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 并行取证后需要将账本中的事实收敛为判断，避免报告退化为逐条证据列表。
 *
 * 输入只包含已通过原文引句校验的结论；模型负责归纳而不是生成未经验证的事实。
 * 每个判断都要求引用账本编号并在生成后校验，解析失败则回落到计算摘要。
 *   · 要求每个判断标 [C12] 依据, 生成后**逐个校验**, 账本里没有的编号直接剔掉
 *   · 整段拿不到 / JSON 解析不出来 → 返回 null, 报告回落到"算出来的"摘要, 绝不阻断产出
 *
 * 结果写回 ledger.narrative，报告保持可复现、可核对的纯投影。
 */

import type {
  ResearchLedger, ResearchNarrative, NarrativeTable, NarrativeChart, NarrativeSection,
  NarrativeInfographic,
} from './ledger.js';
import { buildSynthesisPrompt } from './prompts.js';
/* 纯文本工具, 单向依赖 (report 不认识 synthesis): 账本层就把整章一段的正文断开 */
import { splitLongParas } from './report.js';

export interface SynthesisDeps {
  /** 跑一次 leader 模型, 返回它输出的文本。失败就抛 —— 这里会接住。 */
  runLeader: (prompt: string) => Promise<string>;
  /** 谁写的, 记进账本方便复盘 */
  model?: string;
}

/** 从模型输出里抠出 JSON —— 它可能裹了代码块围栏, 也可能前后带几句废话。 */
export function extractJson(raw: string): unknown | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  if (start < 0) return null;
  const end = body.lastIndexOf('}');
  if (end > start) {
    try { return JSON.parse(body.slice(start, end + 1)); } catch { /* 往下试修复 */ }
  }
  return repairTruncatedJson(body.slice(start));
}

/**
 * 修复被输出上限截断的 JSON。
 *
 * 那一轮归纳输出了 15,420 个 token (整份报告结构都在里面), 只因为撞上模型的输出上限、
 * 结尾停在半个字符串上, 整份就被判"不是 JSON" 作废, 白花 ¥0.3。
 * 内容明明有 95% 是完整的 —— 丢掉它不合理。
 *
 * 做法: 从头扫一遍, 记住括号栈和字符串状态; 回退到最后一个**安全切点**
 * (不在字符串里、且刚好结束一个元素的位置), 然后按栈补上 ] 和 }。
 * 补出来的对象会少最后一两个元素 —— 那正是被截掉的部分, 不是我们编的。
 */
function repairTruncatedJson(src: string): unknown | null {
  /* 扫一遍, 记下每个"可能的元素边界"以及在那个位置上的括号栈快照。
   *
   *  不要试图用状态机精确判断"这里是不是一个值的结尾" (第一版就栽在这): 字符串闭合
   * 时无条件记点, 结果切在了**键**上 —— `{"title"` 补完括号仍然非法。
   * 改成**候选 + 回退重试**: 从最靠后的候选点往前试, 补齐括号后谁先 parse 成功就用谁。
   * 慢一点但不会想当然, 而且天然覆盖了"截在键上/值上/数组里"所有情形。 */
  const cuts: Array<{ at: number; stack: string[] }> = [];
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') { stack.push(c === '{' ? '}' : ']'); continue; }
    if (c === '}' || c === ']') {
      stack.pop();
      if (stack.length > 0) cuts.push({ at: i, stack: [...stack] });
      continue;
    }
    /* 逗号前一位是上一个元素的结尾 —— 切在这里就自然丢掉那个逗号 */
    if (c === ',' && stack.length > 0) cuts.push({ at: i - 1, stack: [...stack] });
  }
  /* 最后那个元素往往是**完整的**, 只差闭合括号 (`{"a":[1,2,3` 里的 3)。
   * 不把"结尾"也当候选, 就会白丢一个已经写完的元素 —— 单测里 [1,2,3] 变成 [1,2] 正是这个。
   * 只在不处于字符串中时才算数: 断在半句话里的那种, 靠前面的候选点回退。 */
  if (!inStr && stack.length > 0) {
    const tail = src.replace(/\s+$/, '').length - 1;
    if (tail >= 0) cuts.push({ at: tail, stack: [...stack] });
  }
  /* 最多回退 200 个候选: 再多说明这段根本不是 JSON, 继续试只是烧 CPU */
  for (const cut of cuts.slice(-200).reverse()) {
    let out = src.slice(0, cut.at + 1).replace(/,\s*$/, '');
    for (let i = cut.stack.length - 1; i >= 0; i -= 1) out += cut.stack[i];
    try { return JSON.parse(out); } catch { /* 换上一个候选点 */ }
  }
  return null;
}

/**
 * 剔掉账本里不存在的结论编号。
 *
 * 模型偶尔会顺手编一个 [C99] —— 那正是整个功能最不能容忍的东西 (我们卖的就是"每句话
 * 都能追到出处")。存在的原样留着, 不存在的连同方括号一起删, 并计数上报。
 */
export function pruneCitations(text: string, validCids: Set<string>): { text: string; dropped: number } {
  let dropped = 0;
  const out = String(text ?? '').replace(/\[(C\d+)\]/g, (whole, cid: string) => {
    if (validCids.has(cid)) return whole;
    dropped += 1;
    return '';
  });
  return { text: out.replace(/\s{2,}/g, ' ').trim(), dropped };
}

/**
 * 截断优先落在句读处。
 *
 * 未超限时保留原文；超限时退到最近的句读，避免在句子中间截断。
 */
export function clipAt(s: string, max: number): string {
  const t = String(s ?? '').trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  /* 断点**按句读级别**依次退 (自查): 只取"最靠后的标点"会优先断在空格上,
   * 于是切出「Galaxy Z…」这种半个词组 —— 空格是词边界, 不是句读。
   * 句级 (。；!?) > 分句级 (，、·) > 词边界 (空格/括号), 前一级找得到就不用后一级。 */
  const LADDER = [['。', '；', ';', '!', '！', '?', '？'], ['，', ',', '、', '·'], [' ', ')', '）']];
  let cut = -1;
  for (const group of LADDER) {
    cut = Math.max(...group.map((p) => head.lastIndexOf(p)));
    if (cut > max * 0.5) break;
  }
  /* 退得太狠 (不到一半) 就宁可硬切 —— 那说明这段话本身没有句读可退 */
  return (cut > max * 0.5 ? head.slice(0, cut) : head).replace(/[，,、·\s]+$/, '') + '…';
}

const asStrings = (v: unknown, max: number): string[] =>
  (Array.isArray(v) ? v : [])
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter(Boolean)
    .slice(0, max);

/**
 * 归纳一次。**永远不抛** —— 拿不到就返回 null, 调用方照常出报告。
 * 调研已经花掉几分钟和一堆 token, 不能因为收尾这一步失败就什么都不给。
 */
export async function synthesizeNarrative(
  ledger: ResearchLedger,
  deps: SynthesisDeps,
): Promise<{ narrative: ResearchNarrative | null; droppedCitations: number; error?: string }> {
  if (ledger.claims.length === 0) return { narrative: null, droppedCitations: 0, error: '账本是空的' };

  let raw = '';
  try {
    raw = await deps.runLeader(buildSynthesisPrompt(ledger));
  } catch (e) {
    return { narrative: null, droppedCitations: 0, error: (e as Error)?.message || '归纳调用失败' };
  }

  const parsed = extractJson(raw) as Record<string, unknown> | null;
  if (!parsed) return { narrative: null, droppedCitations: 0, error: '归纳输出不是 JSON' };

  const validCids = new Set(ledger.claims.map((c) => c.cid));
  let dropped = 0;
  const clean = (s: string): string => {
    const r = pruneCitations(s, validCids);
    dropped += r.dropped;
    return r.text;
  };

  const summary = asStrings(parsed.summary, 6).map(clean).filter(Boolean);
  const recommendations = asStrings(parsed.recommendations, 6).map(clean).filter(Boolean);
  const openQuestions = asStrings(parsed.openQuestions, 5).map(clean).filter(Boolean);
  const limits = asStrings(parsed.limits, 4).map(clean).filter(Boolean);

  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

  /** 表格行要**挂得上依据**才留 —— 表里的字是模型写的, 这是唯一的兜底 */
  const takeTable = (raw: unknown): NarrativeTable | null => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const headers = asStrings(o.headers, 8);
    if (headers.length < 2) return null;
    const rows = (Array.isArray(o.rows) ? o.rows : [])
      .map((r) => (Array.isArray(r) ? r.map((c) => str(c)) : []))
      .filter((r) => r.length > 0)
      .filter((r) => {
        /* 整行一个有效编号都没有 = 没有依据, 丢掉 */
        const joined = r.join(' ');
        return /\[(C\d+)\]/.test(joined) && [...joined.matchAll(/\[(C\d+)\]/g)].some((m) => validCids.has(m[1]));
      })
      .map((r) => r.map(clean).map((c) => c.slice(0, 160)))
      .slice(0, 20);
    if (rows.length === 0) return null;
    return {
      title: clean(str(o.title)) || '对照',
      headers: headers.map((h) => h.slice(0, 24)),
      rows,
      ...(clean(str(o.source)) ? { source: clean(str(o.source)).slice(0, 160) } : {}),
    };
  };

  const takeChart = (raw: unknown): NarrativeChart | null => {
    const o = (raw ?? {}) as Record<string, unknown>;
    /* 上限按图表形态设置：词云 20 项、横条 12 项、其他图表 6 项。 */
    const rawTypeForCap = str(o.type).toLowerCase();
    const cap = /cloud|wordcloud|keyword|tag/.test(rawTypeForCap) ? 20
      : /hbar|barh|horizontal/.test(rawTypeForCap) ? 12
      : 6;
    const labels = asStrings(o.labels, cap);
    const values = (Array.isArray(o.values) ? o.values : [])
      .map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN))
      .filter((v) => !Number.isNaN(v))
      .slice(0, cap);
    /* 少于两个点不成图; 标签和数值对不上也不画 —— 画错的图比没有图更糟 */
    if (labels.length < 2 || labels.length !== values.length) return null;
    /* 坐标轴图至少需要 3 个点；词云和几何信息图不受此下限约束。 */
    const AXIS = new Set(['column', 'hbar', 'line', 'area', 'pie', 'donut']);
    const typeForFloor = (() => {
      const t = str(o.type).toLowerCase();
      if (/^(bar|barchart|columns)$/.test(t)) return 'column';
      if (/^(barh|horizontal)$/.test(t)) return 'hbar';
      if (/^(trend)$/.test(t)) return 'line';
      if (/^(doughnut|ring)$/.test(t)) return 'donut';
      return t || 'column';
    })();
    if (AXIS.has(typeForFloor) && labels.length < 3) return null;
    /* 形态白名单 —— 模型爱写 "bar"/"barchart"/"趋势图" 这类别名, 认不出的一律回落 column,
     * 绝不把别名原样透给渲染层 (那边认不出会退成默认, 反而更难查)。 */
    const rawType = str(o.type).toLowerCase();
    const CHART_TYPES = [
      'column', 'line', 'area', 'pie', 'donut', 'hbar', 'cloud',
      /* 信息图形状 : 数据形状跟其它图一样是 labels/values, 只是画法不同 */
      'pyramid', 'funnel', 'target', 'river',
    ] as const;
    const alias: Record<string, typeof CHART_TYPES[number]> = {
      bar: 'column', barchart: 'column', columns: 'column',
      trend: 'line', 时间序列: 'line',
      doughnut: 'donut', ring: 'donut',
      barh: 'hbar', horizontal: 'hbar',
      wordcloud: 'cloud', keywords: 'cloud', tags: 'cloud',
    };
    const type = (CHART_TYPES as readonly string[]).includes(rawType)
      ? rawType as typeof CHART_TYPES[number]
      : alias[rawType];
    return {
      title: clean(str(o.title)) || '对比',
      ...(type ? { type } : {}),
      labels,
      values,
      /* 多系列: 每条的值必须跟 labels 一一对应, 对不上的整条丢掉 (画错的图比没图糟)。
       * 最多 4 条 —— 再多颜色就分不清了, 那是热力图该干的活。 */
      ...(() => {
        const ms = (Array.isArray(o.series) ? o.series : [])
          .map((s) => {
            const so = (s ?? {}) as Record<string, unknown>;
            const name = clean(str(so.name));
            const vs = (Array.isArray(so.values) ? so.values : [])
              .map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN));
            if (!name || vs.length !== labels.length || vs.some(Number.isNaN)) return null;
            return { name: name.slice(0, 24), values: vs };
          })
          .filter((x): x is { name: string; values: number[] } => x !== null)
          .slice(0, 4);
        return ms.length > 1 ? { series: ms } : {};
      })(),
      ...(clean(str(o.note)) ? { note: clean(str(o.note)).slice(0, 200) } : {}),
      yLabel: clean(str(o.yLabel)) || undefined,
      ...(clean(str(o.source)) ? { source: clean(str(o.source)).slice(0, 160) } : {}),
      /* 挂在第几段之后 —— 负数/非整数当没写 (渲染层会挂到章末) */
      ...(Number.isInteger(o.anchor) && (o.anchor as number) >= 0 ? { anchor: o.anchor as number } : {}),
    };
  };

  /* 执行摘要 (SCR): 一块 = 一句加粗判断 + 支撑它的几条数字。
   * 没有 lead 的块直接丢 —— 只有子弹没有判断, 那又退回成"平铺"了。 */
  const execSummary = (Array.isArray(parsed.execSummary) ? parsed.execSummary : [])
    .map((b) => {
      const o = (b ?? {}) as Record<string, unknown>;
      const lead = clean(str(o.lead));
      if (!lead) return null;
      return { lead: lead.slice(0, 200), points: asStrings(o.points, 5).map(clean).filter(Boolean) };
    })
    .filter((x): x is { lead: string; points: string[] } => x !== null)
    .slice(0, 4);

  /* 关键指标表: 没有"怎么读"就只是一张数字表, 判断才是我们要卖的东西 —— 所以缺了就丢 */
  const kpiRows = (Array.isArray((parsed.kpis as any)?.rows) ? (parsed.kpis as any).rows : [])
    .map((r: unknown) => {
      const o = (r ?? {}) as Record<string, unknown>;
      const name = clean(str(o.name));
      const value = clean(str(o.value));
      const read = clean(str(o.read));
      if (!name || !value || !read) return null;
      return {
        name: clipAt(name, 48),
        value: clipAt(value, 72),
        read: clipAt(read, 160),
        ...(clean(str(o.change)) ? { change: clipAt(clean(str(o.change)), 48) } : {}),
      };
    })
    .filter((x: unknown): x is NonNullable<typeof x> => x !== null)
    .slice(0, 10);
  const kpis = kpiRows.length > 0
    ? {
      rows: kpiRows,
      ...(clean(str((parsed.kpis as any)?.source)) ? { source: clean(str((parsed.kpis as any).source)).slice(0, 160) } : {}),
    }
    : undefined;

  /* 信息图: 三种形态各有自己的字段, 统一按"每项至少要有一个非空值"收 —— 空壳子
   * 渲出来就是一排空框, 比没有更糟。 */
  /** 几何信息图 —— 靠 value 画形状, 没有数就不成图 */
  const GEO_INFO_KINDS = new Set(['pyramid', 'funnel', 'target', 'river']);
  const INFO_FIELDS: Record<string, string[]> = {
    metrics: ['label', 'value', 'delta'],
    timeline: ['time', 'title', 'desc'],
    steps: ['title', 'desc', 'status'],
    /* 几何信息图使用 label/value 字段，并复用图表卡的同名形态。 */
    pyramid: ['label', 'value'],
    funnel: ['label', 'value'],
    target: ['label', 'value'],
    river: ['label', 'value'],
  };
  const takeInfographic = (raw: unknown): NarrativeInfographic | null => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const kind = clean(str(o.kind)).toLowerCase();
    const fields = INFO_FIELDS[kind];
    if (!fields) return null;
    const items = (Array.isArray(o.items) ? o.items : [])
      .map((it) => {
        const r = (it ?? {}) as Record<string, unknown>;
        const cell: Record<string, string> = {};
        for (const f of fields) {
          /* 几何图的 value 允许数字，先转为字符串再统一清理。 */
          const raw0 = r[f];
          const s = typeof raw0 === 'number' && Number.isFinite(raw0) ? String(raw0) : str(raw0);
          const v = clipAt(clean(s), f === 'desc' ? 80 : 40);
          if (v) cell[f] = v;
        }
        return cell;
      })
      .filter((c) => Object.keys(c).length > 0)
      .slice(0, 8);
    if (items.length < 2) return null;   /* 一项的"信息图"就是一句话, 不值当占一块版面 */
    /* 几何图形靠 value 决定环的大小/层的宽度/带子的粗细 —— 拿不到数就别画。
     * 全 0 的图比没有图更糟: 它看起来像一张正经图, 读者会从等大的环里读出"差不多"。 */
    if (GEO_INFO_KINDS.has(kind)) {
      const nums = items.map((c) => Number(String(c.value ?? '').replace(/[^\d.-]/g, '')));
      if (nums.some((v) => !Number.isFinite(v)) || nums.every((v) => v === 0)) return null;
    }
    return {
      kind: kind as NarrativeInfographic['kind'],
      title: clipAt(clean(str(o.title)), 40) || '概览',
      items,
      ...(clean(str(o.source)) ? { source: clipAt(clean(str(o.source)), 160) } : {}),
    };
  };

  const sections = (Array.isArray(parsed.sections) ? parsed.sections : [])
    .map((s) => {
      const o = (s ?? {}) as Record<string, unknown>;
      const title = clean(str(o.title));
      /* 在账本层拆分过长正文，确保 anchor 有稳定的段落索引。 */
      const body = splitLongParas(
        clean(str(o.body)).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean),
      ).join('\n\n');
      if (!title || !body) return null;
      return {
        title: title.slice(0, 60),
        ...(clean(str(o.lead)) ? { lead: clean(str(o.lead)).slice(0, 200) } : {}),
        body,
        tables: (Array.isArray(o.tables) ? o.tables : []).map(takeTable)
          .filter((t): t is NarrativeTable => t !== null).slice(0, 3),
        /* 每章最多 2 张图，具体分布由 figurePlan 控制。 */
        charts: (Array.isArray(o.charts) ? o.charts : []).map(takeChart)
          .filter((c): c is NarrativeChart => c !== null).slice(0, 2),
        /* 信息图跟图表分开计数。上限从 1 放宽到 2 : 全篇只出 2 张信息图的
         * 那一轮, 卡点不在这个上限而在 figurePlan 没给它格子 —— 但上限压到 1 也确实
         * 让"这一章想用两种结构讲"变得不可能。两张封顶, 再多版面就被结构件占满。 */
        ...(() => {
          const infos = (Array.isArray(o.infographics) ? o.infographics : [])
            .map(takeInfographic)
            .filter((x): x is NarrativeInfographic => x !== null)
            .slice(0, 2);
          return infos.length > 0 ? { infographics: infos } : {};
        })(),
      };
    })
    .filter((x): x is NarrativeSection => x !== null)
    .slice(0, 8);

  const disputes = (Array.isArray(parsed.disputes) ? parsed.disputes : [])
    .map((d) => {
      const o = (d ?? {}) as Record<string, unknown>;
      const point = clean(str(o.point));
      if (!point) return null;
      return {
        point,
        sideA: clean(str(o.sideA)),
        sideB: clean(str(o.sideB)),
        judgement: clean(str(o.judgement)),
      };
    })
    .filter((x): x is ResearchNarrative['disputes'][number] => x !== null)
    .slice(0, 8);

  /* 摘要和正文都空 = 这趟白跑, 回落到算出来的那版 */
  if (summary.length === 0 && sections.length === 0) {
    return { narrative: null, droppedCitations: dropped, error: '归纳内容为空' };
  }

  /* 配图规划: 只做形状校验并原样收下 —— 它不进报告正文, 是给模型自己排图用的,
   * 以及事后复盘"它有没有按计划画"。 */
  const figurePlan = (Array.isArray(parsed.figurePlan) ? parsed.figurePlan : [])
    .map((f) => {
      const o = (f ?? {}) as Record<string, unknown>;
      const section = clean(str(o.section));
      if (!section) return null;
      /* 新形状: figures 数组 (一章可多张, 含信息图)。
       * 旧形状 {chart, shows} 仍然收 —— 续跑的账本里还躺着老数据, 认不出就整条丢了。 */
      const raw = Array.isArray(o.figures) && o.figures.length > 0
        ? o.figures
        : [{ kind: 'chart', type: str(o.chart), shows: str(o.shows) }];
      const figures = raw
        .map((f) => {
          const fo = (f ?? {}) as Record<string, unknown>;
          const type = clean(str(fo.type)).toLowerCase().slice(0, 12) || 'none';
          const kind = clean(str(fo.kind)).toLowerCase() === 'info' ? 'info' as const : 'chart' as const;
          return { kind, type, shows: clipAt(clean(str(fo.shows)), 120) };
        })
        .slice(0, 3);
      return { section: section.slice(0, 60), figures };
    })
    .filter((x): x is { section: string; figures: Array<{ kind: 'chart' | 'info'; type: string; shows: string }> } => x !== null)
    .slice(0, 10);

  return {
    narrative: {
      ...(figurePlan.length > 0 ? { figurePlan } : {}),
      ...(execSummary.length > 0 ? { execSummary } : {}),
      ...(kpis ? { kpis } : {}),
      summary,
      sections,
      disputes,
      recommendations,
      openQuestions,
      limits,
      ...(deps.model ? { model: deps.model } : {}),
      generatedAt: new Date().toISOString(),
    },
    droppedCitations: dropped,
  };
}
