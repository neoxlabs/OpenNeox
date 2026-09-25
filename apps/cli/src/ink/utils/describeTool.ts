
export type ToolCategory = 'read' | 'search' | 'list' | 'web' | 'fetch' | 'tools' | 'other';

export interface ToolDescription {
  verb: string;
  /** 括号里的目标: 路径 / 模式 / 查询; 可能为空 */
  target: string;
  /** ⎿ 后的一句结果: "12 lines" / "5 matches"; 可能为空 */
  result: string;
  category: ToolCategory;
  failed: boolean;
  /** 这一次调用算几个 (一次读 3 个文件 = 3), 聚合标题 "Read N files" 按它数; 缺省 1 */
  units?: number;
}

/** 从 `k="v", k2=v2` 串里取字段 */
function field(text: string, key: string): string | undefined {
  const q = new RegExp(`(?:^|[\\s,])${key}="((?:[^"\\\\]|\\\\.)*)"`).exec(text);
  if (q) return q[1];
  const b = new RegExp(`(?:^|[\\s,])${key}=([^,\\s]+)`).exec(text);
  return b ? b[1] : undefined;
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export function describeTool(type: string, text = '', details = ''): ToolDescription {
  const t = text.trim();
  const failed = /✗\s*ERROR/.test(t);
  switch (type) {
    case 'readfile': {
      /* "src/a.ts — 94 lines read" | "src/a.ts" | "a.ts, b.md" (一次读多个) | "a.ts, ✗ ERROR" */
      if (failed) {
        const target = t.replace(/,\s*✗\s*ERROR$/, '');
        return { verb: 'Read', target, category: 'read', failed, result: 'failed', units: target.split(', ').length };
      }
      const m = /^(.*?)\s+—\s+(\d+)\s+lines?\s+read$/.exec(t);
      const target = m ? m[1]! : t;
      const units = target.split(', ').length;
      const lines = m ? Number(m[2]) : units > 1 ? NaN : Number((/(\d+)\s+lines?/.exec(details) || [])[1] || NaN);
      return {
        verb: 'Read', target, category: 'read', failed, units,
        result: Number.isFinite(lines) ? plural(lines, 'line') : '',
      };
    }
    case 'search': {
      const pat = field(t, 'pattern') ?? t;
      const path = field(t, 'path');
      const matches = field(t, 'matches');
      return {
        verb: 'Search', category: 'search', failed,
        target: `"${pat}"${path && path !== '.' ? ` in ${path}` : ''}`,
        result: failed ? 'failed' : matches !== undefined ? plural(Number(matches), 'match', 'matches') : '',
      };
    }
    case 'search_files': {
      const pat = field(t, 'pattern') ?? (t === 'Glob' ? '' : t);
      const path = field(t, 'path');
      const files = field(t, 'files');
      return {
        verb: 'Glob', category: 'search', failed,
        target: `${pat}${path && path !== '.' ? ` in ${path}` : ''}`,
        result: files !== undefined ? plural(Number(files), 'file') : '',
      };
    }
    case 'show_tree': {
      const path = field(t, 'path') ?? '.';
      return { verb: 'List', target: path, category: 'list', failed, result: failed ? 'failed' : '' };
    }
    case 'web_search': {
      const n = Number((/Found\s+(\d+)/.exec(details) || [])[1] || NaN);
      return { verb: 'Web Search', target: t, category: 'web', failed, result: Number.isFinite(n) ? plural(n, 'result') : '' };
    }
    case 'web_fetch':
      return { verb: 'Fetch', target: t, category: 'fetch', failed, result: details.trim() };
    case 'bash_output': {
      /* 结果是 JSON (pid/command/status/content…) —— 聚合组里原来整坨原文当一行显示 */
      const raw = [details.trim(), t].filter(s => s.startsWith('{'));
      for (const r of raw) try {
        const o = JSON.parse(r);
        if (o && typeof o === 'object') {
          const state = o.status === 'running' ? 'running'
            : `${o.status ?? 'done'}${o.exit_code !== undefined && o.exit_code !== null ? ` · exit ${o.exit_code}` : ''}`;
          return { verb: 'BashOutput', target: `BashOutput ${o.display_name || o.command || o.pid || ''}`.trim(), category: 'other', failed: failed || !!o.error, result: o.error ? String(o.error) : state };
        }
      } catch { /* 截断的 JSON: 走默认 */ }
      return { verb: '', target: t, category: 'other', failed, result: '' };
    }
    default: {
      const found = /^(\d+) tools found$/.exec(t);
      if (found) {
        const names = [...details.matchAll(/^([a-zA-Z0-9_][\w-]*):\s+/gm)].map(m => m[1]!);
        const n = Number(found[1]);
        return {
          verb: 'Load tools', category: 'tools', failed, units: n,
          target: names.length ? names.slice(0, 4).join(', ') + (names.length > 4 ? ` +${names.length - 4}` : '') : '',
          result: names.length ? '' : plural(n, 'tool'),
        };
      }
      return { verb: '', target: t, category: 'other', failed, result: '' };
    }
  }
}

/** 聚合组的标题: "Read 2 files, searched 3 patterns, listed 1 directory" */
export function describeGroup(items: Array<{ category: ToolCategory; count: number }>): string {
  const n: Record<ToolCategory, number> = { read: 0, search: 0, list: 0, web: 0, fetch: 0, tools: 0, other: 0 };
  for (const it of items) n[it.category] += it.count;
  const parts: string[] = [];
  if (n.read) parts.push(`read ${plural(n.read, 'file')}`);
  if (n.search) parts.push(`searched ${plural(n.search, 'pattern')}`);
  if (n.list) parts.push(`listed ${plural(n.list, 'directory', 'directories')}`);
  if (n.web) parts.push(`searched the web ${n.web === 1 ? 'once' : `${n.web} times`}`);
  if (n.fetch) parts.push(`fetched ${plural(n.fetch, 'page')}`);
  if (n.tools) parts.push(`loaded ${plural(n.tools, 'tool')}`);
  if (n.other) parts.push(`ran ${plural(n.other, 'tool')}`);
  const s = parts.join(', ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
