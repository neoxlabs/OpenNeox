/**
 * 类型注册表。内置类型写死在这里 (前后端一份); 插件 / 用户自定义类型存在服务端 custom_types,
 * 通过 TypeResolver 一起解析。
 *
 * 版本规则: 加可选字段 = 同版本; 改语义 = 升版本 (@2), 老记录不动, 读的时候各按各的版本解释。
 */
import type { FieldSpec, TypeDef } from './types.js';

const str = (o: Partial<FieldSpec> = {}): FieldSpec => ({ type: 'string', maxLength: 2000, ...o });
const num = (o: Partial<FieldSpec> = {}): FieldSpec => ({ type: 'number', ...o });
const int = (o: Partial<FieldSpec> = {}): FieldSpec => ({ type: 'integer', ...o });
const strList = (o: Partial<FieldSpec> = {}): FieldSpec => ({ type: 'array', items: str({ maxLength: 200 }), ...o });

export const BUILTIN_TYPES: readonly TypeDef[] = [
  {
    name: 'note', version: 1, domain: 'life', privacy: 'private', kind: 'note', owner: 'core',
    label: { zh: '随手记', en: 'Note' },
    fields: { text: str({ required: true, maxLength: 20_000 }), lang: str({ maxLength: 16 }) },
    title: '{text}',
  },
  {
    name: 'task', version: 1, domain: 'work', privacy: 'normal', kind: 'point', owner: 'core', future: true,
    label: { zh: '待办', en: 'Task' },
    fields: {
      text: str({ required: true }),
      status: str({ enum: ['todo', 'doing', 'done', 'dropped'] }),
      due: int({ min: 0 }),
      project: str({ maxLength: 200 }),
    },
    title: '{text}',
  },
  {
    name: 'mood', version: 1, domain: 'life', privacy: 'private', kind: 'metric', owner: 'core',
    label: { zh: '心情', en: 'Mood' },
    fields: { score: int({ required: true, min: 1, max: 5 }), note: str() },
    valueFrom: 'score', aggregate: 'avg', unit: '/5',
    title: '心情 {score}/5',
  },
  {
    name: 'health.weight', version: 1, domain: 'health', privacy: 'sensitive', kind: 'metric', owner: 'core',
    label: { zh: '体重', en: 'Weight' },
    fields: { bodyFat: num({ min: 0, max: 100 }) },
    unit: 'kg', aggregate: 'last',
    title: '体重',
  },
  {
    name: 'health.sleep', version: 1, domain: 'health', privacy: 'sensitive', kind: 'interval', owner: 'core',
    label: { zh: '睡眠', en: 'Sleep' },
    fields: { quality: int({ min: 1, max: 5 }), deepMin: num({ min: 0 }), remMin: num({ min: 0 }), awakeMin: num({ min: 0 }) },
    unit: 'min', aggregate: 'sum', valueFrom: '$durationMin',
    title: '睡眠',
  },
  {
    name: 'health.steps', version: 1, domain: 'health', privacy: 'normal', kind: 'metric', owner: 'core',
    label: { zh: '步数', en: 'Steps' },
    fields: {},
    unit: 'steps', aggregate: 'sum',
    title: '步数 {value}',
  },
  {
    name: 'health.heart_rate', version: 1, domain: 'health', privacy: 'sensitive', kind: 'metric', owner: 'core',
    label: { zh: '心率', en: 'Heart rate' },
    fields: { context: str({ enum: ['rest', 'active', 'sleep', 'unknown'] }) },
    unit: 'bpm', aggregate: 'avg',
    title: '心率',
  },
  {
    name: 'finance.expense', version: 1, domain: 'finance', privacy: 'sensitive', kind: 'metric', owner: 'core',
    label: { zh: '支出', en: 'Expense' },
    fields: {
      currency: str({ required: true, maxLength: 8 }),
      category: str({ maxLength: 64 }),
      merchant: str({ maxLength: 200 }),
      method: str({ maxLength: 64 }),
      note: str(),
    },
    unitField: 'currency', metricBy: 'currency', aggregate: 'sum',
    title: '支出 {category}',
  },
  {
    name: 'finance.income', version: 1, domain: 'finance', privacy: 'sensitive', kind: 'metric', owner: 'core',
    label: { zh: '收入', en: 'Income' },
    fields: { currency: str({ required: true, maxLength: 8 }), category: str({ maxLength: 64 }), payer: str({ maxLength: 200 }), note: str() },
    unitField: 'currency', metricBy: 'currency', aggregate: 'sum',
    title: '收入 {category}',
  },
  {
    name: 'place.visit', version: 1, domain: 'place', privacy: 'private', kind: 'interval', owner: 'core',
    label: { zh: '到访', en: 'Place visit' },
    fields: {
      name: str({ required: true, maxLength: 200 }),
      lat: num({ min: -90, max: 90 }), lng: num({ min: -180, max: 180 }),
      address: str({ maxLength: 500 }),
    },
    title: '在 {name}',
  },
  {
    name: 'media.photo', version: 1, domain: 'media', privacy: 'private', kind: 'point', owner: 'core',
    label: { zh: '照片', en: 'Photo' },
    fields: { caption: str(), lat: num({ min: -90, max: 90 }), lng: num({ min: -180, max: 180 }), width: int({ min: 0 }), height: int({ min: 0 }) },
    title: '照片 {caption}',
  },
  {
    name: 'social.interaction', version: 1, domain: 'social', privacy: 'private', kind: 'point', owner: 'core',
    label: { zh: '来往', en: 'Interaction' },
    fields: {
      with: strList({ required: true }),
      channel: str({ enum: ['meet', 'call', 'message', 'email', 'other'] }),
      summary: str({ maxLength: 4000 }),
    },
    title: '和 {with}',
  },
  {
    name: 'work.focus', version: 1, domain: 'work', privacy: 'normal', kind: 'interval', owner: 'core',
    label: { zh: '专注', en: 'Focus' },
    fields: { project: str({ maxLength: 200 }), app: str({ maxLength: 200 }), summary: str() },
    unit: 'min', aggregate: 'sum', valueFrom: '$durationMin',
    title: '专注 {project}',
  },
  {
    name: 'habit.check', version: 1, domain: 'life', privacy: 'normal', kind: 'metric', owner: 'core',
    label: { zh: '打卡', en: 'Habit check' },
    fields: { habit: str({ required: true, maxLength: 100 }), done: { type: 'boolean' } },
    unit: 'times', aggregate: 'sum', metricBy: 'habit',
    title: '打卡 {habit}',
  },
  {
    name: 'event.calendar', version: 1, domain: 'work', privacy: 'normal', kind: 'interval', owner: 'core', future: true,
    label: { zh: '日程', en: 'Calendar event' },
    fields: {
      title: str({ required: true, maxLength: 500 }),
      location: str({ maxLength: 500 }),
      attendees: strList(),
      calendar: str({ maxLength: 200 }),
      externalId: str({ maxLength: 500 }),
    },
    title: '{title}',
  },
  {
    name: 'fact.assert', version: 1, domain: 'life', privacy: 'private', kind: 'fact', owner: 'core',
    label: { zh: '事实', en: 'Fact' },
    fields: {
      /* 'birthday' / 'allergy.peanut' / 'home.city' —— 同 key 新的取代旧的 */
      key: str({ required: true, maxLength: 120 }),
      value: { type: 'any', required: true },
      validFrom: int({ min: 0 }),
    },
    title: '{key}: {value}',
  },
  {
    /* 人 / 地方 / 物 / 账户。更正 = supersedes; 别的记录用 refs 挂到它上面 */
    name: 'entity', version: 1, domain: 'life', privacy: 'private', kind: 'point', owner: 'core',
    label: { zh: '实体', en: 'Entity' },
    fields: {
      kind: str({ required: true, enum: ['person', 'place', 'home', 'vehicle', 'appliance', 'pet', 'account', 'asset', 'org', 'course', 'client'] }),
      name: str({ required: true, maxLength: 200 }),
      aliases: strList(),
      attrs: { type: 'object' },
    },
    title: '{name}',
  },
  {
    /* 某天某个账户值多少 (负债记负数); 净资产 = 每个账户最新一笔之和 */
    name: 'asset.snapshot', version: 1, domain: 'finance', privacy: 'sensitive', kind: 'metric', owner: 'core',
    label: { zh: '资产', en: 'Asset snapshot' },
    fields: {
      account: str({ required: true, maxLength: 200 }),
      kind: str({ required: true, enum: ['cash', 'deposit', 'fund', 'stock', 'property', 'vehicle', 'debt', 'credit', 'other'] }),
      currency: str({ required: true, maxLength: 8 }),
    },
    unitField: 'currency', metricBy: 'account', aggregate: 'last',
    title: '{account}',
  },
  {
    /* 家里的账单: 同类按月比 */
    name: 'bill', version: 1, domain: 'finance', privacy: 'private', kind: 'metric', owner: 'core',
    label: { zh: '账单', en: 'Bill' },
    fields: {
      kind: str({ required: true, enum: ['electric', 'water', 'gas', 'property', 'internet', 'phone', 'rent', 'mortgage', 'insurance', 'other'] }),
      currency: str({ required: true, maxLength: 8 }),
      period: str({ maxLength: 7 }),
      due: str({ maxLength: 10 }),
      paid: { type: 'boolean' },
      payee: str({ maxLength: 200 }),
    },
    unitField: 'currency', metricBy: 'kind', aggregate: 'sum',
    title: '账单 {kind}',
  },
  {
    name: 'fitness.workout', version: 1, domain: 'health', privacy: 'normal', kind: 'metric', owner: 'core',
    label: { zh: '运动', en: 'Workout' },
    fields: {
      kind: str({ required: true, enum: ['run', 'gym', 'swim', 'yoga', 'ride', 'walk', 'ball', 'other'] }),
      distanceKm: num({ min: 0, max: 1000 }),
      calories: num({ min: 0 }),
      sets: { type: 'array', items: { type: 'object' } },
      note: str(),
    },
    unit: 'min', metricBy: 'kind', aggregate: 'sum',
    title: '运动 {kind} {value} 分钟',
  },
  {
    /* 体检报告 (截图 / 拍照识别): items = [{name, value, unit, flag: 'high'|'low'|'ok'}] */
    name: 'health.report', version: 1, domain: 'health', privacy: 'sensitive', kind: 'note', owner: 'core',
    label: { zh: '体检报告', en: 'Health report' },
    fields: {
      title: str({ required: true, maxLength: 200 }),
      items: { type: 'array', items: { type: 'object' } },
      summary: str({ maxLength: 4000 }),
    },
    title: '{title}',
  },
  {
    /* 情境层写的状态段: 在家 / 上班 / 通勤 / 开车 / 刚停车 / 在外面 / 旅行 / 睡觉 */
    name: 'context.state', version: 1, domain: 'place', privacy: 'private', kind: 'interval', owner: 'core',
    label: { zh: '状态', en: 'Context' },
    fields: {
      state: str({ required: true, enum: ['home', 'work', 'commute', 'driving', 'parked', 'outside', 'travel', 'sleep'] }),
      place: str({ maxLength: 200 }),
      lat: num({ min: -90, max: 90 }), lng: num({ min: -180, max: 180 }),
      city: str({ maxLength: 100 }),
    },
    title: '{state}',
  },
  {
    /* 知识库: 收藏的链接、笔记、文档摘要、它替你做出来的成品 */
    name: 'knowledge.item', version: 1, domain: 'learning', privacy: 'private', kind: 'note', owner: 'core',
    label: { zh: '知识', en: 'Knowledge' },
    fields: {
      title: str({ required: true, maxLength: 500 }),
      url: str({ maxLength: 2000 }),
      text: str({ maxLength: 20_000 }),
      tags: strList(),
      kind: str({ enum: ['link', 'note', 'doc', 'deliverable', 'quote'] }),
    },
    title: '{title}',
  },
  {
    name: 'agent.run', version: 1, domain: 'work', privacy: 'private', kind: 'point', owner: 'core',
    label: { zh: '专员干活', en: 'Specialist run' },
    fields: {
      specialist: str({ required: true, maxLength: 40 }),
      via: str({ enum: ['ask', 'schedule'] }),
      task: str({ maxLength: 1000 }),
      summary: str({ required: true, maxLength: 8000 }),
      model: str({ maxLength: 100 }),
      tokens: int({ min: 0 }),
    },
    title: '{summary}',
  },
  {
    name: 'trigger', version: 1, domain: 'life', privacy: 'private', kind: 'point', owner: 'core',
    label: { zh: '触发', en: 'Trigger' },
    fields: {
      when: str({ required: true, enum: ['yearly', 'date', 'weekly', 'place', 'person'] }),
      /* yearly: 'MM-DD'; date: 'YYYY-MM-DD' */
      date: str({ maxLength: 10 }),
      /* weekly: 1 (周一) ~ 7 (周日) */
      weekday: int({ min: 1, max: 7 }),
      /* 几点提醒 'HH:mm', 默认 09:00 */
      time: str({ maxLength: 5 }),
      place: str({ maxLength: 200 }),
      /* place 类: 到了 (enter, 默认) 还是离开 (leave) 时提醒; 「家」「公司」由手机围栏当场弹 */
      on: str({ enum: ['enter', 'leave'] }),
      who: str({ maxLength: 100 }),
      text: str({ required: true, maxLength: 1000 }),
      /* 提前几天冒出来 (生日送礼要提前) */
      leadDays: int({ min: 0, max: 60 }),
    },
    title: '{text}',
  },
];

export const TYPE_NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$/;

/** 'health.weight@1' → { name, version }; 不带版本 → version null (取最新) */
export function parseTypeRef(ref: string): { name: string; version: number | null } | null {
  const m = /^([^@]+)(?:@(\d{1,4}))?$/.exec(ref.trim());
  if (!m || !TYPE_NAME_RE.test(m[1])) return null;
  return { name: m[1], version: m[2] ? Number(m[2]) : null };
}

export const typeKey = (t: Pick<TypeDef, 'name' | 'version'>) => `${t.name}@${t.version}`;

export type TypeResolver = (name: string, version: number | null) => TypeDef | null;

/** 一组类型定义 → 解析器 (版本 null 取最大版本) */
export function makeResolver(defs: readonly TypeDef[]): TypeResolver {
  const byName = new Map<string, TypeDef[]>();
  for (const d of defs) {
    const list = byName.get(d.name) ?? [];
    list.push(d);
    byName.set(d.name, list);
  }
  for (const list of byName.values()) list.sort((a, b) => b.version - a.version);
  return (name, version) => {
    const list = byName.get(name);
    if (!list) return null;
    return version == null ? list[0] : list.find(d => d.version === version) ?? null;
  };
}

export const builtinResolver: TypeResolver = makeResolver(BUILTIN_TYPES);

/** 先查内置, 再查自定义 —— 内置名字不许被插件覆盖 */
export function chainResolvers(...rs: TypeResolver[]): TypeResolver {
  return (name, version) => {
    for (const r of rs) {
      const d = r(name, version);
      if (d) return d;
    }
    return null;
  };
}
