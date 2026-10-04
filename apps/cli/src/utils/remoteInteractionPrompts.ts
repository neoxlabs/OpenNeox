import type { SelectionChoice } from '../cliTypes.js';
import { getLanguage } from '../i18n/index.js';

type RemoteApprovalRisk = {
  level?: string;
  summary?: string;
};

/* Approval cards preview relevant argument values, such as the target path or command. */
const PRIMARY_ARG_KEYS = [
  'file_path', 'path', 'notebook_path', 'filePath',
  'command', 'cmd', 'script',
  'url', 'pattern', 'query',
];

function shortenArgValue(value: unknown): string {
  if (typeof value !== 'string') return '';
  let v = value.trim().replace(/\s+/g, ' ');
  if (!v) return '';

  /* 模型习惯在命令前挂一段 `cd <工作区绝对路径> && `。那是样板, 不是用户要审的东西 ——
   * 不剥掉的话 60 字的额度全被路径吃光, 审批卡变成
   *     Allow tool execute_shell cd /private/tmp/claude-501/-Users-…?
   * 真正要判断该不该放行的命令一个字都看不到。 */
  v = v.replace(/^cd\s+(?:'[^']*'|"[^"]*"|\S+)\s*&&\s*/, '');

  /* 绝对路径先收成工作区相对 ——  截图复盘: 命令那半修了, 路径这半没修,
   * 于是模型传绝对路径时卡片变成
   *     允许改文件 /private/tmp/agent-session-project/f2f… ?
   * 60 字额度又被前缀吃光, 文件名一个字看不见。截断要保尾。 */
  if (v.startsWith('/')) {
    const cwd = process.cwd();
    if (v === cwd) v = '.';
    else if (v.startsWith(`${cwd}/`)) v = v.slice(cwd.length + 1);
    else {
      const parts = v.split('/').filter(Boolean);
      if (parts.length > 2) v = `…/${parts.slice(-2).join('/')}`;
    }
  }

  return v.length > 60 ? `${v.slice(0, 57)}…` : v;
}

export function buildRemoteApprovalArgsPreview(args?: Record<string, unknown>): string {
  const resolvedArgs = args && typeof args === 'object' ? args : {};
  for (const key of PRIMARY_ARG_KEYS) {
    if (!(key in resolvedArgs)) continue;
    const shown = shortenArgValue(resolvedArgs[key]);
    if (shown) return ` ${shown}`;
  }
  return '';
}

/** 内部工具名 → 用户能懂的动作。表里没有的就回落到原名。 */
const TOOL_LABEL_ZH: Record<string, string> = {
  edit: '改文件',
  write_file: '写文件',
  read_file: '读文件',
  execute_shell: '执行命令',
  run_command: '执行命令',
  delete_file: '删文件',
  move_file: '移动/重命名文件',
  create_directory: '新建目录',
  git_commit: 'git 提交',
  web_fetch: '访问网页',
  web_search: '联网搜索',
};

function describeTool(toolName: string): string {
  if (getLanguage() !== 'zh') return toolName;
  return TOOL_LABEL_ZH[toolName] ?? toolName;
}

/** 审批卡标题: 「改文件 src/index.js ?」而不是「Allow tool edit (file_path, old_string...)?」 */
export function buildRemoteApprovalQuestion(toolName: string, argsPreview: string): string {
  const action = describeTool(toolName);
  if (getLanguage() !== 'zh') return `Allow ${toolName}${argsPreview}?`;
  return `允许${action}${argsPreview ? ` ${argsPreview.trim()}` : ''} ?`;
}

/** 审批卡的改动预览 —— 让用户在点"允许"之前**看得见要改什么**。
 *
 *    截图复盘: 卡片有标题(工具+路径)、三个选项、一行风险说明,
 *   唯独没有**改动本身**。用户被要求为一个看不见的改动放行, 而 event.args 里
 *   old_string / new_string / content 一直都在, 只是没人用。
 *   这里出一段紧凑预览 (最多 8 行), 长了截断并标明还有多少行。 */
export function buildApprovalPreview(args?: Record<string, unknown>): string[] {
  const a = args && typeof args === 'object' ? args : {};
  const str = (k: string): string => (typeof a[k] === 'string' ? (a[k] as string) : '');

  const oldStr = str('old_string');
  const newStr = str('new_string') || str('content') || str('new_content');
  if (!oldStr && !newStr) return [];

  let oldLines = oldStr ? oldStr.split('\n') : [];
  let newLines = newStr ? newStr.split('\n') : [];

  /* 只显示**真正变了**的行 ——  截图复盘: 原来整段旧的 + 整段新的堆上去,
   * 于是没改动的行以 "- xxx" 紧跟 "+ xxx" 的形式出现两遍, 噪声压过真正的改动。
   * 掐掉首尾公共行 (最朴素的 diff), 剩下的才是用户要看的。 */
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++;
  let tail = 0;
  while (
    tail < oldLines.length - head
    && tail < newLines.length - head
    && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) tail++;
  oldLines = oldLines.slice(head, oldLines.length - tail);
  newLines = newLines.slice(head, newLines.length - tail);

  const MAX = 8;
  const out: string[] = [];
  const push = (lines: string[], mark: string) => {
    for (const l of lines) {
      if (out.length >= MAX) return;
      out.push(`${mark} ${l.length > 96 ? `${l.slice(0, 95)}…` : l}`);
    }
  };

  push(oldLines, '-');
  push(newLines, '+');

  const total = oldLines.length + newLines.length;
  if (total > out.length) out.push(`  … 还有 ${total - out.length} 行`);
  return out;
}

export function buildRemoteApprovalChoices(
  toolName: string,
  allowRemember?: boolean
): SelectionChoice[] {
  /* Keep option labels and descriptions in the active language. */
  const zh = getLanguage() === 'zh';
  const choices: SelectionChoice[] = [
    /* 不再给"允许一次""拒绝"配描述 ——  截图复盘: 「允许一次」底下写
     * 「只允许这一次」、「拒绝」底下写「拒绝本次执行」, 是同义反复, 白占三行。
     * 只有"总是允许"需要一句解释(它有持久后果), 别的选项名本身已经说清楚了。
     * (卡片是回执不是文档 —— 字少一点, 真正该看的 diff 才浮得上来。) */
    { label: zh ? '允许一次' : 'Allow Once', value: 'allow_once' },
  ];
  if (allowRemember !== false) {
    choices.push({
      label: zh ? '总是允许' : 'Always Allow',
      value: 'always_allow',
      /* 用人话说这个工具是干什么的 —— `记住 execute_shell 的授权` 里的
       * execute_shell 是内部工具名, 对用户没有意义。 */
      description: `以后这类操作(${describeTool(toolName)})不再询问`,
    });
  }
  choices.push({ label: zh ? '拒绝' : 'Deny', value: 'deny' });
  return choices;
}

/* 审批卡的风险/原因文案在 neox-kernel 里, 是英文的 —— kernel 不该依赖 CLI 的 i18n,
 * 所以在**显示层**翻译。中文界面下审批卡原来长这样:
 *     风险: LOW (No obvious high-risk signals) · 原因: This will modify files (targeted edit or patch)
 * 标签是中文、内容是英文, 而这恰恰是最需要用户看懂的一行 —— 他要据此决定放不放行。
 * 表里没有的原样透传 (宁可英文, 不能瞎译)。 */
const RISK_TEXT_ZH: Record<string, string> = {
  'No obvious high-risk signals': '没有明显的高风险信号',
  'DELETE without WHERE clause': 'DELETE 没有 WHERE 条件',
  'UPDATE without WHERE clause': 'UPDATE 没有 WHERE 条件',
  'This will modify files (targeted edit or patch)': '会修改文件(定点编辑或打补丁)',
  'This will create or overwrite a file': '会新建或覆盖文件',
  'This will permanently delete files or directories': '会永久删除文件或目录',
  'This will rename or move files or directories': '会重命名或移动文件/目录',
  'This will create a directory': '会新建目录',
  'This will create a git commit': '会创建一个 git commit',
  'This will create or switch git branches': '会创建或切换 git 分支',
  'This will build a local code index': '会建立本地代码索引',
  'This will make a network request': '会发起网络请求',
  'This will make a network request to a provider endpoint': '会向供应商接口发起网络请求',
  'This will modify local Neox configuration': '会修改本机 Neox 配置',
  'This can expose local Neox configuration metadata': '可能暴露本机 Neox 配置信息',
  'This will add a local AI provider and store its API key': '会新增本机 provider 并保存它的 API key',
  'This will remove a local AI provider': '会删除一个本机 provider',
  'This will change the default local AI provider': '会更改默认 provider',
  'This will change the default model for a provider': '会更改该 provider 的默认模型',
  'This can add, remove, enable, or disable MCP servers': '会增删或启停 MCP server',
  'WARNING: running shell commands can modify your system': '注意: 执行 shell 命令可能改动你的系统',
  'WARNING: executing code can modify files or run external commands': '注意: 执行代码可能改文件或调用外部命令',
  'WARNING: running tests executes project code': '注意: 跑测试会执行项目代码',
  'WARNING: running lint executes project tools': '注意: 跑 lint 会执行项目工具链',
  'WARNING: running format executes project tools': '注意: 跑格式化会执行项目工具链',
};

function localizeRiskText(text: string): string {
  if (getLanguage() !== 'zh') return text;
  return RISK_TEXT_ZH[text.trim()] ?? text;
}

export function buildRemoteApprovalHints(
  reason?: string,
  scopeKey?: string,
  risk?: RemoteApprovalRisk,
): string[] {
  const riskLevel = typeof risk?.level === 'string' ? risk.level.toUpperCase() : '';
  const riskSummary = typeof risk?.summary === 'string' ? localizeRiskText(risk.summary) : '';
  const riskHint = riskLevel
    ? `风险: ${riskLevel}${riskSummary ? ` (${riskSummary})` : ''}`
    : '';

  /* scopeKey 多数时候就是内部会话 id (session_20260828_081642_6mul) —— 对用户零信息量,
   * 还长到把审批卡挤换行。只在它是**具名 agent** 时才显示。 */
  const isInternalScopeId = !scopeKey
    || /^session_/.test(scopeKey)
    || scopeKey === '__default__'
    || /^[0-9a-f-]{16,}$/i.test(scopeKey);

  return [
    riskHint,
    reason ? `原因: ${localizeRiskText(reason)}` : '',
    isInternalScopeId ? '' : `Agent: ${scopeKey}`,
  ].filter(Boolean);
}

export function normalizeRemoteAskOptions(
  options?: Array<{ label?: string; description?: string }>
): Array<{ label: string; description?: string }> {
  if (!Array.isArray(options)) {
    return [];
  }

  return options
    .map((opt) => ({
      label: (opt?.label || '').trim(),
      description: opt?.description,
    }))
    .filter((opt) => opt.label.length > 0);
}
