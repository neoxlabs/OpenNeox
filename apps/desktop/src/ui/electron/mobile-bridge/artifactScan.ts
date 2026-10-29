/**
 * artifactScan.ts — 从 tool_result 里把「agent 刚做出来的文件」的路径抠出来.
 *
 * 数据来源是现成的, 不用改 runtime: 产物类工具本来就在结果里报路径, 例如
 *   deck_export → {"ok":true,"path":"/Users/…/汇报.pptx","previewPath":"…/preview.html", …}
 *
 * 判定是**尽力而为**的, 有意保守:
 *   - 只认结构化 JSON 里那几个明确表示"产出物"的字段名, 不做全文正则捞路径。
 *     满屏 grep 结果里随便一个 .png 被当成产物推给用户, 比漏掉更烦人;
 *   - 再叠一层扩展名白名单 (looksLikeArtifact) 和路径根校验 (registerArtifact),
 *     两道都过了才登记。
 * 漏判的代价是"这个文件没出现下载卡", 误判的代价是"手机上刷出一堆垃圾卡" ——
 * 前者可以后面按需补字段, 后者会直接毁掉这个功能的观感。
 */

/** 明确表示"我产出了这个文件"的字段名 */
const OUTPUT_KEYS = new Set([
  'path',
  'filepath',
  'file_path',
  'outputpath',
  'output_path',
  'output',
  'outfile',
  'out_file',
  'savedto',
  'saved_to',
  'exportpath',
  'export_path',
  'previewpath',
  'preview_path',
  'artifact',
  'artifactpath',
  'artifact_path',
]);

/** 明确不是产物的字段 — 输入/源文件, 登记了等于把用户自己给的东西又推回去 */
const INPUT_KEYS = new Set([
  'sourcepath', 'source_path', 'inputpath', 'input_path', 'src', 'source', 'cwd', 'dir', 'directory',
]);

const MAX_DEPTH = 6;
const MAX_HITS = 12;

function looksAbsolute(v: string): boolean {
  return v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v);
}

function walk(node: unknown, depth: number, out: Set<string>): void {
  if (depth > MAX_DEPTH || out.size >= MAX_HITS) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, depth + 1, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [rawKey, value] of Object.entries(node as Record<string, unknown>)) {
    const key = rawKey.toLowerCase();
    if (typeof value === 'string') {
      if (INPUT_KEYS.has(key)) continue;
      if (!OUTPUT_KEYS.has(key)) continue;
      if (!looksAbsolute(value)) continue;
      out.add(value);
      if (out.size >= MAX_HITS) return;
    } else {
      walk(value, depth + 1, out);
    }
  }
}

/**
 * 从一段 tool 输出里抠出候选产物路径.
 *
 * [output] 通常是 JSON 字符串; 不是 JSON 就直接返回空 —— 我们不在自由文本里
 * 正则捞路径 (execute_shell 的 `ls` 输出会捞出一堆压根不是产物的东西)。
 */
export function scanArtifactPaths(output: unknown): string[] {
  if (typeof output !== 'string') {
    const out = new Set<string>();
    walk(output, 0, out);
    return [...out];
  }
  const trimmed = output.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const out = new Set<string>();
  walk(parsed, 0, out);
  return [...out];
}
