
export type InsightRecord = {
  type: string;
  occurred_at: number;
  ended_at?: number | null;
  /** 发生地当天 'YYYY-MM-DD' (服务端按 tz 切好的) */
  day: string;
  tz?: string;
  value?: number | null;
  unit?: string | null;
  title?: string;
  data?: Record<string, unknown>;
};

/** day = 日子 (生日 / 节日 / 你定的每年每周的事); home = 家 (账单 / 车 / 到期); work = 工作学习; me = 我 */
export type InsightDomain = 'money' | 'body' | 'mood' | 'social' | 'habit' | 'place' | 'cross' | 'day' | 'home' | 'work' | 'me';

export type Insight = {
  /** 稳定 key: 同一类洞察每次同一个 (客户端据此去重 / 记已读) */
  id: string;
  domain: InsightDomain;
  /** good = 值得夸 / watch = 留神 / info = 知道一下 */
  tone: 'good' | 'watch' | 'info';
  /** 0~1, 越大越该先说 */
  score: number;
  /** 一眼能懂的短标题 (≤ 16 字左右) */
  title: string;
  /** 一句带数的说明 */
  detail: string;
  /** 一句能做的事 (可空) */
  suggestion?: string;
  /** 一键就办的那件事 (客户端执行): 光说「今晚早点睡」是建议, 帮你定好 11 点半的提醒才是助理 */
  action?: InsightAction;
  numbers?: Record<string, number | string>;
};

/**
 * 洞察附带的动作:
 *   remind   在 at (当地 'HH:mm', 已过就明天) 提醒 title
 *   checkin  给习惯 habit 打今天的卡
 *   ask      把 prompt 交给 Pilot 去办 (它有工具: 打开 App / 打电话 / 查资料 / 排计划)
 */
export type InsightAction =
  | { kind: 'remind'; label: string; at: string; title: string }
  | { kind: 'checkin'; label: string; habit: string }
  | { kind: 'ask'; label: string; prompt: string };

export type AnalyzeOptions = {
  /** 用户当地的今天 'YYYY-MM-DD' */
  today: string;
  /** 档案事实: budget.monthly (元), goal.weight (kg) 等 */
  facts?: Record<string, unknown>;
};

// ───────── 小工具 ─────────

const DAY = 86_400_000;
const dayNo = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / DAY);
const noDay = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);
const ym = (d: string) => d.slice(0, 7);
const daysInMonth = (d: string) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)).getUTCDate();
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : NaN);
const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const yuan = (v: number): string => {
  if (v < 0) return `-${yuan(-v)}`;
  return `¥${v >= 100 ? Math.round(v).toLocaleString('en-US') : (Math.round(v * 10) / 10).toString()}`;
};
const pct = (r: number) => `${Math.round(Math.abs(r) * 100)}%`;
const hours = (min: number) => `${Math.round((min / 60) * 10) / 10} 小时`;
const name = (t: string) => t.split('@')[0];
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** 当地时刻的「几点几分」(分钟数); 没有 tz 按 UTC */
function localMinutes(ms: number, tz?: string): number {
  try {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
    return Number(p.find(x => x.type === 'hour')!.value) * 60 + Number(p.find(x => x.type === 'minute')!.value);
  } catch {
    const d = new Date(ms);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
}

/** 入睡时刻排成「晚上 18 点起算」的分钟, 这样 23:30 和 01:00 能比大小 */
const bedtimeKey = (m: number) => (m < 18 * 60 ? m + 24 * 60 : m);
/** 建议几点睡: 取整到半点, 说人话 (「12 点」「11 点半」「1 点」) */
const bedtimeTalk = (k: number) => {
  const m = (Math.round(k / 30) * 30) % (24 * 60);
  const h = Math.floor(m / 60) % 12 || 12;
  return `${h} 点${m % 60 ? '半' : ''}`;
};

// ───────── 花销分类: 跟手机上的衣食住行同一套 ─────────

const CAT_WORDS: Array<[string, string[]]> = [
  ['吃饭', ['吃饭', '餐', '饭', '面', '食', '美团', '饿了么', '肯德基', '麦当劳', '星巴克', '瑞幸', '奶茶', '咖啡', '外卖', '超市', '便利', '盒马', '水果', '喜茶', '零食', '饮料', 'coffee', 'lunch', 'dinner', 'food']],
  ['交通', ['交通', '滴滴', '地铁', '公交', '出行', '加油', '打车', '出租', '铁路', '高铁', '火车', '航空', '机票', '停车', '高速', '单车', 'taxi', 'metro', 'bus']],
  ['居家', ['居家', '房租', '物业', '水费', '电费', '燃气', '宽带', '酒店', '住宿', '家居', '话费', 'rent']],
  ['衣着', ['衣着', '服饰', '服装', '衣服', '优衣库', '鞋', '理发', '美发', 'clothes']],
  ['购物', ['购物', '淘宝', '天猫', '京东', '拼多多', '商城', '旗舰店']],
];

export function expenseCategory(r: InsightRecord): string {
  const c = r.data?.category;
  if (typeof c === 'string' && ['吃饭', '交通', '居家', '衣着', '购物'].includes(c)) return c;
  const text = `${typeof c === 'string' ? c : ''} ${r.data?.merchant ?? ''} ${r.title ?? ''}`.toLowerCase();
  for (const [cat, words] of CAT_WORDS) if (words.some(w => text.includes(w.toLowerCase()))) return cat;
  return '其它';
}

/** 同一个商户 / 用途的归一 key: 优先商户, 其次分类+标题 */
function payee(r: InsightRecord): string {
  const m = r.data?.merchant;
  if (typeof m === 'string' && m.trim()) return m.trim();
  return (r.title || String(r.data?.category ?? '')).replace(/^(支出|收入)\s*/, '').trim() || '未知';
}

// ───────── 主入口 ─────────

export function analyze(records: InsightRecord[], opts: AnalyzeOptions): Insight[] {
  const T = dayNo(opts.today);
  const by = (t: string) => records.filter(r => name(r.type) === t && dayNo(r.day) <= T);
  const out: Insight[] = [];
  const push = (i: Insight | null | undefined) => { if (i) out.push(i); };

  const expenses = by('finance.expense').filter(r => (r.value ?? 0) > 0 && (!r.unit || r.unit === 'CNY'));
  const incomes = by('finance.income').filter(r => (r.value ?? 0) > 0 && (!r.unit || r.unit === 'CNY'));
  const moods = by('mood');
  const sleeps = by('health.sleep').filter(r => (r.value ?? 0) > 60);

  /* 日常开销: 去掉单笔大额 (≥ 500 且 ≥ 平时一笔 6 倍; 房租这类居家固定支出照算) —— 一台手机不该让「这个月花得快」翻三倍。
   * 大额另有一条 money.big */
  const cap = Math.max(500, median(expenses.filter(r => T - dayNo(r.day) < 120).map(r => r.value!)) * 6);
  const daily = expenses.filter(r => r.value! < cap || expenseCategory(r) === '居家');

  push(monthPace(expenses, daily, opts));
  push(categoryShift(daily, T));
  for (const i of recurring(expenses, T)) push(i);
  push(bigSpend(expenses, T));
  push(moodSpending(daily, moods));
  push(savings(expenses, incomes, opts.today));
  push(yearOverYear(daily, opts.today));
  push(weightTrend(by('health.weight'), T, opts.facts));
  push(sleepWeek(sleeps, T));
  push(sleepMood(sleeps, moods));
  push(moodTrend(moods, T));
  for (const i of socialDrift(by('social.interaction'), T)) push(i);
  for (const i of habits(by('habit.check'), T)) push(i);
  push(newPlaces(by('place.visit'), T));
  const people = knownPeople(opts.facts ?? {}, by('social.interaction'));
  for (const i of birthdays(opts.facts ?? {}, T)) push(i);
  for (const i of holidays(people, T)) push(i);
  for (const i of timeTriggers(records.filter(r => name(r.type) === 'trigger'), T)) push(i);
  push(netWorth(by('asset.snapshot'), T));
  for (const i of bills(by('bill'), T)) push(i);
  for (const i of expiries(opts.facts ?? {}, T)) push(i);
  push(workouts(by('fitness.workout'), T));
  push(healthReport(by('health.report'), T));

  /* 他说过最关心的 (档案 pilot.focus = ['money','body',...], 手机首次进来时选的): 同样要紧时先说这些 */
  const focus = new Set(Array.isArray(opts.facts?.['pilot.focus']) ? (opts.facts!['pilot.focus'] as unknown[]).map(String) : []);
  for (const i of out) {
    const d = i.domain === 'cross' ? (i.id.includes('spend') ? 'money' : 'body') : i.domain;
    if (focus.has(d)) i.score = clamp01(i.score + 0.2);
  }
  return out.sort((a, b) => b.score - a.score);
}

// ───────── 钱 ─────────

/** 本月到今天花了多少, 照这速度月底多少, 跟前 3 个月比; 有预算就算每天还能花多少 */
function monthPace(all: InsightRecord[], ex: InsightRecord[], o: AnalyzeOptions): Insight | null {
  const today = o.today;
  const d = +today.slice(8, 10);
  const dim = daysInMonth(today);
  const thisMonth = ex.filter(r => ym(r.day) === ym(today));
  /* 跟平时比只比日常开销 (大额另说); 预算算的是真金白银, 全算 */
  const spentAll = sum(all.filter(r => ym(r.day) === ym(today)).map(r => r.value!));
  const spent = sum(thisMonth.map(r => r.value!));
  const bigOnes = spentAll - spent;
  /* 前 3 个整月 (有数据的才算) */
  const months: number[] = [];
  const sameDay: number[] = [];
  for (let k = 1; k <= 3; k++) {
    const dt = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1 - k, 1));
    const key = dt.toISOString().slice(0, 7);
    const rows = ex.filter(r => ym(r.day) === key);
    if (rows.length < 5) continue;
    months.push(sum(rows.map(r => r.value!)));
    sameDay.push(sum(rows.filter(r => +r.day.slice(8, 10) <= d).map(r => r.value!)));
  }
  const budget = Number(o.facts?.['budget.monthly']);
  if (Number.isFinite(budget) && budget > 0 && d >= 3) {
    const left = budget - spentAll;
    const remain = dim - d + 1;
    /* 大额不会每天来, 照速度推算只推日常那部分 */
    const projected = (spent / d) * dim + bigOnes;
    if (projected > budget * 1.03) {
      return {
        id: 'money.budget', domain: 'money', tone: 'watch', score: 0.95,
        title: left > 0 ? '照这速度会超预算' : '本月预算已用完',
        detail: `预算 ${yuan(budget)}，到今天花了 ${yuan(spentAll)}，照这个速度月底约 ${yuan(projected)}。`,
        suggestion: left > 0 ? `剩下 ${remain} 天每天控制在 ${yuan(left / remain)} 以内就守得住。` : `已经超了 ${yuan(-left)}，这个月剩下的大额能缓就缓。`,
        action: SAVE_ASK,
        numbers: { budget, spent: Math.round(spentAll), projected: Math.round(projected), perDay: Math.round(Math.max(0, left) / remain) },
      };
    }
    return {
      id: 'money.budget', domain: 'money', tone: 'good', score: 0.45,
      title: '预算守得住',
      detail: `预算 ${yuan(budget)}，到今天花了 ${yuan(spentAll)}，照这个速度月底约 ${yuan(projected)}。`,
      numbers: { budget, spent: Math.round(spentAll), projected: Math.round(projected) },
    };
  }
  if (!months.length || d < 5) return null;
  const base = avg(sameDay);
  const fullAvg = avg(months);
  if (!(base > 0)) return null;
  const r = spent / base - 1;
  const projected = fullAvg * (1 + r);
  if (Math.abs(r) < 0.15 || Math.abs(spent - base) < 150) return null;
  return {
    id: 'money.pace', domain: 'money', tone: r > 0 ? 'watch' : 'good', score: r > 0 ? clamp01(0.55 + r / 2) : 0.4,
    title: r > 0 ? `这个月花得快了 ${pct(r)}` : `这个月比平时省了 ${pct(r)}`,
    detail: `日常开销到今天 ${yuan(spent)}，前 ${months.length} 个月同期平均 ${yuan(base)}；照这速度月底约 ${yuan(projected)}（平时一个月 ${yuan(fullAvg)}）${bigOnes > 0 ? `。另有大额 ${yuan(bigOnes)} 没算在里面` : ''}。`,
    suggestion: r > 0 ? '看看是哪一类多了。' : undefined,
    action: r > 0 ? SAVE_ASK : undefined,
    numbers: { spent: Math.round(spent), baseline: Math.round(base), projected: Math.round(projected), monthlyAvg: Math.round(fullAvg), bigOnes: Math.round(bigOnes) },
  };
}

const SAVE_ASK: InsightAction = { kind: 'ask', label: '帮我找能省的', prompt: '看看我这个月哪些开销能省，按能省多少排，给我三条具体能做的，说短一点。' };

/** 'HH:mm' (分钟数可以超过 24 点, 取模) */
const hhmm = (min: number) => {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** 近 30 天哪一类比之前 90 天的月均多了一大截 */
function categoryShift(ex: InsightRecord[], T: number): Insight | null {
  const recent = ex.filter(r => T - dayNo(r.day) < 30);
  const before = ex.filter(r => { const a = T - dayNo(r.day); return a >= 30 && a < 120; });
  const spanDays = before.length ? T - 30 - Math.min(...before.map(r => dayNo(r.day))) + 1 : 0;
  if (recent.length < 8 || spanDays < 45) return null;
  const by = (rows: InsightRecord[]) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(expenseCategory(r), (m.get(expenseCategory(r)) ?? 0) + r.value!);
    return m;
  };
  const now = by(recent);
  const old = by(before);
  let best: { cat: string; now: number; base: number } | null = null;
  for (const [cat, v] of now) {
    const base = ((old.get(cat) ?? 0) / spanDays) * 30;
    const delta = v - base;
    if (base > 0 && delta >= 200 && v / base >= 1.4 && (!best || delta > best.now - best.base)) best = { cat, now: v, base };
  }
  if (!best) return null;
  const top = recent.filter(r => expenseCategory(r) === best!.cat);
  const counts = new Map<string, number>();
  for (const r of top) counts.set(payee(r), (counts.get(payee(r)) ?? 0) + r.value!);
  const lead = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    id: 'money.category', domain: 'money', tone: 'watch', score: clamp01(0.5 + (best.now - best.base) / 3000),
    title: `${best.cat}多花了 ${yuan(best.now - best.base)}`,
    detail: `近 30 天${best.cat} ${yuan(best.now)}，之前平均每 30 天 ${yuan(best.base)}${lead ? `；花得最多的是「${lead[0]}」${yuan(lead[1])}` : ''}。`,
    action: { kind: 'ask', label: `${best.cat}怎么省`, prompt: `我近 30 天${best.cat}花了 ${Math.round(best.now)}，比平时多 ${Math.round(best.now - best.base)}。按我的记录看是哪几笔多了，给我一个这周就能照做的省法，说短一点。` },
    numbers: { category: best.cat, recent: Math.round(best.now), baseline: Math.round(best.base) },
  };
}

/** 每月固定扣的钱: 同一收款方、金额差不多、隔 25~35 天来一次, 至少 3 次 */
function recurring(ex: InsightRecord[], T: number): Insight[] {
  const subs = detectSubscriptions(ex, T);
  if (!subs.length) return [];
  return subscriptionInsights(subs, T);
}

/** 每月固定扣款: 同一收款方、金额差不多、隔 25~35 天来一次、至少 3 次、还没停 (房间摘要也用) */
export function detectSubscriptions(ex: InsightRecord[], T: number): Array<{ who: string; amount: number; next: number }> {
  const groups = new Map<string, InsightRecord[]>();
  for (const r of ex.filter(r => T - dayNo(r.day) < 200)) {
    const k = payee(r);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const subs: Array<{ who: string; amount: number; next: number }> = [];
  for (const [who, rows] of groups) {
    if (rows.length < 3) continue;
    rows.sort((a, b) => dayNo(a.day) - dayNo(b.day));
    const amount = median(rows.map(r => r.value!));
    const steady = rows.filter(r => Math.abs(r.value! - amount) <= amount * 0.06);
    /* 常去的店 (便利蜂一个月去十几次) 碰巧有几笔金额差不多不算订阅: 金额稳定的要占这家的大多数 */
    if (steady.length < 3 || steady.length < rows.length * 0.7) continue;
    const gaps = steady.slice(1).map((r, i) => dayNo(r.day) - dayNo(steady[i].day));
    const g = median(gaps);
    if (!(g >= 25 && g <= 35) || gaps.filter(x => x >= 20 && x <= 40).length < gaps.length * 0.7) continue;
    const last = dayNo(steady[steady.length - 1].day);
    if (T - last > 45) continue; // 已经停了
    /* 按月扣的下次是下个月同一天 (月底按当月最后一天), 不是 +30 天 */
    const lastDay = noDay(last);
    const nm = new Date(Date.UTC(+lastDay.slice(0, 4), +lastDay.slice(5, 7), 1)).toISOString().slice(0, 10);
    const next = dayNo(`${nm.slice(0, 8)}${String(Math.min(+lastDay.slice(8, 10), daysInMonth(nm))).padStart(2, '0')}`);
    subs.push({ who, amount, next });
  }
  return subs.sort((a, b) => b.amount - a.amount);
}

function subscriptionInsights(subs: Array<{ who: string; amount: number; next: number }>, T: number): Insight[] {
  const total = sum(subs.map(s => s.amount));
  const out: Insight[] = [{
    id: 'money.recurring', domain: 'money', tone: 'info', score: 0.5,
    title: `每月固定扣 ${yuan(total)}`,
    detail: `${subs.slice(0, 5).map(s => `${s.who} ${yuan(s.amount)}`).join('、')}${subs.length > 5 ? ` 等 ${subs.length} 项` : ''}。`,
    suggestion: subs.length >= 3 ? '有不用的会员可以停掉，一年能省下不少。' : undefined,
    action: { kind: 'ask', label: '哪些能停', prompt: '把我每月固定扣款列一下，哪些看着可以停，每个怎么取消（在哪个 App 的哪一页），说短一点。' },
    numbers: { total: Math.round(total), count: subs.length },
  }];
  const soon = subs.filter(s => s.next - T >= 0 && s.next - T <= 3).sort((a, b) => a.next - b.next)[0];
  if (soon) {
    const when = soon.next - T === 0 ? '今天' : soon.next - T === 1 ? '明天' : `${soon.next - T} 天后`;
    out.push({
      id: 'money.recurring.soon', domain: 'money', tone: 'info', score: 0.7,
      title: `${soon.who} ${when}扣 ${yuan(soon.amount)}`,
      detail: `按每月的节奏，${noDay(soon.next).slice(5)} 前后会扣 ${yuan(soon.amount)}。`,
      suggestion: '不想续就趁现在取消。',
      action: { kind: 'ask', label: '帮我取消', prompt: `帮我取消「${soon.who}」的自动续费：能在手机上打开对应 App 就直接打开到那一页，打不开就告诉我入口在哪。` },
      numbers: { amount: soon.amount, day: noDay(soon.next) },
    });
  }
  return out;
}

/** 最近 7 天的大额 (≥ 500 且 ≥ 平时一笔的 6 倍) */
function bigSpend(ex: InsightRecord[], T: number): Insight | null {
  const hist = ex.filter(r => { const a = T - dayNo(r.day); return a >= 7 && a < 120; }).map(r => r.value!);
  if (hist.length < 15) return null;
  const typical = median(hist);
  const big = ex.filter(r => T - dayNo(r.day) < 7 && r.value! >= Math.max(500, typical * 6)).sort((a, b) => b.value! - a.value!)[0];
  if (!big) return null;
  return {
    id: 'money.big', domain: 'money', tone: 'info', score: 0.55,
    title: `一笔大额 ${yuan(big.value!)}`,
    detail: `${big.day.slice(5)} 在「${payee(big)}」花了 ${yuan(big.value!)}，平时一笔大概 ${yuan(typical)}。`,
    numbers: { amount: big.value!, typical: Math.round(typical) },
  };
}

/** 心情差的日子是不是多花钱 (各至少 5 天才说) */
function moodSpending(ex: InsightRecord[], moods: InsightRecord[]): Insight | null {
  const moodByDay = dayAvg(moods, r => Number(r.data?.score ?? r.value));
  const spendByDay = new Map<string, number>();
  for (const r of ex) {
    const c = expenseCategory(r);
    if (c === '居家' || c === '交通') continue; // 房租和通勤跟心情无关
    spendByDay.set(r.day, (spendByDay.get(r.day) ?? 0) + r.value!);
  }
  const low: number[] = [];
  const high: number[] = [];
  for (const [day, m] of moodByDay) {
    const s = spendByDay.get(day) ?? 0;
    if (m <= 2.5) low.push(s);
    else if (m >= 3.5) high.push(s);
  }
  if (low.length < 5 || high.length < 5) return null;
  const a = avg(low), b = avg(high);
  if (!(b > 0) || a / b < 1.4 || a - b < 50) return null;
  return {
    id: 'cross.mood_spend', domain: 'cross', tone: 'watch', score: 0.6,
    title: `心情差的日子多花 ${pct(a / b - 1)}`,
    detail: `心情不好的 ${low.length} 天平均花 ${yuan(a)}，心情好的 ${high.length} 天平均 ${yuan(b)}（不算房租交通）。`,
    suggestion: '下次心情差想买东西，先放购物车隔一晚再说。',
    numbers: { low: Math.round(a), high: Math.round(b), nLow: low.length, nHigh: high.length },
  };
}

/** 上个整月存下了多少 (有收入记录才说) */
function savings(ex: InsightRecord[], inc: InsightRecord[], today: string): Insight | null {
  const dt = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 2, 1));
  const key = dt.toISOString().slice(0, 7);
  const i = sum(inc.filter(r => ym(r.day) === key).map(r => r.value!));
  const e = sum(ex.filter(r => ym(r.day) === key).map(r => r.value!));
  if (i <= 0 || e <= 0) return null;
  const rate = (i - e) / i;
  return {
    id: 'money.savings', domain: 'money', tone: rate >= 0.2 ? 'good' : rate < 0 ? 'watch' : 'info', score: rate < 0 ? 0.65 : 0.35,
    title: rate >= 0 ? `${+key.slice(5)}月存下 ${pct(rate)}` : `${+key.slice(5)}月入不敷出`,
    detail: `${+key.slice(5)}月收入 ${yuan(i)}，花了 ${yuan(e)}，${rate >= 0 ? `存下 ${yuan(i - e)}` : `超出 ${yuan(e - i)}`}。`,
    numbers: { income: Math.round(i), expense: Math.round(e), rate: Math.round(rate * 100) },
  };
}

/** 去年同一个月 (有一年以上数据才说) */
function yearOverYear(ex: InsightRecord[], today: string): Insight | null {
  const lastYear = `${+today.slice(0, 4) - 1}${today.slice(4, 7)}`;
  const prevRows = ex.filter(r => ym(r.day) === lastYear);
  if (prevRows.length < 10) return null;
  const d = +today.slice(8, 10);
  const prev = sum(prevRows.filter(r => +r.day.slice(8, 10) <= d).map(r => r.value!));
  const now = sum(ex.filter(r => ym(r.day) === ym(today)).map(r => r.value!));
  if (prev <= 0 || d < 5) return null;
  const r = now / prev - 1;
  if (Math.abs(r) < 0.1) return null;
  return {
    id: 'money.yoy', domain: 'money', tone: 'info', score: 0.3,
    title: `比去年同期${r > 0 ? '多' : '少'}花 ${pct(r)}`,
    detail: `去年这个月到 ${d} 号花了 ${yuan(prev)}，今年 ${yuan(now)}。`,
    numbers: { lastYear: Math.round(prev), thisYear: Math.round(now) },
  };
}

// ───────── 身体 ─────────

function weightTrend(ws: InsightRecord[], T: number, facts?: Record<string, unknown>): Insight | null {
  const pts = [...dayAvg(ws, r => Number(r.value))].map(([d, v]) => ({ x: dayNo(d), y: v })).filter(p => T - p.x < 90).sort((a, b) => a.x - b.x);
  if (!pts.length) return null;
  const lastAt = pts[pts.length - 1].x;
  if (T - lastAt >= 14) {
    return {
      id: 'body.weight.stale', domain: 'body', tone: 'info', score: 0.3,
      title: `${T - lastAt} 天没称体重了`,
      detail: `上次是 ${noDay(lastAt).slice(5)}，${pts[pts.length - 1].y.toFixed(1)} kg。`,
      suggestion: '明早起床称一下，走势才连得上。',
      action: { kind: 'remind', label: '明早 7:30 提醒我称', at: '07:30', title: '起床称一下体重' },
    };
  }
  if (pts.length < 6 || lastAt - pts[0].x < 21) return null;
  const slope = linSlope(pts) * 7; // kg/周
  const now = pts[pts.length - 1].y;
  const goal = Number(facts?.['goal.weight']);
  const hasGoal = Number.isFinite(goal) && goal > 30;
  if (Math.abs(slope) < 0.15 && !hasGoal) return null;
  const towardGoal = hasGoal && Math.sign(goal - now) === Math.sign(slope) && Math.abs(slope) >= 0.05;
  const weeks = towardGoal ? Math.abs(goal - now) / Math.abs(slope) : NaN;
  return {
    id: 'body.weight', domain: 'body', tone: hasGoal ? (towardGoal ? 'good' : 'watch') : 'info', score: hasGoal ? 0.6 : 0.4,
    title: Math.abs(slope) < 0.05 ? '体重稳住了' : `每周${slope < 0 ? '轻' : '重'} ${Math.abs(slope).toFixed(1)} kg`,
    detail: `${Math.round((lastAt - pts[0].x) / 7)} 周里从 ${pts[0].y.toFixed(1)} 到 ${now.toFixed(1)} kg${hasGoal ? `，目标 ${goal} kg` : ''}。`,
    suggestion: towardGoal ? `照这个速度大约 ${Math.ceil(weeks)} 周到目标。` : hasGoal ? '最近在往反方向走，回头看看吃和睡。' : undefined,
    numbers: { now: Math.round(now * 10) / 10, perWeek: Math.round(slope * 100) / 100, ...(towardGoal ? { weeksToGoal: Math.ceil(weeks) } : {}) },
  };
}

function sleepWeek(sl: InsightRecord[], T: number): Insight | null {
  const nights = sl.map(r => ({ d: dayNo(r.day), min: r.value!, bed: bedtimeKey(localMinutes(r.occurred_at, r.tz)) }));
  const week = nights.filter(n => T - n.d < 7);
  const before = nights.filter(n => T - n.d >= 7 && T - n.d < 35);
  if (week.length < 4) return null;
  const a = avg(week.map(n => n.min));
  const short = week.filter(n => n.min < 360).length;
  const bedNow = median(week.map(n => n.bed));
  const bedBefore = before.length >= 7 ? median(before.map(n => n.bed)) : NaN;
  const later = bedNow - bedBefore;
  if (a >= 7 * 60 && short === 0) {
    return { id: 'body.sleep', domain: 'body', tone: 'good', score: 0.3, title: '这周睡得够', detail: `这 ${week.length} 晚平均 ${hours(a)}。`, numbers: { avgMin: Math.round(a) } };
  }
  if (a >= 6.5 * 60 && short < 2) return null;
  return {
    id: 'body.sleep', domain: 'body', tone: 'watch', score: clamp01(0.55 + (420 - a) / 300),
    title: `这周平均只睡 ${hours(a)}`,
    detail: `${week.length} 晚里有 ${short} 晚不到 6 小时${Number.isFinite(later) && later >= 30 ? `，入睡比之前晚了 ${Math.round(later)} 分钟（现在一般 ${bedtimeTalk(bedNow)}才睡）` : ''}。`,
    suggestion: Number.isFinite(later) && later >= 30 ? `今晚试试 ${bedtimeTalk(bedBefore)}前躺下，跟你之前一样。` : '今晚早点躺下，手机放远一点。',
    /* 睡前半小时提醒 (按他以前的入睡时间, 没有就 23:00) */
    action: (() => {
      const at = Number.isFinite(bedBefore) ? Math.round((bedBefore - 30) / 30) * 30 : 23 * 60;
      return { kind: 'remind' as const, label: `${hhmm(at)} 提醒我准备睡`, at: hhmm(at), title: '该准备睡了，放下手机' };
    })(),
    numbers: { avgMin: Math.round(a), shortNights: short, ...(Number.isFinite(later) ? { laterMin: Math.round(later) } : {}) },
  };
}

/** 睡够的日子心情是不是更好: 醒来那天的心情 vs 那晚睡了多久 */
function sleepMood(sl: InsightRecord[], moods: InsightRecord[]): Insight | null {
  const mood = dayAvg(moods, r => Number(r.data?.score ?? r.value));
  const good: number[] = [];
  const bad: number[] = [];
  for (const s of sl) {
    const m = mood.get(s.day);
    if (m == null) continue;
    if (s.value! >= 420) good.push(m);
    else if (s.value! < 390) bad.push(m);
  }
  if (good.length < 6 || bad.length < 6) return null;
  const a = avg(good), b = avg(bad);
  if (a - b < 0.5) return null;
  return {
    id: 'cross.sleep_mood', domain: 'cross', tone: 'info', score: 0.65,
    title: '睡够 7 小时，心情明显更好',
    detail: `睡够的 ${good.length} 天心情平均 ${a.toFixed(1)}，没睡够的 ${bad.length} 天 ${b.toFixed(1)}（满分 5）。`,
    suggestion: '对你来说，早睡比什么都管用。',
    numbers: { enough: Math.round(a * 10) / 10, short: Math.round(b * 10) / 10, nEnough: good.length, nShort: bad.length },
  };
}

// ───────── 心情 ─────────

function moodTrend(moods: InsightRecord[], T: number): Insight | null {
  const m = [...dayAvg(moods, r => Number(r.data?.score ?? r.value))].map(([d, v]) => ({ d: dayNo(d), v }));
  const recent = m.filter(x => T - x.d < 14);
  const before = m.filter(x => T - x.d >= 14 && T - x.d < 90);
  if (recent.length >= 5 && before.length >= 10) {
    const a = avg(recent.map(x => x.v)), b = avg(before.map(x => x.v));
    if (b - a >= 0.6) {
      return {
        id: 'mood.low', domain: 'mood', tone: 'watch', score: 0.75,
        title: '最近两周心情偏低',
        detail: `这两周平均 ${a.toFixed(1)}，之前一直是 ${b.toFixed(1)} 左右。`,
        suggestion: '想聊聊就跟我说；也可以约个朋友出去走走。',
        action: { kind: 'ask', label: '陪我聊聊', prompt: '我最近两周心情不太好，陪我聊聊。先别讲大道理，问我一两个问题。' },
        numbers: { recent: Math.round(a * 10) / 10, before: Math.round(b * 10) / 10 },
      };
    }
    if (a - b >= 0.5) {
      return { id: 'mood.up', domain: 'mood', tone: 'good', score: 0.4, title: '最近心情不错', detail: `这两周平均 ${a.toFixed(1)}，比之前的 ${b.toFixed(1)} 高。`, numbers: { recent: Math.round(a * 10) / 10 } };
    }
  }
  /* 一周里哪天最难熬 */
  const wk = new Map<number, number[]>();
  for (const x of m.filter(x => T - x.d < 120)) {
    const w = new Date(x.d * DAY).getUTCDay();
    wk.set(w, [...(wk.get(w) ?? []), x.v]);
  }
  const rows = [...wk.entries()].filter(([, v]) => v.length >= 3).map(([w, v]) => ({ w, a: avg(v) }));
  if (rows.length < 5) return null;
  const worst = rows.reduce((p, c) => (c.a < p.a ? c : p));
  const rest = avg(rows.filter(r => r.w !== worst.w).map(r => r.a));
  if (rest - worst.a < 0.7) return null;
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return {
    id: 'mood.weekday', domain: 'mood', tone: 'info', score: 0.35,
    title: `${names[worst.w]}最难熬`,
    detail: `${names[worst.w]}心情平均 ${worst.a.toFixed(1)}，其他日子 ${rest.toFixed(1)}。`,
    suggestion: `给${names[worst.w]}晚上留点自己喜欢的事。`,
    numbers: { weekday: names[worst.w], avg: Math.round(worst.a * 10) / 10 },
  };
}

// ───────── 人 / 习惯 / 地方 ─────────

/** 跟谁好久没联系: 按这个人平时的间隔算 (至少来往过 4 次) */
function socialDrift(xs: InsightRecord[], T: number): Insight[] {
  const per = new Map<string, number[]>();
  for (const r of xs) {
    const w = r.data?.with;
    for (const p of Array.isArray(w) ? w : typeof w === 'string' ? [w] : []) {
      if (typeof p !== 'string' || !p.trim()) continue;
      per.set(p.trim(), [...(per.get(p.trim()) ?? []), dayNo(r.day)]);
    }
  }
  const out: Insight[] = [];
  for (const [who, days] of per) {
    const ds = [...new Set(days)].sort((a, b) => a - b);
    if (ds.length < 4) continue;
    const gap = median(ds.slice(1).map((d, i) => d - ds[i]));
    const since = T - ds[ds.length - 1];
    if (since < Math.max(gap * 2.5, 14) || since > 365) continue;
    out.push({
      id: `social.drift:${who}`, domain: 'social', tone: 'watch', score: clamp01(0.55 + since / gap / 20),
      title: `${since} 天没和${who}联系了`,
      detail: `你们平时大概 ${Math.round(gap)} 天联系一次。`,
      suggestion: `今天给${who}打个电话或发句话？`,
      action: { kind: 'remind', label: `今晚 8 点提醒我打给${who}`, at: '20:00', title: `给${who}打个电话` },
      numbers: { who, since, usualGap: Math.round(gap) },
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}

function habits(xs: InsightRecord[], T: number): Insight[] {
  const per = new Map<string, Set<number>>();
  for (const r of xs) {
    if (r.data?.done === false) continue;
    const h = String(r.data?.habit ?? '').trim();
    if (!h) continue;
    per.set(h, (per.get(h) ?? new Set()).add(dayNo(r.day)));
  }
  const out: Insight[] = [];
  for (const [h, days] of per) {
    /* 今天还没打不算断: 从今天或昨天往回数 */
    const start = days.has(T) ? T : T - 1;
    let streak = 0;
    while (days.has(start - streak)) streak++;
    if (streak >= 3) {
      out.push({
        id: `habit.streak:${h}`, domain: 'habit', tone: 'good', score: clamp01(0.35 + streak / 60),
        title: `${h}连续 ${streak} 天`, detail: `从 ${noDay(start - streak + 1).slice(5)} 起没断过。`,
        /* 今天还没打: 给个一键打卡, 第 streak+1 天 */
        action: days.has(T) ? undefined : { kind: 'checkin', label: `打卡，第 ${streak + 1} 天`, habit: h },
        numbers: { habit: h, streak },
      });
      continue;
    }
    /* 刚断: 最后一次打卡之前连了至少 5 天, 之后漏了 1~3 天 (今天还没到头, 不算漏) */
    const last = Math.max(...[...days].filter(d => d <= T));
    const missed = T - 1 - last;
    if (missed >= 1 && missed <= 3) {
      let prev = 0;
      while (days.has(last - prev)) prev++;
      if (prev >= 5) {
        out.push({
          id: `habit.broken:${h}`, domain: 'habit', tone: 'watch', score: 0.6,
          title: `${h}断了 ${missed} 天`, detail: `之前连续 ${prev} 天。`, suggestion: '今天补上，别让它断成习惯。',
          action: { kind: 'checkin', label: `今天${h}打卡`, habit: h },
          numbers: { habit: h, before: prev, missed },
        });
      }
    }
  }
  return out;
}

function newPlaces(xs: InsightRecord[], T: number): Insight | null {
  const nameOf = (r: InsightRecord) => String(r.data?.name ?? '').trim();
  const recent = new Set(xs.filter(r => T - dayNo(r.day) < 30).map(nameOf).filter(Boolean));
  const old = new Set(xs.filter(r => T - dayNo(r.day) >= 30).map(nameOf).filter(Boolean));
  const fresh = [...recent].filter(n => !old.has(n));
  if (fresh.length < 2) return null;
  return {
    id: 'place.new', domain: 'place', tone: 'good', score: 0.3,
    title: `这个月去了 ${fresh.length} 个新地方`,
    detail: `${fresh.slice(0, 4).join('、')}${fresh.length > 4 ? ' 等' : ''}。`,
    numbers: { count: fresh.length },
  };
}

// ───────── 日子: 生日 / 节日 / 你定的事 ─────────
//
// 人记在档案里, key 统一: person.<名字>.<relation|birthday|likes|dislikes|habit|note>, 自己是 me.<...>。
// 节日不对每个人都说: 母亲节只对记过妈妈的人提, 七夕只对有对象的人提 —— 一个不相干的节日提醒就是噪音。

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const whenText = (n: number) => (n === 0 ? '今天' : n === 1 ? '明天' : n === 2 ? '后天' : `${n} 天后`);

/** 'MM-DD' / 'YYYY-MM-DD' / '3月8日' / '3-8' → [月, 日] */
function monthDay(v: unknown): [number, number] | null {
  const s = String(v ?? '').trim();
  const m = /(?:\d{4}[-/年])?(\d{1,2})[-/月](\d{1,2})日?/.exec(s);
  if (!m) return null;
  const mo = +m[1], d = +m[2];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? [mo, d] : null;
}

/** 某个「每年 M 月 D 日」下一次落在哪天 (今天算) */
function nextYearly(T: number, mo: number, d: number): number {
  const y = +noDay(T).slice(0, 4);
  for (const yy of [y, y + 1]) {
    const n = dayNo(`${yy}-${String(mo).padStart(2, '0')}-${String(Math.min(d, daysInMonth(`${yy}-${String(mo).padStart(2, '0')}-01`))).padStart(2, '0')}`);
    if (n >= T) return n;
  }
  return T + 400;
}

type Person = { name: string; relation: string };

/** 他身边的人: 档案里 person.<名字>.* 的, 加上来往记录里出现过的 */
function knownPeople(facts: Record<string, unknown>, social: InsightRecord[]): Person[] {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(facts)) {
    const m = /^person\.([^.]+)\.(\w+)$/.exec(k);
    if (!m) continue;
    if (!map.has(m[1])) map.set(m[1], '');
    if (m[2] === 'relation') map.set(m[1], String(v));
  }
  for (const r of social) {
    const w = r.data?.with;
    for (const p of Array.isArray(w) ? w : []) if (typeof p === 'string' && p.trim() && !map.has(p.trim())) map.set(p.trim(), '');
  }
  return [...map].map(([name, relation]) => ({ name, relation }));
}

function birthdays(facts: Record<string, unknown>, T: number): Insight[] {
  const out: Insight[] = [];
  for (const [k, v] of Object.entries(facts)) {
    const m = /^(?:person\.([^.]+)|me)\.birthday$/.exec(k);
    const md = m && monthDay(v);
    if (!m || !md) continue;
    const who = m[1];
    const at = nextYearly(T, md[0], md[1]);
    const n = at - T;
    if (n > 7) continue;
    const likes = who ? facts[`person.${who}.likes`] : undefined;
    out.push({
      id: `day.birthday:${who ?? 'me'}`, domain: 'day', tone: 'info', score: n <= 1 ? 0.95 : 0.8,
      title: who ? `${who}生日${n === 0 ? '就是今天' : `还有 ${n} 天`}` : n === 0 ? '今天是你生日' : `${n} 天后是你生日`,
      detail: `${noDay(at).slice(5).replace('-', '月')}日，周${WEEK[new Date(at * DAY).getUTCDay()]}${likes ? `。你记过${who}喜欢${likes}` : ''}。`,
      suggestion: who ? (n >= 3 ? '礼物现在订还来得及。' : '今天把祝福和礼物安排好。') : '想怎么过，我帮你安排。',
      action: who
        ? { kind: 'ask', label: '帮我准备', prompt: `${who}${n === 0 ? '今天' : `${n} 天后`}过生日。结合你记得的${who}的喜好，给我三个礼物或安排的建议（附大概价钱和在哪买），再帮我在前一天晚上定个提醒。说短一点。` }
        : { kind: 'ask', label: '帮我安排', prompt: `我${whenText(n)}过生日，结合我的喜好给我安排一下那天，说短一点。` },
      numbers: { who: who ?? 'me', date: noDay(at), days: n },
    });
  }
  return out;
}

/* 2026~2027 的节日 (农历的已经换成公历), who = 身边有这样的人才提; lead = 提前几天开始说 */
const HOLIDAYS: Array<{ name: string; dates: Record<number, string>; lead: number; who?: RegExp; prompt: string }> = [
  { name: '元旦', dates: { 2026: '01-01', 2027: '01-01' }, lead: 3, prompt: '跨年这几天怎么安排' },
  { name: '情人节', dates: { 2026: '02-14', 2027: '02-14' }, lead: 5, who: /老婆|老公|女朋友|男朋友|对象|爱人|妻子|丈夫|女友|男友/, prompt: '情人节给{who}准备什么' },
  { name: '春节', dates: { 2026: '02-17', 2027: '02-06' }, lead: 21, prompt: '春节回家、红包、年货怎么安排' },
  { name: '妇女节', dates: { 2026: '03-08', 2027: '03-08' }, lead: 3, who: /妈|母亲|老婆|妻子|女朋友|女友/, prompt: '妇女节给{who}表示一下' },
  { name: '清明', dates: { 2026: '04-05', 2027: '04-05' }, lead: 7, prompt: '清明假期怎么安排（扫墓 / 出行）' },
  { name: '母亲节', dates: { 2026: '05-10', 2027: '05-09' }, lead: 7, who: /妈|母亲/, prompt: '母亲节给{who}准备什么' },
  { name: '端午', dates: { 2026: '06-19', 2027: '06-09' }, lead: 5, prompt: '端午假期怎么安排' },
  { name: '父亲节', dates: { 2026: '06-21', 2027: '06-20' }, lead: 7, who: /爸|父亲/, prompt: '父亲节给{who}准备什么' },
  { name: '七夕', dates: { 2026: '08-19', 2027: '08-08' }, lead: 7, who: /老婆|老公|女朋友|男朋友|对象|爱人|妻子|丈夫|女友|男友/, prompt: '七夕和{who}怎么过' },
  { name: '中秋', dates: { 2026: '09-25', 2027: '09-15' }, lead: 10, prompt: '中秋回家、月饼、给家里人的安排' },
  { name: '国庆', dates: { 2026: '10-01', 2027: '10-01' }, lead: 14, prompt: '国庆假期怎么安排' },
  { name: '重阳节', dates: { 2026: '10-18', 2027: '10-08' }, lead: 7, who: /爸|妈|父亲|母亲|爷爷|奶奶|外公|外婆|姥姥|姥爷/, prompt: '重阳节给{who}表示一下' },
  { name: '冬至', dates: { 2026: '12-22', 2027: '12-22' }, lead: 2, prompt: '冬至怎么过' },
];

function holidays(people: Person[], T: number): Insight[] {
  const y = +noDay(T).slice(0, 4);
  const out: Insight[] = [];
  for (const h of HOLIDAYS) {
    const dates = [h.dates[y], h.dates[y + 1]].filter(Boolean).map((md, i) => dayNo(`${y + i}-${md}`));
    const at = dates.find(n => n >= T);
    if (at == null || at - T > h.lead) continue;
    const who = h.who ? people.find(p => h.who!.test(p.relation) || h.who!.test(p.name)) : undefined;
    if (h.who && !who) continue; // 身边没这样的人, 不提
    const n = at - T;
    const prompt = h.prompt.replace('{who}', who?.name ?? '');
    out.push({
      id: `day.holiday:${h.name}`, domain: 'day', tone: 'info', score: who ? 0.75 : 0.45,
      title: `${h.name}${n === 0 ? '就是今天' : `还有 ${n} 天`}${who ? ` · ${who.name}` : ''}`,
      detail: `${noDay(at).slice(5).replace('-', '月')}日，周${WEEK[new Date(at * DAY).getUTCDay()]}。`,
      action: { kind: 'ask', label: '帮我安排', prompt: `${h.name}${whenText(n)}（${noDay(at).slice(5)}）。${prompt}？结合你记得的${who ? `${who.name}的喜好和` : ''}我的情况给我两三个具体的安排，需要的话帮我定提醒。说短一点。` },
      numbers: { holiday: h.name, date: noDay(at), days: n, ...(who ? { who: who.name } : {}) },
    });
  }
  return out;
}

/** 你定的时间类触发: 每年 / 某天 / 每周, 按提前天数冒出来 */
function timeTriggers(xs: InsightRecord[], T: number): Insight[] {
  const out: Insight[] = [];
  for (const r of xs) {
    const d = r.data ?? {};
    const text = String(d.text ?? r.title ?? '').trim();
    if (!text) continue;
    const lead = Math.min(60, Math.max(0, Number(d.leadDays ?? 0) || 0));
    let at: number | null = null;
    if (d.when === 'yearly') {
      const md = monthDay(d.date);
      if (md) at = nextYearly(T, md[0], md[1]);
    } else if (d.when === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(d.date))) {
      at = dayNo(String(d.date));
    } else if (d.when === 'weekly') {
      const wd = Number(d.weekday) % 7; // 7 = 周日 = 0
      at = T + ((wd - new Date(T * DAY).getUTCDay() + 7) % 7);
    }
    if (at == null || at < T || at - T > lead) continue;
    const n = at - T;
    const time = /^\d{1,2}:\d{2}$/.test(String(d.time ?? '')) ? String(d.time).padStart(5, '0') : '09:00';
    out.push({
      id: `day.trigger:${text.slice(0, 40)}`, domain: 'day', tone: 'watch', score: n === 0 ? 0.9 : 0.7,
      title: `${whenText(n)}：${text}`,
      detail: `${noDay(at).slice(5).replace('-', '月')}日，周${WEEK[new Date(at * DAY).getUTCDay()]}${d.when === 'yearly' ? '，每年这天' : d.when === 'weekly' ? '，每周这天' : ''}。`,
      action: n === 0
        ? { kind: 'remind', label: `${time} 提醒我`, at: time, title: text }
        : { kind: 'ask', label: '帮我准备', prompt: `${whenText(n)}要「${text}」，现在需要准备什么？能替我办的直接办，再在那天 ${time} 提醒我。` },
      numbers: { date: noDay(at), days: n, time },
    });
  }
  return out;
}

// ───────── 钱: 净资产 · 家: 账单 / 到期 · 身体: 运动 / 体检 ─────────

/** 每个账户最新一笔之和; 跟 30 天前比 */
export function netWorthAt(xs: InsightRecord[], day: number): { total: number; accounts: Map<string, number> } {
  const latest = new Map<string, { d: number; v: number }>();
  for (const r of xs) {
    const d = dayNo(r.day);
    if (d > day) continue;
    const acc = String(r.data?.account ?? '');
    const cur = latest.get(acc);
    if (!cur || d >= cur.d) latest.set(acc, { d, v: Number(r.value ?? 0) });
  }
  const accounts = new Map([...latest].map(([k, x]) => [k, x.v]));
  return { total: sum([...accounts.values()]), accounts };
}

function netWorth(xs: InsightRecord[], T: number): Insight | null {
  if (xs.length < 2) return null;
  const now = netWorthAt(xs, T);
  const before = netWorthAt(xs, T - 30);
  if (!before.accounts.size) return null;
  const delta = now.total - before.total;
  /* 变动最大的那个账户 */
  let mover = '', mv = 0;
  for (const [acc, v] of now.accounts) {
    const d = v - (before.accounts.get(acc) ?? 0);
    if (Math.abs(d) > Math.abs(mv)) { mover = acc; mv = d; }
  }
  if (Math.abs(delta) < 500) return null;
  return {
    id: 'money.networth', domain: 'money', tone: delta > 0 ? 'good' : 'watch', score: delta > 0 ? 0.4 : 0.6,
    title: `净资产一个月${delta > 0 ? '多了' : '少了'} ${yuan(Math.abs(delta))}`,
    detail: `现在 ${yuan(now.total)}，一个月前 ${yuan(before.total)}；变得最多的是「${mover}」${mv > 0 ? '+' : '−'}${yuan(Math.abs(mv))}。`,
    numbers: { total: Math.round(now.total), delta: Math.round(delta) },
  };
}

const BILL_LABEL: Record<string, string> = {
  electric: '电费', water: '水费', gas: '燃气费', property: '物业费', internet: '宽带', phone: '话费',
  rent: '房租', mortgage: '房贷', insurance: '保险', other: '账单',
};

/** 同类账单: 这期比前三期平均高很多; 没交的快到期了 */
function bills(xs: InsightRecord[], T: number): Insight[] {
  const out: Insight[] = [];
  const byKind = new Map<string, InsightRecord[]>();
  for (const r of xs) {
    const k = String(r.data?.kind ?? 'other');
    byKind.set(k, [...(byKind.get(k) ?? []), r]);
  }
  for (const [kind, rows] of byKind) {
    rows.sort((a, b) => dayNo(a.day) - dayNo(b.day));
    const last = rows[rows.length - 1];
    const label = BILL_LABEL[kind] ?? '账单';
    if (T - dayNo(last.day) <= 35 && rows.length >= 4) {
      const prev = rows.slice(-4, -1).map(r => Number(r.value ?? 0));
      const base = avg(prev);
      const v = Number(last.value ?? 0);
      if (base > 0 && v / base >= 1.3 && v - base >= 30) {
        out.push({
          id: `home.bill.up:${kind}`, domain: 'home', tone: 'watch', score: 0.55,
          title: `${label}比平时多 ${pct(v / base - 1)}`,
          detail: `${String(last.data?.period ?? last.day.slice(0, 7))} ${yuan(v)}，前三期平均 ${yuan(base)}。`,
          action: { kind: 'ask', label: '帮我看看为啥', prompt: `我这期${label} ${Math.round(v)}，比前三期平均 ${Math.round(base)} 高了不少。按季节、家里情况帮我分析可能的原因，给两条能省的办法，说短一点。` },
          numbers: { kind, amount: v, baseline: Math.round(base) },
        });
      }
    }
  }
  /* 没交的快到期了: 同一天到期的合成一条 (水电燃气宽带一起出, 分四条太吵) */
  const due = new Map<string, InsightRecord[]>();
  for (const r of xs) {
    const d = String(r.data?.due ?? '');
    if (r.data?.paid !== false || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const n = dayNo(d) - T;
    if (n < -3 || n > 5) continue;
    due.set(d, [...(due.get(d) ?? []), r]);
  }
  for (const [d, rows] of due) {
    const n = dayNo(d) - T;
    const total = sum(rows.map(r => Number(r.value ?? 0)));
    const names = rows.map(r => BILL_LABEL[String(r.data?.kind)] ?? '账单');
    const what = rows.length === 1 ? names[0] : `${rows.length} 张账单`;
    out.push({
      id: `home.bill.due:${d}`, domain: 'home', tone: 'watch', score: n <= 1 ? 0.9 : 0.75,
      title: n < 0 ? `${what}逾期 ${-n} 天了` : `${what} ${whenText(n)}到期`,
      detail: `${rows.map((r, i) => `${names[i]} ${yuan(Number(r.value ?? 0))}`).join('、')}${rows.length > 1 ? `，共 ${yuan(total)}` : ''}；${d.slice(5).replace('-', '月')}日前要交。`,
      action: { kind: 'remind', label: '今晚 8 点提醒我交', at: '20:00', title: `交${names.join('、')}，共 ${Math.round(total)} 元` },
      numbers: { amount: Math.round(total), due: d, days: n, count: rows.length },
    });
  }
  return out;
}

/** 档案里带到期日的: vehicle.小白.insurance_due / home.lease_due / me.passport_expire … 提前 30 天说 */
function expiries(facts: Record<string, unknown>, T: number): Insight[] {
  const NAMES: Record<string, string> = {
    insurance: '保险', inspection: '年检', maintenance: '保养', lease: '租约', passport: '护照', idcard: '身份证',
    license: '驾照', warranty: '保修', membership: '会员', visa: '签证', contract: '合同',
  };
  const out: Insight[] = [];
  for (const [k, v] of Object.entries(facts)) {
    const m = /^(?:(\w+)\.([^.]+)\.|(\w+)\.)?([a-z]+)_(due|expire|expiry)$/.exec(k);
    if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) continue;
    const owner = m[2] ?? '';
    const what = NAMES[m[4]] ?? m[4];
    const n = dayNo(String(v)) - T;
    if (n < -7 || n > 30) continue;
    const thing = `${owner}${what}`;
    out.push({
      id: `home.expire:${k}`, domain: 'home', tone: n <= 7 ? 'watch' : 'info', score: n <= 7 ? 0.85 : 0.6,
      title: n < 0 ? `${thing}已经过期 ${-n} 天` : `${thing}还有 ${n} 天到期`,
      detail: `${String(v).slice(5).replace('-', '月')}日到期。`,
      action: { kind: 'ask', label: '帮我办', prompt: `我的${thing} ${String(v)} 到期。告诉我现在该做什么（续保比价 / 预约 / 要带的材料），能替我办的直接办，再定个提醒。说短一点。` },
      numbers: { key: k, due: String(v), days: n },
    });
  }
  return out;
}

/** 这周练了几次; 或者很久没练了 */
function workouts(xs: InsightRecord[], T: number): Insight | null {
  if (!xs.length) return null;
  const last = Math.max(...xs.map(r => dayNo(r.day)));
  const week = xs.filter(r => T - dayNo(r.day) < 7);
  const prev = xs.filter(r => { const a = T - dayNo(r.day); return a >= 7 && a < 35; });
  if (T - last >= 7 && prev.length >= 4) {
    return {
      id: 'body.workout.gap', domain: 'body', tone: 'watch', score: 0.6,
      title: `${T - last} 天没运动了`,
      detail: `之前每周大约 ${Math.round(prev.length / 4)} 次。`,
      action: { kind: 'ask', label: '帮我排一下', prompt: '我一周多没运动了。按我之前的习惯和这周的空档，帮我排三次能坚持的运动，每次不超过 40 分钟，并定好提醒。' },
    };
  }
  if (week.length >= 3) {
    const mins = sum(week.map(r => Number(r.value ?? 0)));
    return {
      id: 'body.workout.week', domain: 'body', tone: 'good', score: 0.35,
      title: `这周练了 ${week.length} 次`,
      detail: `一共 ${Math.round(mins)} 分钟${prev.length ? `，前四周平均每周 ${Math.round(prev.length / 4)} 次` : ''}。`,
    };
  }
  return null;
}

/** 最近一份体检里偏高 / 偏低的项 */
function healthReport(xs: InsightRecord[], T: number): Insight | null {
  const r = xs.filter(x => T - dayNo(x.day) < 400).sort((a, b) => dayNo(b.day) - dayNo(a.day))[0];
  if (!r) return null;
  const items = Array.isArray(r.data?.items) ? (r.data!.items as Array<Record<string, unknown>>) : [];
  const off = items.filter(i => i.flag === 'high' || i.flag === 'low');
  if (!off.length) return null;
  const names = off.map(i => `${i.name}${i.flag === 'high' ? '偏高' : '偏低'}`);
  const ago = T - dayNo(r.day);
  return {
    id: 'body.report', domain: 'body', tone: ago > 180 ? 'watch' : 'info', score: ago > 180 ? 0.6 : 0.45,
    title: `体检有 ${off.length} 项要留意`,
    detail: `${String(r.data?.title ?? '体检')}（${r.day.slice(0, 7)}）：${names.slice(0, 3).join('、')}${ago > 180 ? '。快半年了，该复查了' : ''}。`,
    action: { kind: 'ask', label: '该怎么调', prompt: `我体检 ${names.join('、')}。按这些结果给我饮食和运动上能做的三件事，说清楚多久复查，说短一点。不确定的地方建议我问医生。` },
  };
}

// ───────── 统计小件 ─────────

function dayAvg(rows: InsightRecord[], val: (r: InsightRecord) => number): Map<string, number> {
  const acc = new Map<string, number[]>();
  for (const r of rows) {
    const v = val(r);
    if (!Number.isFinite(v)) continue;
    acc.set(r.day, [...(acc.get(r.day) ?? []), v]);
  }
  return new Map([...acc].map(([d, v]) => [d, avg(v)]));
}

function linSlope(pts: Array<{ x: number; y: number }>): number {
  const mx = avg(pts.map(p => p.x)), my = avg(pts.map(p => p.y));
  const num = sum(pts.map(p => (p.x - mx) * (p.y - my)));
  const den = sum(pts.map(p => (p.x - mx) ** 2));
  return den ? num / den : 0;
}

// ───────── 八个房间的摘要 (手机房间页只负责画, 数在这里算; 设计 §1 / §2) ─────────

export type RoomId = 'body' | 'money' | 'home' | 'people' | 'work' | 'place' | 'mind' | 'me';

/** 房间 → 中文名 (手机上的顺序就是这个) */
export const ROOMS: ReadonlyArray<{ id: RoomId; zh: string }> = [
  { id: 'body', zh: '身体' }, { id: 'money', zh: '钱' }, { id: 'home', zh: '家' }, { id: 'people', zh: '人' },
  { id: 'work', zh: '工作学习' }, { id: 'place', zh: '足迹' }, { id: 'mind', zh: '心' }, { id: 'me', zh: '我' },
];

/** 洞察归哪个房间 */
export function roomOf(i: Pick<Insight, 'domain' | 'id'>): RoomId {
  switch (i.domain) {
    case 'money': return 'money';
    case 'body': case 'habit': return 'body';
    case 'home': return 'home';
    case 'social': case 'day': return 'people';
    case 'work': return 'work';
    case 'place': return 'place';
    case 'mood': return 'mind';
    case 'me': return 'me';
    case 'cross': return i.id.includes('spend') ? 'money' : 'body';
  }
}

export type MoneyScene = {
  /** 近 6 个月每月花了多少 (含本月到今天) —— 柱子的高度 */
  months: Array<{ ym: string; amount: number }>;
  /** 平时一个月 (前 3 个完整月的中位数) —— 柱子上那条「平时」虚线 */
  usualMonth: number | null;
  /** 本月到今天 ÷ 平时同期: 1 = 正常, 2 = 快一倍 —— 硬币堆的高度 */
  pace: number | null;
  /** 上个完整月存下的比例 (收入 − 支出) ÷ 收入, 可以是负的 —— 存钱罐鼓多大 */
  savingsRate: number | null;
  /** 近 6 个月月底的净资产 —— 金库的刻度 */
  netWorth: Array<{ ym: string; value: number }>;
};
export type BodyScene = {
  goal: number | null;
  /** 90 天前的体重 (进度条起点) */
  start: number | null;
  weights: Array<{ day: string; kg: number }>;
  sleep7: Array<{ day: string; min: number }>;
  workout7: Array<{ day: string; min: number }>;
};
export type PlaceScene = {
  /** 有坐标的地方: 地图上的点 (去得多的大, 最近去的亮) */
  pins: Array<{ name: string; lat: number; lng: number; count: number; lastDays: number }>;
  /** 最近几次按时间连成线 */
  route: Array<{ name: string; lat: number; lng: number; day: string }>;
  home: { lat: number; lng: number } | null;
};

export type RoomsSummary = {
  body: { weight: number | null; weightDelta30: number | null; sleepMin: number | null; workoutsWeek: number; workoutMinWeek: number; scene: BodyScene };
  money: {
    monthSpent: number; spent7: number; netWorth: number | null; netWorthDelta30: number | null;
    accounts: Array<{ name: string; kind: string; value: number }>;
    subscriptions: Array<{ name: string; amount: number; nextDay: string }>;
    monthByCategory: Array<{ category: string; amount: number }>;
    scene: MoneyScene;
  };
  home: {
    city: string | null; address: string | null; monthBills: number;
    bills: Array<{ kind: string; label: string; amount: number; period: string; due: string | null; paid: boolean | null }>;
    vehicles: Array<{ name: string; model: string | null; items: Array<{ what: string; due: string; days: number }> }>;
  };
  people: { list: Array<{ name: string; relation: string | null; likes: string | null; birthday: string | null; birthdayInDays: number | null; lastContactDays: number | null }> };
  work: { job: string | null; deliverables: Array<{ title: string; day: string }> };
  place: { places: Array<{ name: string; last: string; count: number }>; newThisMonth: number; scene: PlaceScene };
  mind: { mood7: Array<{ day: string; score: number }> };
  me: { facts: Array<{ key: string; value: string }>; focus: string[]; knowledge: Array<{ title: string; kind: string; day: string }> };
};

export function summarizeRooms(records: InsightRecord[], opts: AnalyzeOptions): RoomsSummary {
  const T = dayNo(opts.today);
  const facts = opts.facts ?? {};
  const by = (t: string) => records.filter(r => name(r.type) === t && dayNo(r.day) <= T);
  const str = (v: unknown) => (v == null || v === '' ? null : String(v));

  // 身体
  const weights = by('health.weight').sort((a, b) => a.occurred_at - b.occurred_at);
  const w = weights.length ? Number(weights[weights.length - 1].value) : null;
  const w30 = weights.filter(r => T - dayNo(r.day) >= 28 && T - dayNo(r.day) <= 35).pop();
  const sleeps = by('health.sleep').sort((a, b) => a.occurred_at - b.occurred_at);
  const lastSleep = sleeps.length && T - dayNo(sleeps[sleeps.length - 1].day) <= 1 ? Number(sleeps[sleeps.length - 1].value) : null;
  const wk = by('fitness.workout').filter(r => T - dayNo(r.day) < 7);

  // 钱
  const ex = by('finance.expense').filter(r => (r.value ?? 0) > 0 && (!r.unit || r.unit === 'CNY'));
  const month = ex.filter(r => ym(r.day) === ym(opts.today));
  const cats = new Map<string, number>();
  for (const r of month) cats.set(expenseCategory(r), (cats.get(expenseCategory(r)) ?? 0) + r.value!);
  const assets = by('asset.snapshot');
  const nwNow = assets.length ? netWorthAt(assets, T) : null;
  const nwBefore = assets.length ? netWorthAt(assets, T - 30) : null;
  const kindOf = new Map<string, string>();
  for (const r of assets) kindOf.set(String(r.data?.account ?? ''), String(r.data?.kind ?? 'other'));

  // 家
  const billRows = by('bill').sort((a, b) => a.occurred_at - b.occurred_at);
  const latestBill = new Map<string, InsightRecord>();
  for (const r of billRows) latestBill.set(String(r.data?.kind ?? 'other'), r);
  const vehicles = new Map<string, { model: string | null; items: Array<{ what: string; due: string; days: number }> }>();
  const ITEM: Record<string, string> = { insurance: '保险', inspection: '年检', maintenance: '保养' };
  for (const [k, v] of Object.entries(facts)) {
    const m = /^vehicle\.([^.]+)\.(\w+)$/.exec(k);
    if (!m) continue;
    const cur = vehicles.get(m[1]) ?? { model: null, items: [] };
    if (m[2] === 'model') cur.model = String(v);
    const d = /^(\w+)_(due|expire)$/.exec(m[2]);
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) cur.items.push({ what: ITEM[d[1]] ?? d[1], due: String(v), days: dayNo(String(v)) - T });
    vehicles.set(m[1], cur);
  }

  // 人
  const social = by('social.interaction');
  const lastSeen = new Map<string, number>();
  for (const r of social) {
    for (const p of Array.isArray(r.data?.with) ? (r.data!.with as unknown[]) : []) {
      const n = String(p).trim();
      lastSeen.set(n, Math.max(lastSeen.get(n) ?? -Infinity, dayNo(r.day)));
    }
  }
  const people = knownPeople(facts, social).map(p => {
    const bd = monthDay(facts[`person.${p.name}.birthday`]);
    const seen = lastSeen.get(p.name);
    return {
      name: p.name,
      relation: p.relation || null,
      likes: str(facts[`person.${p.name}.likes`]),
      birthday: bd ? `${String(bd[0]).padStart(2, '0')}-${String(bd[1]).padStart(2, '0')}` : null,
      birthdayInDays: bd ? nextYearly(T, bd[0], bd[1]) - T : null,
      lastContactDays: seen == null ? null : T - seen,
    };
  }).sort((a, b) => (a.birthdayInDays ?? 999) - (b.birthdayInDays ?? 999) || (a.lastContactDays ?? 999) - (b.lastContactDays ?? 999));

  // 足迹
  const visits = by('place.visit').filter(r => T - dayNo(r.day) < 120);
  const pl = new Map<string, { last: number; count: number; first: number }>();
  for (const r of by('place.visit')) {
    const n = String(r.data?.name ?? '').trim();
    if (!n) continue;
    const cur = pl.get(n) ?? { last: -Infinity, count: 0, first: Infinity };
    pl.set(n, { last: Math.max(cur.last, dayNo(r.day)), count: cur.count + (T - dayNo(r.day) < 120 ? 1 : 0), first: Math.min(cur.first, dayNo(r.day)) });
  }
  void visits;

  // ── 场景的数 ──
  const yms: string[] = [];
  {
    const [y, m] = opts.today.split('-').map(Number);
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(y, m - 1 - i, 1));
      yms.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    }
  }
  const spentIn = (k: string) => Math.round(sum(ex.filter(r => ym(r.day) === k).map(r => r.value!)));
  const fullPrev = yms.slice(2, 5).map(spentIn).filter(v => v > 0);
  const usualMonth = fullPrev.length ? Math.round(median(fullPrev)) : null;
  const dom = Number(opts.today.slice(8, 10));
  /* 快慢跟「钱花得快」那条洞察同一把尺: 只比日常开销 (大额另算), 比前 3 个月同期 */
  const cap = Math.max(500, median(ex.filter(r => T - dayNo(r.day) < 120).map(r => r.value!)) * 6);
  const daily = ex.filter(r => r.value! < cap || expenseCategory(r) === '居家');
  const dailyTo = (k: string) => sum(daily.filter(r => ym(r.day) === k && Number(r.day.slice(8, 10)) <= dom).map(r => r.value!));
  const same = yms.slice(2, 5).map(dailyTo).filter(v => v > 0);
  const sameAvg = same.length ? sum(same) / same.length : 0;
  const income = by('finance.income').filter(r => (r.value ?? 0) > 0 && (!r.unit || r.unit === 'CNY'));
  const lastFull = yms[4];
  const incLast = sum(income.filter(r => ym(r.day) === lastFull).map(r => r.value!));
  const monthEnd = (k: string) => {
    const [y, m] = k.split('-').map(Number);
    return Math.min(T, dayNo(new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)));
  };
  const moneyScene: MoneyScene = {
    months: yms.map(k => ({ ym: k, amount: spentIn(k) })),
    usualMonth,
    pace: sameAvg > 0 ? Math.round((dailyTo(yms[5]) / sameAvg) * 100) / 100 : null,
    savingsRate: incLast > 0 ? Math.round(((incLast - spentIn(lastFull)) / incLast) * 100) / 100 : null,
    netWorth: assets.length ? yms.map(k => ({ ym: k, value: Math.round(netWorthAt(assets, monthEnd(k)).total) })).filter(p => p.value !== 0) : [],
  };
  const perDay = (rows: InsightRecord[], f: (r: InsightRecord) => number) => {
    const out: Array<{ day: string; v: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const d = noDay(T - i);
      out.push({ day: d, v: Math.round(sum(rows.filter(r => r.day === d).map(f))) });
    }
    return out;
  };
  const goal = Number(facts['goal.weight']);
  const w90 = weights.filter(r => T - dayNo(r.day) >= 85).pop() ?? weights[0];
  const bodyScene: BodyScene = {
    goal: Number.isFinite(goal) && goal > 0 ? goal : null,
    start: w90 ? Number(w90.value) : null,
    weights: weights.filter(r => T - dayNo(r.day) < 30).map(r => ({ day: r.day, kg: Number(r.value) })),
    sleep7: perDay(sleeps, r => Number(r.value ?? 0)).map(x => ({ day: x.day, min: x.v })),
    workout7: perDay(by('fitness.workout'), r => Number(r.value ?? 0)).map(x => ({ day: x.day, min: x.v })),
  };
  const geo = (r: InsightRecord) => {
    const lat = Number(r.data?.lat), lng = Number(r.data?.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0) ? { lat, lng } : null;
  };
  const withGeo = by('place.visit').filter(r => geo(r) && T - dayNo(r.day) < 365).sort((a, b) => a.occurred_at - b.occurred_at);
  const pinMap = new Map<string, { lat: number; lng: number; count: number; last: number }>();
  for (const r of withGeo) {
    const n = String(r.data?.name ?? '').trim();
    const g = geo(r)!;
    const cur = pinMap.get(n);
    pinMap.set(n, { ...g, count: (cur?.count ?? 0) + 1, last: Math.max(cur?.last ?? -Infinity, dayNo(r.day)) });
  }
  const route: PlaceScene['route'] = [];
  for (const r of withGeo) {
    const n = String(r.data?.name ?? '').trim();
    if (route.length && route[route.length - 1].name === n) continue;
    route.push({ name: n, ...geo(r)!, day: r.day });
  }
  const hg = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(facts['home.geo'] ?? ''));
  const placeScene: PlaceScene = {
    pins: [...pinMap].map(([n, x]) => ({ name: n, lat: x.lat, lng: x.lng, count: x.count, lastDays: T - x.last })).sort((a, b) => a.lastDays - b.lastDays).slice(0, 20),
    route: route.slice(-8),
    home: hg ? { lat: Number(hg[1]), lng: Number(hg[2]) } : null,
  };

  // 我
  const meFacts = Object.entries(facts)
    .filter(([k]) => k.startsWith('me.'))
    .map(([key, value]) => ({ key, value: typeof value === 'string' ? value : JSON.stringify(value) }));
  const knowledge = by('knowledge.item').sort((a, b) => b.occurred_at - a.occurred_at);

  return {
    body: {
      weight: w, weightDelta30: w != null && w30 ? Math.round((w - Number(w30.value)) * 10) / 10 : null, sleepMin: lastSleep,
      workoutsWeek: wk.length, workoutMinWeek: Math.round(sum(wk.map(r => Number(r.value ?? 0)))),
      scene: bodyScene,
    },
    money: {
      monthSpent: Math.round(sum(month.map(r => r.value!)) * 10) / 10,
      spent7: Math.round(sum(ex.filter(r => T - dayNo(r.day) < 7).map(r => r.value!)) * 10) / 10,
      netWorth: nwNow ? Math.round(nwNow.total) : null,
      netWorthDelta30: nwNow && nwBefore && nwBefore.accounts.size ? Math.round(nwNow.total - nwBefore.total) : null,
      accounts: nwNow ? [...nwNow.accounts].map(([n, v]) => ({ name: n, kind: kindOf.get(n) ?? 'other', value: Math.round(v) })).sort((a, b) => b.value - a.value) : [],
      subscriptions: detectSubscriptions(ex, T).map(s => ({ name: s.who, amount: s.amount, nextDay: noDay(s.next) })),
      monthByCategory: [...cats].map(([category, amount]) => ({ category, amount: Math.round(amount * 10) / 10 })).sort((a, b) => b.amount - a.amount),
      scene: moneyScene,
    },
    home: {
      city: str(facts['home.city']), address: str(facts['home.address']),
      monthBills: Math.round(sum(billRows.filter(r => ym(r.day) === ym(opts.today)).map(r => Number(r.value ?? 0))) * 10) / 10,
      bills: [...latestBill].map(([kind, r]) => ({
        kind, label: BILL_LABEL[kind] ?? '账单', amount: Number(r.value ?? 0), period: String(r.data?.period ?? r.day.slice(0, 7)),
        due: str(r.data?.due), paid: typeof r.data?.paid === 'boolean' ? (r.data!.paid as boolean) : null,
      })),
      vehicles: [...vehicles].map(([n, v]) => ({ name: n, model: v.model, items: v.items.sort((a, b) => a.days - b.days) })),
    },
    people: { list: people },
    work: {
      job: str(facts['me.job']),
      deliverables: knowledge.filter(r => r.data?.kind === 'deliverable' || r.data?.kind === 'doc').slice(0, 10).map(r => ({ title: String(r.data?.title ?? r.title ?? ''), day: r.day })),
    },
    place: {
      places: [...pl].sort((a, b) => b[1].last - a[1].last).slice(0, 12).map(([n, x]) => ({ name: n, last: noDay(x.last), count: x.count })),
      newThisMonth: [...pl.values()].filter(x => T - x.first < 30).length,
      scene: placeScene,
    },
    mind: { mood7: [...dayAvg(by('mood').filter(r => T - dayNo(r.day) < 7), r => Number(r.data?.score ?? r.value))].map(([day, score]) => ({ day, score: Math.round(score * 10) / 10 })).sort((a, b) => a.day.localeCompare(b.day)) },
    me: {
      facts: meFacts,
      focus: Array.isArray(facts['pilot.focus']) ? (facts['pilot.focus'] as unknown[]).map(String) : [],
      knowledge: knowledge.slice(0, 20).map(r => ({ title: String(r.data?.title ?? r.title ?? ''), kind: String(r.data?.kind ?? 'note'), day: r.day })),
    },
  };
}
