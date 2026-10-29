
type Json = Record<string, any>;

const MAX_DEPTH = 12;

function lookup(root: Json, ref: string): Json | undefined {
  if (!ref.startsWith('#')) return undefined;
  if (ref === '#') return root;
  const parts = ref.slice(2).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur: any = root;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur && typeof cur === 'object' ? cur : undefined;
}

/** 返回一份不含 `$ref` / `$defs` / `definitions` 的 schema (不改入参) */
export function inlineSchemaRefs(schema: Json): Json {
  const root = schema;
  const walk = (node: any, seen: string[], depth: number): any => {
    if (Array.isArray(node)) return node.map((x) => walk(x, seen, depth));
    if (!node || typeof node !== 'object') return node;
    if (typeof node.$ref === 'string') {
      const ref = node.$ref as string;
      const target = lookup(root, ref);
      const { $ref: _drop, ...siblings } = node;
      /* 找不到 / 循环 / 太深: 换成不带约束的 {} (保留同级的 description 等) */
      if (!target || seen.includes(ref) || depth > MAX_DEPTH) return walk(siblings, seen, depth);
      const resolved = walk(target, [...seen, ref], depth + 1);
      return { ...resolved, ...walk(siblings, seen, depth) };
    }
    const out: Json = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$defs' || k === 'definitions') continue;
      out[k] = walk(v, seen, depth + 1);
    }
    return out;
  };
  return walk(schema, [], 0);
}
