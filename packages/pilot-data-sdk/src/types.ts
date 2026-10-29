/**
 * Pilot 数据层的数据模型 —— 设备、云端服务、agent 工具共用的一份定义。
 * 设计见 内部设计文档 §4。
 *
 * 本包零依赖: NeoxCloud 的 apps/pilot-data 把 src 原样拷过去编译 (apps/pilot-data/scripts/vendor-sdk.mjs),
 * 所以这里不许 import 任何三方包或仓内其它包。
 */

export type Domain = 'work' | 'life' | 'health' | 'finance' | 'social' | 'learning' | 'place' | 'media' | 'system';
export type Privacy = 'normal' | 'private' | 'sensitive';

/** point 瞬时事件 / interval 有起止 / metric 数值 (进指标投影) / note 自由文本 / fact 关于这个人的事实 (进档案) */
export type TypeKind = 'point' | 'interval' | 'metric' | 'note' | 'fact';
export type Aggregate = 'sum' | 'avg' | 'last' | 'max' | 'min';

export type FieldSpec = {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'any';
  required?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  enum?: readonly (string | number)[];
  items?: FieldSpec;
};

export type TypeDef = {
  /** 不带版本的名字: 'health.weight' */
  name: string;
  version: number;
  domain: Domain;
  /** 默认隐私档; 写入时只能往高调, 不能往低调 */
  privacy: Privacy;
  kind: TypeKind;
  /** 数值型的单位; 带 unitField 时以数据里的为准 (如币种) */
  unit?: string;
  unitField?: string;
  /** 数值型: 指标投影按天聚合方式 */
  aggregate?: Aggregate;
  /** 数值型: value 缺省时从 data 的哪个字段取; interval 型可写 '$durationMin' 表示按起止算分钟 */
  valueFrom?: string;
  /** 指标按某字段再细分 (如 habit.check 按 habit 分成多条指标) */
  metricBy?: string;
  /** interval 型必须带 ended_at */
  fields: Record<string, FieldSpec>;
  /** 没给 title 时的人话模板: {value} {unit} {字段名} */
  title?: string;
  label: { zh: string; en: string };
  /** core | plugin:<id> | user */
  owner: string;
  /** 允许 occurred_at 在将来 (日程 / 待办): 不设 = 只容一天时差 */
  future?: boolean;
};

/** 写入时客户端给的 (服务端补 recorded_at / user_id) */
export type RecordInput = {
  id: string;
  /** 'health.weight@1'; 不带版本 = 最新版本 */
  type: string;
  occurred_at: number;
  ended_at?: number | null;
  tz?: string;
  source?: string;
  confidence?: number;
  privacy?: Privacy;
  title?: string;
  data?: Record<string, unknown>;
  value?: number | null;
  unit?: string | null;
  refs?: RecordRef[];
  tags?: string[];
  supersedes?: string | null;
};

export type RecordRef = { kind: 'entity' | 'blob' | 'record' | 'doc'; id: string };

/** 校验 + 补全之后的一条记录 (服务端落库就是这个形状) */
export type PilotRecord = {
  id: string;
  type: string;
  domain: Domain;
  occurred_at: number;
  ended_at: number | null;
  tz: string;
  source: string;
  confidence: number;
  privacy: Privacy;
  title: string;
  data: Record<string, unknown>;
  value: number | null;
  unit: string | null;
  refs: RecordRef[];
  tags: string[];
  supersedes: string | null;
};

export type StoredRecord = PilotRecord & { recorded_at: number; deleted_at: number | null };

/** 批量写入每条的结果 —— 按条隔离, 一条坏不影响整批 */
export type PutResult = { id: string; status: 'ok' | 'dup' | 'invalid'; error?: string };

export type QueryParams = {
  types?: string[];
  domains?: Domain[];
  from?: number;
  to?: number;
  tags?: string[];
  /** 关键词 (标题 + 正文全文) */
  q?: string;
  /** 默认不含 sensitive; 要读敏感数据得显式要 (并且令牌有权) */
  includeSensitive?: boolean;
  /** 被更正 / 删除的默认不返回 */
  includeSuperseded?: boolean;
  limit?: number;
  /** 翻页: 上一页最后一条的 occurred_at + id */
  before?: { occurred_at: number; id: string };
};

export type SyncChange = { seq: number; op: 'put' | 'del'; record_id: string; type: string; domain: Domain; at: number; record?: StoredRecord };
export type SyncPage = { changes: SyncChange[]; cursor: number; more: boolean };

export type MetricPoint = { day: string; n: number; value: number; min: number | null; max: number | null; unit: string | null };
export type MetricSeries = { metric: string; aggregate: Aggregate; points: MetricPoint[] };

export type Fact = { key: string; value: unknown; record_id: string; confidence: number; privacy: Privacy; valid_from: number; updated_at: number };
