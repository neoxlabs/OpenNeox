import { zhToolLabel } from '../agent-timeline/mapTimeline';

const TOOL_ZH: Record<string, string> = {
  bash_output: '查看命令输出', bash_kill: '停止命令', web_search: '搜索网页', web_fetch: '打开网页',
  update_todos: '更新待办', todo_write: '更新待办', update_plan: '更新方案', ask_user: '问你一句',
  read_document: '读取文档', open_surface: '打开预览',
};

/* 模型还在吐参数时, 占位卡标题就是工具名本身 (「Execute shell」) */
const BARE_TOOL_ZH: Record<string, string> = {
  execute_shell: '运行命令', bash: '运行命令', read_file: '读取文件', write_file: '写入文件', edit: '修改文件',
  edit_file: '修改文件', grep: '搜索代码', glob: '查找文件', list_directory: '查看目录', ...TOOL_ZH,
};

export function zhRuntimeTitle(title: string): string {
  const t = title.replace(/^[^\p{L}\p{N}]+/u, '');
  const bare = BARE_TOOL_ZH[t.trim().toLowerCase().replace(/\s+/g, '_')];
  if (bare) return bare;
  return t
    .replace(/^Executing (\S+)/, (_, name: string) => TOOL_ZH[name] ?? zhToolLabel(name) ?? '处理中')
    /* 不把命令原文摆出来 (10-19 用户截图: 侧栏写着「运行 dir /a /s」), 小白看不懂, 一律说「运行命令」 */
    .replace(/^Running: [\s\S]*/, '运行命令')
    .replace(/^Reading (\d+) files/, '读取 $1 个文件')
    .replace(/^Reading file/, '读取文件').replace(/^Reading /, '读取 ')
    .replace(/^Writing file/, '写入文件').replace(/^Writing /, '写入 ')
    .replace(/^Editing file/, '修改文件').replace(/^Editing /, '修改 ')
    .replace(/^Searching for /, '搜索 ').replace(/^Searching code/, '搜索代码')
    .replace(/^Listing /, '查看目录 ').replace(/^Finding files/, '查找文件');
}
