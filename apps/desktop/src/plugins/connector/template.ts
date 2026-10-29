/**
 * 声明式 connector 的模板插值
 *
 *   清单里的 `{{input.fileKey}}` / `{{connection.cloudId}}` 在这里被求值。
 *
 *   两条不能含糊的语义
 *   ------------------
 *
 *   1. **整串占位符要还原原始类型, 不能字符串化**
 *
 *      Notion 的 `children: '{{input.blocks}}'` 期望的是一个**数组**。
 *      如果按普通字符串插值处理, 会得到 `"[object Object],[object Object]"`,
 *      请求直接 400 —— 而且是那种看着像平台问题、其实是我们拍扁了类型的
 *      难查故障。
 *
 *      所以: 整串恰好是一个占位符时返回原值 (数组仍是数组), 只有混在文本里
 *      时才做字符串拼接。
 *
 *   2. **取不到值不等于空字符串**
 *
 *      `{{input.depth}}` 没传时, 正确行为是**不发这个 query 参数**, 而不是
 *      发 `depth=undefined`。两者在很多平台上语义完全不同 (后者常被当成
 *      非法值拒绝)。
 *
 *      所以取不到时返回 MISSING 哨兵, 由调用方按位置决定:
 *        · path  —— 抛错 (路径参数是必需的)
 *        · query —— 丢掉这个参数
 *        · body  —— 丢掉这个键
 */

/** 取不到值的哨兵。区别于 undefined —— 后者可能是用户显式传的。 */
export const MISSING = Symbol('missing');
export type Missing = typeof MISSING;

export type TemplateScope = {
  input?: Record<string, unknown>;
  connection?: Record<string, unknown>;
};

/** 只允许这两个作用域 —— 不给清单触达进程 env 之类东西的口子 */
const ALLOWED_SCOPES = new Set(['input', 'connection']);

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
const WHOLE_PLACEHOLDER = /^\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}$/;

/** 按点路径取值, 任一段缺失即 MISSING */
function resolvePath(scope: TemplateScope, path: string): unknown | Missing {
  const segments = path.split('.');
  const head = segments.shift();
  if (!head || !ALLOWED_SCOPES.has(head)) return MISSING;

  let cur: unknown = (scope as Record<string, unknown>)[head];
  for (const seg of segments) {
    if (cur === null || cur === undefined) return MISSING;
    if (typeof cur !== 'object') return MISSING;
    /* 挡住 __proto__ / constructor 这类原型链取值 */
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return MISSING;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur === undefined ? MISSING : cur;
}

/**
 * 求值一个字符串模板。
 *
 *   整串占位符 → 原始值 (可能是数组/对象/数字)
 *   混合文本   → 字符串拼接; 任一占位符缺失则整体 MISSING
 *   无占位符   → 原样返回
 */
export function interpolateString(
  template: string,
  scope: TemplateScope,
): unknown | Missing {
  const whole = WHOLE_PLACEHOLDER.exec(template);
  if (whole) return resolvePath(scope, whole[1]);

  if (!template.includes('{{')) return template;

  let missing = false;
  const out = template.replace(PLACEHOLDER, (_m, path: string) => {
    const v = resolvePath(scope, path);
    if (v === MISSING) { missing = true; return ''; }
    /* 混合文本里只接受标量 —— 把对象塞进 URL 片段没有正确答案 */
    if (v === null || typeof v === 'object') { missing = true; return ''; }
    return String(v);
  });

  return missing ? MISSING : out;
}

/**
 * 深度求值 body。
 *
 *   对象里值为 MISSING 的键会被**删掉**而不是置 null —— 见文件头语义 2。
 *   数组里的 MISSING 元素同样剔除, 否则会留下空洞。
 */
export function interpolateValue(value: unknown, scope: TemplateScope): unknown | Missing {
  if (typeof value === 'string') return interpolateString(value, scope);

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const r = interpolateValue(item, scope);
      if (r !== MISSING) out.push(r);
    }
    return out;
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = interpolateValue(v, scope);
      if (r !== MISSING) out[k] = r;
    }
    return out;
  }

  return value;
}

/**
 * 求值路径片段。
 *
 *   与其它位置的关键差别: 值要 URL 编码。不编码的话 fileKey 传 `a/../../b`
 *   就能改写请求路径 —— 用户可控输入直接改我们发出去的请求, 是典型的
 *   路径穿越。
 */
export function interpolatePath(template: string, scope: TemplateScope): string {
  let missingPath: string | null = null;

  const out = template.replace(PLACEHOLDER, (_m, path: string) => {
    const v = resolvePath(scope, path);
    if (v === MISSING || v === null || typeof v === 'object') {
      missingPath = path;
      return '';
    }
    return encodeURIComponent(String(v));
  });

  if (missingPath) {
    throw new Error(`missing required path parameter: {{${missingPath}}}`);
  }
  return out;
}

/** 求值 query, 取不到的键直接丢弃 */
export function interpolateQuery(
  template: Record<string, string> | undefined,
  scope: TemplateScope,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!template) return out;

  for (const [key, raw] of Object.entries(template)) {
    const v = interpolateString(raw, scope);
    if (v === MISSING || v === null || v === undefined) continue;
    if (typeof v === 'object') continue;
    out[key] = String(v);
  }
  return out;
}
