
const SERVER_LABEL: Record<string, [string, string]> = {
  filesystem: ['本地文件', 'Files'],
  playwright: ['Playwright', 'Playwright'],
  deepwiki: ['DeepWiki', 'DeepWiki'],
  context7: ['Context7', 'Context7'],
  'sequential-thinking': ['分步思考', 'Thinking'],
  sequential_thinking: ['分步思考', 'Thinking'],
  feishu: ['飞书', 'Feishu'],
  lark: ['飞书', 'Lark'],
  amap: ['高德地图', 'Amap'],
  github: ['GitHub', 'GitHub'],
  notion: ['Notion', 'Notion'],
  slack: ['Slack', 'Slack'],
  memory: ['记忆图谱', 'Memory'],
};

/* 常见工具动作 → 中文短语。认不出的把下划线换空格原样显示 */
const VERB_ZH: Array<[RegExp, string]> = [
  [/^ask_?(wiki_?)?question$/i, '问仓库'],
  [/^read_wiki_(structure|contents)$/i, '看仓库文档'],
  [/^read_(text_)?file$|^read_media_file$/i, '读文件'],
  [/^read_multiple_files$/i, '读多个文件'],
  [/^write_file$/i, '写文件'],
  [/^edit_file$/i, '改文件'],
  [/^(list_directory|list_directory_with_sizes|directory_tree)$/i, '看目录'],
  [/^search_files$/i, '找文件'],
  [/^create_directory$/i, '新建文件夹'],
  [/^move_file$/i, '移动文件'],
  [/^get_file_info$/i, '查文件信息'],
  [/^resolve[-_]library[-_]id$/i, '找库'],
  [/^(get[-_]library[-_]docs|query[-_]docs)$/i, '查文档'],
  [/^browser_navigate$/i, '打开网页'],
  [/^browser_take_screenshot$/i, '截图'],
  [/^browser_click$/i, '点击'],
  [/^browser_type$/i, '输入'],
  [/^browser_snapshot$/i, '读页面'],
  [/^browser_fill_form$/i, '填表'],
  [/^browser_close$/i, '关浏览器'],
  [/^browser_wait_for$/i, '等待'],
  [/^sequentialthinking$/i, '想一步'],
  [/^(search|search_.*)$/i, '搜索'],
  [/^create_issue$/i, '建 issue'],
  [/^(list|get)_issues?$/i, '查 issue'],
  [/^(maps_)?weather$/i, '查天气'],
  [/^maps_.*(direction|route).*$/i, '规划路线'],
  [/^maps_.*(search|around|geo).*$/i, '找地点'],
];

export function splitMcpName(raw: string): { server: string; tool: string } | null {
  const s = raw.replace(/^mcp__/i, '');
  const i = s.indexOf('__');
  if (i <= 0) return null;
  return { server: s.slice(0, i), tool: s.slice(i + 2) };
}

export function mcpServerLabel(server: string, zh: boolean): string {
  const hit = SERVER_LABEL[server.toLowerCase()];
  if (hit) return zh ? hit[0] : hit[1];
  return server.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export function mcpToolLabel(tool: string, zh: boolean): string {
  if (zh) {
    const hit = VERB_ZH.find(([re]) => re.test(tool));
    if (hit) return hit[1];
  }
  return tool.replace(/[-_]+/g, ' ');
}

/** 「deepwiki__ask_wiki_question」→「DeepWiki · 问仓库」; 不是 MCP 名原样返回 */
export function humanizeMcpName(raw: string, zh: boolean): string {
  const p = splitMcpName(raw);
  if (!p || !/^[a-z0-9][\w.-]*$/i.test(p.server)) return raw;
  return `${mcpServerLabel(p.server, zh)} · ${mcpToolLabel(p.tool, zh)}`;
}
