
export interface DataRecord {
  title: string;
  /** 工单编号 (ENG-12 / PROJ-3 / #128), 排在标题前 */
  ref?: string;
  /** 时间 (已格式化, 保留数据自己的时区, 不做换算) */
  when?: string;
  /** 状态 (confirmed / open / done …) */
  status?: string;
  /** 能点开的原始链接 (http/https) */
  link?: string;
}

export interface DataResult {
  records?: DataRecord[];
  total?: number;
  fields?: Array<{ k: string; v: string }>;
  raw: string;
}

const MAX_RECORDS = 8;
const MAX_FIELDS = 8;

const TITLE_KEYS = ['summary', 'title', 'name', 'subject', 'displayName', 'display_name', 'full_name', 'fullName', 'label', 'text', 'message', 'key', 'login', 'email'];
const TIME_KEYS = ['start', 'due', 'due_date', 'dueDate', 'due_on', 'date', 'datetime', 'dateTime', 'time', 'timestamp', 'created_at', 'createdAt', 'created', 'updated_at', 'updatedAt', 'updated', 'last_edited_time'];
const STATUS_KEYS = ['status', 'state'];
const LINK_KEYS = ['htmlLink', 'html_url', 'web_url', 'webViewLink', 'permalink', 'url', 'link', 'href'];
/* 对象里有好几个数组时, 这些名字优先当"主列表" */
const LIST_KEYS = ['items', 'events', 'results', 'data', 'records', 'value', 'issues', 'messages', 'files', 'entries', 'list', 'nodes', 'rows'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function formatTime(v: string): string {
  const m = v.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  if (m) return `${m[1]} ${m[2]}`;
  const d = v.match(/^\d{4}-\d{2}-\d{2}$/);
  if (d) return v;
  return v;
}

/** 时间值可能是字符串, 也可能是 { dateTime } / { date } (Google / Outlook 的写法) */
function timeOf(v: unknown): string | undefined {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v;
  if (typeof v === 'number' && v > 1e11) return new Date(v).toISOString();
  if (isObj(v)) return str(v.dateTime) ?? str(v.date_time) ?? str(v.date);
  return undefined;
}

function whenOf(o: Obj): string | undefined {
  for (const k of TIME_KEYS) {
    const start = timeOf(o[k]);
    if (!start) continue;
    if (k === 'start') {
      const end = timeOf(o.end);
      if (end && end !== start) {
        const a = formatTime(start);
        const b = formatTime(end);
        if (a.length === 16 && b.length === 16 && a.slice(0, 10) === b.slice(0, 10)) return `${a}–${b.slice(11)}`;
      }
    }
    return formatTime(start);
  }
  return undefined;
}

function linkOf(o: Obj): string | undefined {
  for (const k of LINK_KEYS) {
    const v = str(o[k]);
    if (v && /^https?:\/\//i.test(v)) return v;
  }
  return undefined;
}

/** Notion 富文本数组 [{ plain_text }] → 拼成一行 */
function richText(v: unknown): string | undefined {
  if (!Array.isArray(v)) return undefined;
  return str(v.map((t) => (isObj(t) ? str(t.plain_text) ?? '' : '')).join(''));
}

function notionTitleOf(o: Obj): string | undefined {
  if (o.object === 'page' && isObj(o.properties)) {
    for (const p of Object.values(o.properties)) {
      if (isObj(p) && p.type === 'title') return richText(p.title);
    }
  }
  if (o.object === 'database') return richText(o.title);
  if (o.object === 'block' && typeof o.type === 'string' && isObj(o[o.type])) {
    const body = o[o.type] as Obj;
    /* 空段落 / 分割线没有文字, 给 UUID 不如给占位 */
    return richText(body.rich_text) ?? str(body.title) ?? '—';
  }
  return undefined;
}

function titleOf(o: Obj): string | undefined {
  const notion = notionTitleOf(o);
  if (notion) return notion;
  for (const k of TITLE_KEYS) {
    const v = str(o[k]);
    if (v) return v;
  }
  return undefined;
}

/** 状态可能是字符串, 也可能是 { name } (Linear state / Jira status / GitHub 标签对象) */
function statusOf(o: Obj): string | undefined {
  for (const k of STATUS_KEYS) {
    const v = o[k];
    const s = str(v) ?? (isObj(v) ? str(v.name) ?? str(v.title) ?? str(v.label) : undefined);
    if (s && s.length <= 24) return s;
  }
  return undefined;
}

/** 工单编号: Linear identifier (ENG-12) / Jira key (PROJ-3) / Sentry shortId / GitHub number (#128) */
function refOf(o: Obj): string | undefined {
  const tag = str(o.identifier) ?? str(o.shortId) ?? str(o.short_id);
  if (tag) return tag;
  const key = str(o.key);
  if (key && /^[A-Z][A-Z0-9_]+-\d+$/.test(key)) return key;
  if (typeof o.number === 'number' && Number.isInteger(o.number)) return `#${o.number}`;
  return undefined;
}

function toRecord(v: unknown): DataRecord {
  if (!isObj(v)) return { title: str(v) ?? JSON.stringify(v) };
  /* Jira 把标题、状态、时间都放在 fields 里, 顶层只有 key / id —— 两层都看, fields 优先 */
  const inner = isObj(v.fields) ? v.fields : undefined;
  /* Notion 的块是一页的正文: 每行挂编辑时间是噪音 (同一页全是同一刻), 待办要看勾没勾 */
  if (v.object === 'block') {
    const todo = v.type === 'to_do' && isObj(v.to_do) ? v.to_do : undefined;
    return { title: titleOf(v) ?? '—', status: todo ? (todo.checked ? '☑' : '☐') : undefined };
  }
  const ref = refOf(v);
  const title = (inner && titleOf(inner)) ?? titleOf(ref === str(v.key) ? { ...v, key: undefined } : v) ?? str(v.id) ?? '—';
  return {
    title,
    ref: ref && ref !== title ? ref : undefined,
    when: (inner && whenOf(inner)) ?? whenOf(v),
    status: (inner && statusOf(inner)) ?? statusOf(v),
    link: linkOf(v),
  };
}

/** 对象里挑"主列表": 优先常见名字, 否则取最长的那个对象数组 */
function mainArray(o: Obj): { key: string; arr: unknown[] } | undefined {
  let best: { key: string; arr: unknown[] } | undefined;
  for (const [k, v] of Object.entries(o)) {
    if (!Array.isArray(v) || v.length === 0 || !v.every(isObj)) continue;
    if (LIST_KEYS.includes(k)) return { key: k, arr: v };
    if (!best || v.length > best.arr.length) best = { key: k, arr: v };
  }
  if (best) return best;
  /* 空列表也是结果 —— 「没有事件」要说出来, 不能退回键值把 items: [] 摊出来 */
  for (const k of LIST_KEYS) if (Array.isArray(o[k])) return { key: k, arr: o[k] as unknown[] };
  return undefined;
}

/** 顶层标量 (含一层嵌套, 写成 a.b), 数组 / 深层对象不展开 */
function scalarFields(o: Obj, skip?: string): Array<{ k: string; v: string }> {
  const out: Array<{ k: string; v: string }> = [];
  const push = (k: string, v: unknown) => {
    if (out.length >= MAX_FIELDS) return;
    const s = typeof v === 'boolean' ? String(v) : str(v);
    if (s === undefined) return;
    out.push({ k, v: s.length > 120 ? `${s.slice(0, 119)}…` : s });
  };
  for (const [k, v] of Object.entries(o)) {
    if (k === skip) continue;
    if (isObj(v)) {
      for (const [k2, v2] of Object.entries(v)) if (!isObj(v2) && !Array.isArray(v2)) push(`${k}.${k2}`, v2);
    } else if (!Array.isArray(v)) {
      push(k, v);
    }
  }
  return out;
}

export function parseDataResult(text: string): DataResult | undefined {
  const t = text.trim();
  if (!(t.startsWith('[') || t.startsWith('{'))) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(t); } catch { return undefined; }
  const raw = JSON.stringify(parsed, null, 2);

  if (Array.isArray(parsed)) {
    return { records: parsed.slice(0, MAX_RECORDS).map(toRecord), total: parsed.length, raw };
  }
  if (!isObj(parsed)) return undefined;

  const list = mainArray(parsed);
  if (list) {
    const fields = scalarFields(parsed, list.key);
    return {
      records: list.arr.slice(0, MAX_RECORDS).map(toRecord),
      total: list.arr.length,
      fields: fields.length ? fields : undefined,
      raw,
    };
  }
  /* 单个对象: 有标题 + (时间或链接) 就是一条记录 —— 比如刚建好的日历事件 */
  const title = titleOf(parsed);
  if (title && (whenOf(parsed) || linkOf(parsed))) {
    return { records: [toRecord(parsed)], total: 1, raw };
  }
  const fields = scalarFields(parsed);
  if (!fields.length) return undefined;
  return { fields, raw };
}
