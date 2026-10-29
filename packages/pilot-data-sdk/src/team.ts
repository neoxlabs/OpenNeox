import type { Insight, InsightDomain, RoomId } from './insights.js';
import { isoWeekday } from './triggers.js';

export type SpecialistId = 'health' | 'finance' | 'home' | 'social' | 'work' | 'travel';

export type Specialist = {
  id: SpecialistId;
  name: string;
  /** 一句话: 它管什么 */
  duty: string;
  rooms: RoomId[];
  /** 它能看的洞察 */
  domains: InsightDomain[];
  /** 它能看的记录类型 (前缀匹配: 'health.' = 所有 health.*) */
  types: string[];
  /** 它能看的档案 key 前缀 */
  facts: string[];
  /** 说话的规矩 (追加在通用规矩后面) */
  rules: string;
  /** 定时的活: 每周几 / 每月几号, 几点, 做什么 */
  schedule?: { every: 'week' | 'month'; day: number; time: string; label: string; task: string };
  /** 陶土小人 / 图标 */
  clay: string;
};

export const SPECIALISTS: readonly Specialist[] = [
  {
    id: 'health', name: '健康教练', duty: '体重、睡眠、运动、体检，排每周训练',
    rooms: ['body', 'mind'], domains: ['body', 'mood', 'habit', 'cross'],
    types: ['health.', 'fitness.workout', 'mood', 'habit.check'], facts: ['goal.', 'me.'],
    rules: '按他的目标和真实记录排，具体到哪天、做什么、多久；体检异常项给生活上能做的，不下诊断，严重的让他去看医生。',
    schedule: { every: 'week', day: 7, time: '20:00', label: '周日排下周', task: '这周身体小结（体重、睡眠、运动各一句带数），再排下周训练：周一到周日每天做什么、多久，照顾他的作息和体重目标。' },
    clay: 'i-pulse',
  },
  {
    id: 'finance', name: '财务管家', duty: '花销、收入、资产、订阅，每月出月报',
    rooms: ['money'], domains: ['money', 'cross'],
    types: ['finance.', 'asset.snapshot', 'bill'], facts: ['goal.', 'me.'],
    rules: '数字都从记录里来，写清比较的基准（比平时 / 比上月）；建议要具体到哪一类、省多少；不推荐具体理财产品。',
    schedule: { every: 'month', day: 1, time: '09:00', label: '每月 1 号出月报', task: '上个月月报：一共花了多少、比平时多还是少、哪类变化最大、固定支出和订阅、储蓄率、净资产变化；最后给下个月三条能做的。' },
    clay: 'i-coins',
  },
  {
    id: 'home', name: '家务管家', duty: '水电燃气物业、车和证件到期、家里的事',
    rooms: ['home'], domains: ['home'],
    types: ['bill', 'asset.snapshot', 'task'], facts: ['home.', 'vehicle.', 'me.passport'],
    rules: '先说快到期 / 没交的，再说哪项变贵、可能为什么；能办的事写清去哪办、带什么。',
    schedule: { every: 'month', day: 5, time: '09:00', label: '每月 5 号查一遍家', task: '家里这个月：账单交了没（没交的写到期日）、哪项比前几个月贵、车险年检证件哪些 30 天内到期、这个月要办的事。' },
    clay: 'i-house',
  },
  {
    id: 'social', name: '社交秘书', duty: '生日纪念日、多久没联系、送什么',
    rooms: ['people'], domains: ['social', 'day'],
    types: ['social.interaction', 'trigger'], facts: ['person.'],
    rules: '按每个人的喜好和关系说；送礼给两三个具体选项和价位；联系的话可以替他拟一句开场。',
    schedule: { every: 'week', day: 5, time: '18:00', label: '周五看周末', task: '这个周末：谁该联系了（多久没联系）、两周内的生日纪念日节日、各送什么（按他们的喜好给两个选项），再拟一句给最该联系的那个人的话。' },
    clay: 'i-person',
  },
  {
    id: 'work', name: '工作助理', duty: '日程、要交的东西、做出来的成品',
    rooms: ['work'], domains: ['work'],
    types: ['work.focus', 'event.calendar', 'task', 'knowledge.item'], facts: ['me.job', 'me.'],
    rules: '按他的职业说话；清单最多三条，每条写清截止和下一步；需要做文档 / PPT 的说清楚交给主管去做。',
    schedule: { every: 'week', day: 1, time: '08:30', label: '周一列本周', task: '这周工作：日程里要紧的、要交的东西和截止、上周做出来的成品；给一个本周三件事清单。' },
    clay: 'i-laptop',
  },
  {
    id: 'travel', name: '出行向导', duty: '去过哪、在外地时的天气路线吃的',
    rooms: ['place'], domains: ['place'],
    types: ['place.visit', 'context.state'], facts: ['home.city', 'me.likes'],
    rules: '到了外地先说天气和要带什么，再推荐附近两三个按他口味的吃的和一条不绕路的玩法。',
    clay: 'i-route',
  },
];

export function specialistOf(id: string): Specialist | undefined {
  return SPECIALISTS.find((s) => s.id === id);
}

/** 这条记录类型归不归它看 */
export function inScope(spec: Specialist, type: string): boolean {
  const t = type.split('@')[0];
  return spec.types.some((p) => (p.endsWith('.') ? t.startsWith(p) : t === p));
}

export function factInScope(spec: Specialist, key: string): boolean {
  return spec.facts.some((p) => key.startsWith(p));
}

/** 开着没 (档案 team.<id> = off 才算关) */
export function specialistOn(spec: Specialist, facts: Record<string, unknown>): boolean {
  return facts[`team.${spec.id}`] !== 'off';
}

/** 定时的钟点 (档案 team.<id>.time 可改) */
export function scheduleTime(spec: Specialist, facts: Record<string, unknown>): string | null {
  if (!spec.schedule) return null;
  const t = facts[`team.${spec.id}.time`];
  return typeof t === 'string' && /^\d{2}:\d{2}$/.test(t) ? t : spec.schedule.time;
}

export type TeamJob = { key: string; specialist: SpecialistId; task: string; label: string };

/** 此刻 (本地 day + time) 该派的定时活; 去重 key 由调用方的 trigger_runs 管 */
export function dueTeamJobs(facts: Record<string, unknown>, now: { day: string; time: string }): TeamJob[] {
  const out: TeamJob[] = [];
  for (const s of SPECIALISTS) {
    const sch = s.schedule;
    if (!sch || !specialistOn(s, facts)) continue;
    const at = scheduleTime(s, facts)!;
    if (now.time < at) continue;
    const hit = sch.every === 'week' ? isoWeekday(now.day) === sch.day : Number(now.day.slice(8, 10)) === sch.day;
    if (hit) out.push({ key: `team:${s.id}|${now.day}`, specialist: s.id, task: sch.task, label: sch.label });
  }
  return out;
}

/** 下一次定时在哪天 (团队页「下次 10 月 18 日 20:00」) */
export function nextRun(spec: Specialist, facts: Record<string, unknown>, now: { day: string; time: string }): string | null {
  const sch = spec.schedule;
  if (!sch || !specialistOn(spec, facts)) return null;
  const at = scheduleTime(spec, facts)!;
  for (let i = 0; i < 40; i++) {
    const t = Date.parse(`${now.day}T00:00:00Z`) + i * 86_400_000;
    const d = new Date(t).toISOString().slice(0, 10);
    const hit = sch.every === 'week' ? isoWeekday(d) === sch.day : Number(d.slice(8, 10)) === sch.day;
    if (hit && (i > 0 || now.time < at)) return `${d} ${at}`;
  }
  return null;
}

export type SpecialistContext = {
  today: string;
  insights: Insight[];
  /** 已经按范围筛好、格式化成一行一条的记录 (新的在前) */
  records: string[];
  facts: Record<string, unknown>;
};

/**
 * 专员这一次的提示词: 通用规矩 + 它自己的规矩 + 它范围内的数据 + 任务。
 * 只放它能看的; 数据不够就让它直说不够, 别编。
 */
export function specialistPrompt(spec: Specialist, task: string, ctx: SpecialistContext): { system: string; user: string } {
  const ins = ctx.insights.filter((i) => spec.domains.includes(i.domain));
  const facts = Object.entries(ctx.facts).filter(([k]) => factInScope(spec, k)).map(([k, v]) => `${k} = ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  const system = [
    `你是用户的「${spec.name}」，Pilot 团队里的专员，只管：${spec.duty}。`,
    '你交回的结论会由主管转给用户。规矩：',
    '- 只用下面给你的记录和档案，数字照抄，不编；数据不够就直说缺什么、让他记什么。',
    '- 中文，口语，短：先一句结论，再最多五行要点；有能直接办的事，最后一行写「可以帮你：…」。',
    '- 不寒暄，不说「作为 AI」。',
    `- ${spec.rules}`,
  ].join('\n');
  const user = [
    `今天 ${ctx.today}。`,
    `任务：${task}`,
    '',
    `【它发现的（${ins.length}）】`,
    ...(ins.length ? ins.map((i) => `- [${i.tone}] ${i.title} —— ${i.detail}`) : ['（没有）']),
    '',
    `【档案（${facts.length}）】`,
    ...(facts.length ? facts : ['（没有）']),
    '',
    `【记录（最近 ${ctx.records.length} 条）】`,
    ...(ctx.records.length ? ctx.records : ['（没有）']),
  ].join('\n');
  return { system, user };
}
