/**
 * 记录校验与补全 —— 设备上写之前先跑一遍 (早发现早报错), 服务端落库前再跑一遍 (不信任客户端)。
 * 两边同一份代码, 结果一致。
 */
import { builtinResolver, parseTypeRef, TYPE_NAME_RE, typeKey, type TypeResolver } from './registry.js';
import { ULID_RE } from './ulid.js';
import type { FieldSpec, PilotRecord, Privacy, RecordInput, RecordRef, TypeDef } from './types.js';

export const LIMITS = {
  titleMax: 500,
  tagsMax: 32,
  tagMax: 64,
  refsMax: 64,
  dataBytesMax: 64 * 1024,
  sourceMax: 200,
  /** 早于 1900 年或晚于「现在 + 1 天」的时间都当填错 */
  minTime: -2_208_988_800_000,
  futureSlackMs: 86_400_000,
  futureTypeMs: 2 * 366 * 86_400_000,
} as const;

const PRIVACY_RANK: Record<Privacy, number> = { normal: 0, private: 1, sensitive: 2 };
export const morePrivate = (a: Privacy, b: Privacy): Privacy => (PRIVACY_RANK[a] >= PRIVACY_RANK[b] ? a : b);
export const privacyAllowed = (p: Privacy, max: Privacy) => PRIVACY_RANK[p] <= PRIVACY_RANK[max];

export type Normalized = { ok: true; record: PilotRecord; def: TypeDef } | { ok: false; error: string };

function checkField(path: string, spec: FieldSpec, v: unknown): string | null {
  if (v === undefined || v === null) return spec.required ? `${path} 必填` : null;
  switch (spec.type) {
    case 'any':
      return null;
    case 'string':
      if (typeof v !== 'string') return `${path} 应为字符串`;
      if (spec.maxLength != null && v.length > spec.maxLength) return `${path} 超长 (${v.length} > ${spec.maxLength})`;
      if (spec.required && !v.trim()) return `${path} 不能为空`;
      break;
    case 'number':
    case 'integer':
      if (typeof v !== 'number' || !Number.isFinite(v)) return `${path} 应为数字`;
      if (spec.type === 'integer' && !Number.isInteger(v)) return `${path} 应为整数`;
      if (spec.min != null && v < spec.min) return `${path} 不能小于 ${spec.min}`;
      if (spec.max != null && v > spec.max) return `${path} 不能大于 ${spec.max}`;
      break;
    case 'boolean':
      if (typeof v !== 'boolean') return `${path} 应为 true/false`;
      break;
    case 'array':
      if (!Array.isArray(v)) return `${path} 应为数组`;
      if (spec.required && v.length === 0) return `${path} 不能为空`;
      if (spec.max != null && v.length > spec.max) return `${path} 最多 ${spec.max} 项`;
      if (spec.items) for (let i = 0; i < v.length; i++) {
        const e = checkField(`${path}[${i}]`, { ...spec.items, required: true }, v[i]);
        if (e) return e;
      }
      return null;
    case 'object':
      if (typeof v !== 'object' || Array.isArray(v)) return `${path} 应为对象`;
      return null;
  }
  if (spec.enum && !spec.enum.includes(v as string | number)) return `${path} 只能是 ${spec.enum.join(' / ')}`;
  return null;
}

/** 校验 data: 已声明字段按规格查; 未声明的字段放行 (加字段不升版本), 但整体有大小上限 */
export function validateData(def: TypeDef, data: Record<string, unknown>): string | null {
  for (const [k, spec] of Object.entries(def.fields)) {
    const e = checkField(k, spec, data[k]);
    if (e) return e;
  }
  return null;
}

function fillTitle(tpl: string, rec: { data: Record<string, unknown>; value: number | null; unit: string | null }): string {
  return tpl
    .replace(/\{(\w+)\}/g, (_, k: string) => {
      if (k === 'value') return rec.value == null ? '' : String(rec.value);
      if (k === 'unit') return rec.unit ?? '';
      const v = rec.data[k];
      if (v == null) return '';
      if (Array.isArray(v)) return v.join('、');
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** 敏感类型的自动标题不带数值 (检索只靠标题, 标题不泄露体重 / 金额) */
function autoTitle(def: TypeDef, rec: { data: Record<string, unknown>; value: number | null; unit: string | null }): string {
  const tpl = def.title ?? def.label.zh;
  const t = fillTitle(def.privacy === 'sensitive' ? tpl.replace(/\{value\}|\{unit\}/g, '') : tpl, rec);
  return t || def.label.zh;
}

function cleanRefs(refs: unknown): RecordRef[] | string {
  if (refs == null) return [];
  if (!Array.isArray(refs)) return 'refs 应为数组';
  if (refs.length > LIMITS.refsMax) return `refs 最多 ${LIMITS.refsMax} 个`;
  const out: RecordRef[] = [];
  for (const r of refs) {
    const kind = (r as RecordRef)?.kind;
    const id = (r as RecordRef)?.id;
    if (!['entity', 'blob', 'record', 'doc'].includes(kind) || typeof id !== 'string' || !id || id.length > 200) return 'refs 格式不对';
    out.push({ kind, id });
  }
  return out;
}

function cleanTags(tags: unknown): string[] | string {
  if (tags == null) return [];
  if (!Array.isArray(tags)) return 'tags 应为数组';
  const out = new Set<string>();
  for (const t of tags) {
    if (typeof t !== 'string') return 'tags 只能是字符串';
    const s = t.trim();
    if (!s) continue;
    if (s.length > LIMITS.tagMax) return `标签过长: ${s.slice(0, 20)}…`;
    out.add(s);
  }
  if (out.size > LIMITS.tagsMax) return `标签最多 ${LIMITS.tagsMax} 个`;
  return [...out];
}

function isValidTz(tz: string): boolean {
  if (tz === 'UTC') return true;
  if (/^[+-]\d{2}:\d{2}$/.test(tz)) return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * 一条输入 → 校验后的记录。
 * - type 不带版本时取最新版本, 落库一律带版本。
 * - privacy 只能比类型默认更高 (把体重标成 normal 不允许)。
 * - 数值型: value 缺省时按 valueFrom 取; interval 型要有 ended_at。
 */
export function normalizeRecord(input: RecordInput, opts: { resolve?: TypeResolver; now?: number; defaultSource?: string } = {}): Normalized {
  const resolve = opts.resolve ?? builtinResolver;
  const now = opts.now ?? Date.now();
  if (!input || typeof input !== 'object') return { ok: false, error: '记录应为对象' };
  if (typeof input.id !== 'string' || !ULID_RE.test(input.id)) return { ok: false, error: 'id 应为 ULID' };

  const ref = typeof input.type === 'string' ? parseTypeRef(input.type) : null;
  if (!ref) return { ok: false, error: `类型名不合法: ${String(input.type)}` };
  const def = resolve(ref.name, ref.version);
  if (!def) return { ok: false, error: `未知类型: ${input.type}` };

  const at = input.occurred_at;
  /* 日程 / 待办天生在将来 (下周的会、月底截止): 放宽到两年; 别的类型记的是发生过的事, 只容一天时差 */
  const slack = def.future ? LIMITS.futureTypeMs : LIMITS.futureSlackMs;
  if (typeof at !== 'number' || !Number.isInteger(at) || at < LIMITS.minTime || at > now + slack) {
    return { ok: false, error: 'occurred_at 应为合理的毫秒时间' };
  }
  let ended: number | null = input.ended_at ?? null;
  if (ended != null && (typeof ended !== 'number' || !Number.isInteger(ended) || ended < at)) return { ok: false, error: 'ended_at 不能早于 occurred_at' };
  if (def.kind === 'interval' && ended == null) return { ok: false, error: `${def.name} 需要 ended_at` };

  const data = input.data ?? {};
  if (typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'data 应为对象' };
  const dataErr = validateData(def, data);
  if (dataErr) return { ok: false, error: dataErr };
  if (JSON.stringify(data).length > LIMITS.dataBytesMax) return { ok: false, error: 'data 过大' };

  let value: number | null = input.value ?? null;
  if (value != null && (typeof value !== 'number' || !Number.isFinite(value))) return { ok: false, error: 'value 应为数字' };
  if (value == null && def.valueFrom) {
    if (def.valueFrom === '$durationMin') value = ended != null ? Math.round(((ended - at) / 60_000) * 10) / 10 : null;
    else {
      const v = data[def.valueFrom];
      value = typeof v === 'number' ? v : null;
    }
  }
  if (value == null && def.name === 'habit.check') value = data.done === false ? 0 : 1;
  const numeric = def.kind === 'metric' || def.aggregate != null;
  if (def.kind === 'metric' && value == null) return { ok: false, error: `${def.name} 需要 value` };

  let unit: string | null = input.unit ?? null;
  if (def.unitField) {
    const u = data[def.unitField];
    unit = typeof u === 'string' ? u.toUpperCase() : unit;
  } else if (numeric) unit = unit ?? def.unit ?? null;
  if (unit != null && (typeof unit !== 'string' || unit.length > 16)) return { ok: false, error: 'unit 不合法' };

  const tz = input.tz ?? 'UTC';
  if (typeof tz !== 'string' || !isValidTz(tz)) return { ok: false, error: `时区不认识: ${String(tz)}` };

  const privacy = input.privacy ?? def.privacy;
  if (!(privacy in PRIVACY_RANK)) return { ok: false, error: 'privacy 只能是 normal / private / sensitive' };

  const confidence = input.confidence ?? 1;
  if (typeof confidence !== 'number' || !(confidence > 0 && confidence <= 1)) return { ok: false, error: 'confidence 应在 (0, 1]' };

  const refs = cleanRefs(input.refs);
  if (typeof refs === 'string') return { ok: false, error: refs };
  const tags = cleanTags(input.tags);
  if (typeof tags === 'string') return { ok: false, error: tags };

  const supersedes = input.supersedes ?? null;
  if (supersedes != null && (typeof supersedes !== 'string' || !ULID_RE.test(supersedes) || supersedes === input.id)) {
    return { ok: false, error: 'supersedes 应为另一条记录的 id' };
  }

  const source = input.source ?? opts.defaultSource ?? 'user';
  if (typeof source !== 'string' || !source || source.length > LIMITS.sourceMax) return { ok: false, error: 'source 不合法' };

  const base = { data, value, unit };
  const sensitiveNumeric = def.privacy === 'sensitive' && (def.kind === 'metric' || def.aggregate != null);
  let title = !sensitiveNumeric && typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim() : '';
  if (!title) title = autoTitle(def, base);
  if (title.length > LIMITS.titleMax) title = title.slice(0, LIMITS.titleMax - 1) + '…';

  return {
    ok: true,
    def,
    record: {
      id: input.id, type: typeKey(def), domain: def.domain,
      occurred_at: at, ended_at: ended, tz, source, confidence,
      privacy: morePrivate(privacy, def.privacy),
      title, data, value, unit,
      refs, tags, supersedes,
    },
  };
}

/** 指标投影用的指标名: 'finance.expense:CNY' / 'habit.check:跑步' / 'health.weight' */
export function metricKeyOf(def: TypeDef, rec: Pick<PilotRecord, 'data'>): string {
  if (!def.metricBy) return def.name;
  const v = rec.data[def.metricBy];
  const s = typeof v === 'string' ? (def.metricBy === 'currency' ? v.toUpperCase() : v.trim()) : '';
  return s ? `${def.name}:${s}` : def.name;
}

/** 插件 / 用户注册新类型时的检查: 名字合法、不占内置名、字段规格合法 */
export function validateTypeDef(def: TypeDef, opts: { resolveBuiltin?: TypeResolver } = {}): string | null {
  const builtin = opts.resolveBuiltin ?? builtinResolver;
  if (!def || typeof def !== 'object') return '类型定义应为对象';
  if (!TYPE_NAME_RE.test(def.name ?? '')) return `类型名不合法: ${def.name}`;
  if (builtin(def.name, null)) return `${def.name} 是内置类型, 不能覆盖`;
  if (!Number.isInteger(def.version) || def.version < 1 || def.version > 9999) return 'version 应为 1-9999 的整数';
  if (!['work', 'life', 'health', 'finance', 'social', 'learning', 'place', 'media', 'system'].includes(def.domain)) return 'domain 不合法';
  if (!(def.privacy in PRIVACY_RANK)) return 'privacy 不合法';
  if (!['point', 'interval', 'metric', 'note', 'fact'].includes(def.kind)) return 'kind 不合法';
  if (def.aggregate && !['sum', 'avg', 'last', 'max', 'min'].includes(def.aggregate)) return 'aggregate 不合法';
  if (def.kind === 'metric' && !def.aggregate) return 'metric 类型要给 aggregate';
  if (!def.fields || typeof def.fields !== 'object') return 'fields 应为对象';
  if (Object.keys(def.fields).length > 64) return '字段最多 64 个';
  const types = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'any'];
  for (const [k, f] of Object.entries(def.fields)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) return `字段名不合法: ${k}`;
    if (!types.includes(f?.type)) return `字段 ${k} 的 type 不合法`;
  }
  if (!def.label?.zh || !def.label?.en) return 'label 要有中英文';
  if (!def.owner || def.owner.length > 120) return 'owner 不合法';
  return null;
}
