
const BLOB_KEYS = new Set([
  'contents', 'content', 'body', 'html', 'code', 'text', 'source',
  'prompt', 'old_string', 'new_string', 'oldString', 'newString',
  'diff', 'patch', 'input', 'data',
]);

const PRIMARY_KEYS = [
  'file_path', 'filePath', 'path', 'command', 'query', 'pattern',
  'url', 'target', 'title', 'name',
];

function looksLikeFsPath(v: string): boolean {
  if (v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v)) return true;
  if (v.includes('\\')) return true;
  if (v.includes('<') || v.includes('>')) return false;
  return /\/[^/\s]+\.\w{1,8}$/.test(v);
}

function shortenPath(v: string): string {
  const segs = v.split(/[/\\]/).filter(Boolean);
  if (segs.length <= 2) return v;
  return `…/${segs.slice(-2).join('/')}`;
}

function clip(v: string, max: number): string {
  const one = v.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return `${one.slice(0, Math.max(0, max - 1))}…`;
}

function displayValue(v: unknown): string {
  if (typeof v === 'string') {
    if (v.length > 32 && looksLikeFsPath(v)) return shortenPath(v);
    return clip(v, 32);
  }
  if (Array.isArray(v)) return `[${v.length}]`;
  if (v === null) return 'null';
  if (typeof v === 'object') return '{…}';
  return String(v);
}

/** 把工具 args (JSON 字符串或已 parse 的对象) 收成一行人话摘要. */
export function formatCompactToolArgs(raw?: string | Record<string, unknown> | null): string {
  if (raw == null || raw === '') return '';
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return clip(raw, 60);
    }
  }
  if (typeof obj !== 'object' || obj === null) return clip(String(obj), 60);
  const rec = obj as Record<string, unknown>;

  for (const k of PRIMARY_KEYS) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim()) {
      return displayValue(v);
    }
  }

  const parts: string[] = [];
  for (const [k, v] of Object.entries(rec)) {
    if (BLOB_KEYS.has(k)) continue;
    parts.push(`${k}: ${displayValue(v)}`);
    if (parts.length >= 3) break;
  }
  return clip(parts.join('  '), 80);
}
