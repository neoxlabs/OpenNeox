
import type { PendingApproval } from '../../app/NeoxRuntimeContext';
import { summarizeComputerRun } from './computerRunSummary';
import { summarizeBrowserRun, summarizeGenericArgs } from './browserRunSummary';

/* isZh 是**必填**, 没有默认值 —— 默认成 true 就是"调用方没传时悄悄退化成中文",
 * 有条闸专门盯这个 (__tests__/noHardcodedLangDefault, 图像工坊整页永远中文就是这么来的)。
 * 抽模块时把原来的 `isZh = true` 一起搬了过来, 当场被那条闸抓住。 */
export function summarizeApprovalArgs(
  args: Record<string, unknown> | null | undefined,
  toolName: string | undefined,
  isZh: boolean,
): string {
  const a = (args ?? {}) as Record<string, unknown>;
  if (toolName === 'computer_run') {
    const s = summarizeComputerRun(a, isZh).line;
    if (s) return s;
  }
  const pick =
    (typeof a.command === 'string' && a.command) ||
    (typeof a.query === 'string' && a.query) ||
    (typeof a.pattern === 'string' && a.pattern) ||
    (typeof a.path === 'string' && a.path) ||
    (typeof a.file === 'string' && a.file) ||
    (typeof a.file_path === 'string' && a.file_path) ||
    (typeof a.filePath === 'string' && a.filePath) ||
    (typeof a.url === 'string' && a.url) ||
    (typeof a.code === 'string' && a.code) ||
    '';
  if (toolName === 'browser_run') {
    const s = summarizeBrowserRun(a, isZh).line;
    if (s) return s;
  }
  if (pick) return pick;
  return summarizeGenericArgs(a);
}

/** 展开层的逐条步骤 —— 有步骤概念的工具 (操作电脑 / 操作浏览器) 列步骤, 其余返回空走原文 */
export function approvalSteps(rawTool: string, args: Record<string, unknown>, isZh: boolean): string[] {
  if (rawTool === 'computer_run') return summarizeComputerRun(args, isZh).steps;
  if (rawTool === 'browser_run') return summarizeBrowserRun(args, isZh).steps;
  return [];
}

/** call_tool 透明化 — 跟 mapTimeline 同款: 露出内层工具名 + 内层 args, 别显裸 call_tool JSON. */
export function unwrapApprovalTool(
  request: PendingApproval,
  isZh: boolean,
): { toolName: string; rawName: string; summary: string; args: Record<string, unknown> } {
  let toolName = request.toolName || '';
  let args = (request.args ?? {}) as Record<string, unknown>;
  if (/^call_tool$/i.test(toolName)) {
    const inner =
      (typeof args.name === 'string' && args.name) ||
      (typeof args.tool === 'string' && args.tool) ||
      (typeof args.tool_name === 'string' && args.tool_name) ||
      '';
    if (inner) {
      toolName = inner;
      const innerArgs = args.args ?? args.arguments ?? (args as { input?: unknown }).input;
      if (innerArgs && typeof innerArgs === 'object') {
        args = innerArgs as Record<string, unknown>;
      }
    }
  }
  const pretty =
    toolName.replace(/^mcp__/, '').replace(/_/g, ' ').trim() || toolName;
  const displayTool =
    pretty.length > 0
      ? pretty.charAt(0).toUpperCase() + pretty.slice(1)
      : toolName;
  const rawName = toolName.replace(/^mcp__/, '');
  return {
    toolName: displayTool,
    rawName,
    args,
    summary: summarizeApprovalArgs(args, rawName, isZh),
  };
}

/**
 * 审批理由的中文文案 —— 按 **toolName** 查, 不去翻译英文句子。
 *
 * 后端那 25 条 reason 是硬编码英文, 写在 neox-kernel 的 defaultPermissions.ts 里。
 * kernel 是平台无关层, 本来就不该知道 UI 用什么语言, 所以不动它;
 * 也不做"英文句子 → 中文"的字符串匹配 —— 那种映射一改文案就断。
 * 按工具名查, 查不到就原样显示后端给的英文 (至少不会空)。
 */
export const APPROVAL_REASON_ZH: Record<string, string> = {
  /* 文件 */
  write_file: '会新建或覆盖一个文件',
  edit: '会修改文件内容（定向替换或打补丁）',
  create_directory: '会新建一个目录',
  delete_file: '会永久删除文件或目录',
  rename_file: '会重命名或移动文件、目录',

  /* execute_shell 和 execute_bash **后端两个都有**, 两条都要覆盖 —— 我重写这张表时
   * 一度只留了 execute_bash, 被覆盖率闸当场抓回来。 */
  execute_shell: '⚠️ 会在你的机器上执行 shell 命令，可能改动系统',
  execute_bash: '⚠️ 会在你的机器上执行 shell 命令，可能改动系统',
  execute_python: '⚠️ 会执行 Python 代码，可能改文件或调外部命令',
  execute_javascript: '⚠️ 会执行 JavaScript 代码，可能改文件或调外部命令',
  run_tests: '⚠️ 会跑测试 —— 测试本身就是在执行项目代码',
  run_lint: '⚠️ 会调用项目的 lint 工具执行',
  run_format: '⚠️ 会调用项目的格式化工具执行',

  /* git */
  git_commit: '会产生一次 git 提交',
  git_branch: '会新建或切换 git 分支',

  /* 本机 Neox 配置 —— 动的是用户自己的设置和密钥 */
  write_neox_config: '会修改本机的 Neox 配置',
  add_neox_provider: '会新增一个本地模型服务商，并保存它的 API Key',
  set_default_neox_provider: '会更改默认的本地模型服务商',
  remove_neox_provider: '会移除一个本地模型服务商',
  neox_switch_model: '会更改某个服务商的默认模型',
  neox_mcp_manage: '会增删或启停 MCP 服务器',
  neox_export_config: '会导出本机 Neox 配置信息（可能含敏感项）',

  /* 网络 / 索引 */
  neox_health_check: '会向服务商的接口发一次网络请求',
  web_search: '会发起一次网络请求',
  web_fetch: '会访问外部网络',
  build_index: '会在本地建立代码索引',

};

/** 审批行的动作名 —— 用户读的是"要干什么", 不是工具的函数名 (Write file / Execute bash)。
 *  查不到就回落到 unwrapApprovalTool 给的英文名, 不空。 */
export const APPROVAL_ACTION_ZH: Record<string, string> = {
  write_file: '写入文件', edit: '修改文件', create_directory: '新建目录',
  delete_file: '删除文件', rename_file: '重命名',
  execute_shell: '执行命令', execute_bash: '执行命令',
  execute_python: '执行 Python', execute_javascript: '执行 JS',
  run_tests: '跑测试', run_lint: '跑 lint', run_format: '格式化',
  git_commit: 'git 提交', git_branch: 'git 分支',
  write_neox_config: '改 Neox 配置', add_neox_provider: '加服务商',
  set_default_neox_provider: '换默认服务商', remove_neox_provider: '移除服务商',
  neox_switch_model: '换模型', neox_mcp_manage: '管理 MCP',
  neox_export_config: '导出配置', neox_health_check: '连通性检查',
  web_search: '联网搜索', web_fetch: '访问网页', build_index: '建索引',
  computer_run: '操作电脑', browser_run: '操作浏览器',
};

export function splitApprovalArg(text: string, tailLen = 22): { head: string; tail: string } {
  const t = String(text ?? '');
  if (t.length <= tailLen) return { head: '', tail: t };
  return { head: t.slice(0, t.length - tailLen), tail: t.slice(t.length - tailLen) };
}
