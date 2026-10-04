/**
 * Timeline 密度聚合 transform
 *
 * 渲染层处理:把连续的 tool-like entries 合并成一个 `tool_group` entry,
 * 原始 staticEntries 不变。medium / compact 两档的数据结构一样,差异
 * 只在 ToolGroupCard 的渲染 layout。
 *
 * 规则:
 *   full    → 原样返回(兼容老行为)
 *   medium  → 连续 tool-like entries 按 verb 分组,同 verb 下同 target 合并为 count
 *   compact → 结构同 medium,由 ToolGroupCard 决定单行徽章布局
 *
 * 边界条件:
 *   - 单个 tool-like entry(前后都是非 tool)不聚合,保持原样
 *   - 展开 id 集合里的 entry 不被聚合(单个撑开回 full 样式)
 *   - 非 tool-like entry(assistant / user / thinking / plan / task_agent_progress 等)
 *     作为分隔符,flush 上一批缓冲
 */
import type { TimelineEntry, TimelineDensity } from '../InkRuntime.js';

// tool-like type 集合 —— 与 ToolCard.tsx 的 TOOL_STYLES 同步
// 不用直接 import(避免 React component 依赖到 utils 层),这里维护一份只关心分组的小表
const TOOL_VERB_MAP: Record<string, { verb: string; color: string }> = {
  tool_call: { verb: 'Tool', color: 'yellow' },
  tool_result: { verb: 'Result', color: 'green' },
  tool_error: { verb: 'Error', color: 'red' },
  file_update: { verb: 'Edit', color: 'blue' },
  command_exec: { verb: 'Shell', color: 'yellow' },
  command_running: { verb: 'Shell', color: 'cyan' },
  code_exec: { verb: 'Code', color: 'yellow' },
  web_search: { verb: 'Search', color: 'cyan' },
  web_fetch: { verb: 'Fetch', color: 'cyan' },
  readfile: { verb: 'Read', color: 'cyan' },
  search: { verb: 'Grep', color: 'cyan' },
  search_files: { verb: 'Glob', color: 'cyan' },
  show_tree: { verb: 'Tree', color: 'cyan' },
  mcp_tool: { verb: 'MCP', color: 'magenta' },
  git_status: { verb: 'Git', color: 'green' },
  git_diff: { verb: 'Git', color: 'yellow' },
  git_log: { verb: 'Git', color: 'cyan' },
  git_commit: { verb: 'Git', color: 'green' },
  git_running: { verb: 'Git', color: 'cyan' },
  memory_read: { verb: 'Memory', color: 'cyan' },
  memory_write: { verb: 'Memory', color: 'green' },
  memory_running: { verb: 'Memory', color: 'cyan' },
  task_create: { verb: 'Task', color: 'blue' },
  task_update: { verb: 'Task', color: 'green' },
  task_list: { verb: 'Tasks', color: 'cyan' },
  task_get: { verb: 'Task', color: 'cyan' },
  task_stop: { verb: 'Task', color: 'red' },
  cron_create: { verb: 'Cron', color: 'magenta' },
  cron_delete: { verb: 'Cron', color: 'red' },
  cron_list: { verb: 'Cron', color: 'cyan' },
  bash_output: { verb: 'BashOut', color: 'cyan' },
  bash_kill: { verb: 'BashKill', color: 'red' },
};

export function isToolLikeType(type: string): boolean {
  return type in TOOL_VERB_MAP;
}

/** 永远单独渲染, 绝不被聚合的 entry types.
 *
 *  Why: 这些是 mutating + 有重要 detail (diff / 输出) 的工具调用, 折成一行
 *  "Edit foo.txt · foo.txt · ..." 用户看不到改了什么. ToolCard 单独渲染时
 *  自带 diff 视图, 用户能看清前后行. 桌面端 agent timeline 默认这样, CLI
 *  应对齐. 只读类 (Read/Grep/Tree/Search) 仍走聚合, 多个调用合并显示节省屏幕. */
const NEVER_AGGREGATE_TYPES = new Set([
  'file_update', // Edit / Write / delete_file / rename_file / create_directory
  'command_exec',
  'command_running',
]);

export function shouldNeverAggregate(type: string): boolean {
  return NEVER_AGGREGATE_TYPES.has(type);
}

/**
 * 从 entry.text 里提取"主要 target"(文件路径 / pattern preview)
 *
 * entry.text 常见格式(不同来源格式不统一,都要兼容):
 *   - "public/styles.css — 94 lines read"            → "public/styles.css"
 *   - "public/styles.css (L10, 100 lines)"           → "public/styles.css"
 *   - `"workspace-actions" in styles.css`            → 整串保留
 *   - `pattern="fn foo" path="src/a.rs" mode="content" engine="rg"` → `"fn foo" in src/a.rs`
 *   - "path/to/file"                                  → "path/to/file"
 */
function extractTarget(text: string | undefined, type: string): string {
  if (!text) return '';
  const t = text.trim();

  // 1) Grep/Search/web_search:优先识别 pattern="..." path="..." 格式
  if (type === 'search' || type === 'search_files' || type === 'web_search' || type === 'web_fetch') {
    const patMatch = t.match(/pattern="((?:[^"\\]|\\.)*)"/);
    const pathMatch = t.match(/path="((?:[^"\\]|\\.)*)"/);
    if (patMatch) {
      const pat = patMatch[1];
      if (pathMatch) {
        const pathSegs = pathMatch[1].split('/').filter(Boolean);
        const shortPath = pathSegs.length > 2 ? pathSegs.slice(-2).join('/') : pathMatch[1];
        return `"${pat}" in ${shortPath}`;
      }
      return `"${pat}"`;
    }
    // 已经是 "xxx" in yyy 格式(另一套 buildSummary 输出)
    if (t.startsWith('"')) return t;
  }

  // 2) 其他以 " 开头的 pattern 短语
  if (t.startsWith('"')) return t;

  // 3) Read/Edit/Write 类:` — ` 切分(ToolCard buildSummary 格式)
  const emIdx = t.indexOf(' — ');
  if (emIdx > 0) return t.slice(0, emIdx).trim();

  // 4) `foo.ts (L10, 100 lines)` 切分
  const parenIdx = t.indexOf(' (');
  if (parenIdx > 0) return t.slice(0, parenIdx).trim();

  return t;
}

export interface AggregatedItem {
  target: string;
  rawText: string;
  details?: string;
  count: number;
  originalType: string;
  originalEntryId: number;
}

export interface AggregatedGroup {
  verb: string;
  color: string;
  items: AggregatedItem[];
}

function buildGroups(entries: TimelineEntry[]): AggregatedGroup[] {
  const byVerb = new Map<string, AggregatedGroup>();
  for (const e of entries) {
    const meta = TOOL_VERB_MAP[e.type];
    if (!meta) continue;
    if (!byVerb.has(meta.verb)) {
      byVerb.set(meta.verb, { verb: meta.verb, color: meta.color, items: [] });
    }
    const group = byVerb.get(meta.verb)!;
    const target = extractTarget(e.text, e.type);
    // 同 verb + 同 target → 合并 count
    const existing = group.items.find(it => it.target === target);
    if (existing) {
      existing.count += 1;
    } else {
      group.items.push({
        target,
        rawText: e.text || '',
        details: e.details,
        count: 1,
        originalType: e.type,
        originalEntryId: e.id,
      });
    }
  }
  return Array.from(byVerb.values());
}

/**
 * 主 transform 函数
 */
export function aggregateToolCalls(
  entries: TimelineEntry[],
  density: TimelineDensity,
  expandedIds: Set<number>,
): TimelineEntry[] {
  if (density === 'full') return entries;

  const out: TimelineEntry[] = [];
  let buffer: TimelineEntry[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    // 单个 tool-like 不值得聚合(合并只有 1 项看起来更丑),保持原样
    if (buffer.length === 1) {
      out.push(buffer[0]);
      buffer = [];
      return;
    }
    const groups = buildGroups(buffer);
    // 如果合并后只有 1 组 1 项 count=1,也不值得聚合
    if (groups.length === 1 && groups[0].items.length === 1 && groups[0].items[0].count === 1) {
      out.push(...buffer);
      buffer = [];
      return;
    }
    // 第一个 entry 的 id 继承给 group,保证 commitPendingEntry 的按 id 排序一致
    const firstEntry = buffer[0];
    out.push({
      id: firstEntry.id,
      type: 'tool_group',
      timestamp: firstEntry.timestamp,
      isComplete: true,
      toolGroup: {
        groups,
        originalIds: buffer.map(e => e.id),
        totalCount: buffer.length,
      },
    } as TimelineEntry);
    buffer = [];
  };

  for (const e of entries) {
    if (expandedIds.has(e.id)) {
      // 用户展开了这个 entry —— 它单独渲染为原始 ToolCard,不参与聚合
      flush();
      out.push(e);
      continue;
    }
    if (shouldNeverAggregate(e.type)) {
      /* Edit / Write 等 mutating tool: 单独渲染 ToolCard 才能展示 diff. 见 NEVER_AGGREGATE_TYPES. */
      flush();
      out.push(e);
      continue;
    }
    if (isToolLikeType(e.type)) {
      buffer.push(e);
    } else {
      flush();
      out.push(e);
    }
  }
  flush();

  return out;
}
