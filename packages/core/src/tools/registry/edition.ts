/**
 * Edition — 发行版形态 (, lite 分支)。
 *
 * 目标: 出一个对标 pi 的极简版给极客用 —— 只留"一个 agent 在你的终端里干活"必需的那几件,
 * 浏览器 / PPT / Excel / Word / 出图 / Java 调试 / 桌面画布 / 生活模式 全砍。
 *
 * ── 为什么砍工具是有意义的, 不只是省体积 ──────────────────────────
 * 每个工具的 schema 都要进 system 段, 一直占着上下文窗口。标准版挂满时是几十个工具的
 * schema; 极简版只有十来个 —— 省下来的窗口全给真正的对话。**这是主要收益, 体积是副产品。**
 *
 * ── 为什么用白名单而不是黑名单 ────────────────────────────────
 * 黑名单要求"每加一个新工具都记得去 lite 那边排除一次", 这种约定必然会漏 ——
 * 漏了的后果是极简版悄悄长胖, 而且没人会发现。白名单反过来: 新工具默认不进极简版,
 * 想进得显式加一行, 漏的方向是安全的。
 *
 * ── 怎么选形态 ────────────────────────────────────────────
 * 环境变量 NEOX_EDITION=lite。它是**发行版身份**, 由打包脚本烤进去,
 * 不是给用户临时切着玩的开关 —— 极简版的包里本来就没有那些工具的实现。
 */

export type NeoxEdition = 'standard' | 'lite';

export function currentEdition(): NeoxEdition {
  return String(process.env.NEOX_EDITION || '').trim().toLowerCase() === 'lite' ? 'lite' : 'standard';
}

export function isLite(): boolean {
  return currentEdition() === 'lite';
}

/**
 * 极简版留下的工具白名单。
 *
 * 判据是"没有它, 一个 agent 就没法在终端里替你干活":
 *   · 看 —— 读文件 / 列目录 / 搜索 / 看树
 *   · 改 —— 写 / 编辑 / 删 / 改名 / 建目录
 *   · 跑 —— shell (含后台 shell 的观察和终止)
 *   · git —— 极客的工作面就是 git, 状态和 diff 是刚需
 *   · 计划 / 问用户 / 技能 —— agent 自身的骨架, 砍了它就不是 agent 了
 *   · web_fetch —— 读一篇文档的成本远低于挂一整套浏览器
 *
 * 明确不在里面的 (以及为什么):
 *   browser_*      整套浏览器自动化, 极简版的核心排除项
 *   create_slides / sheet_* / word_*   办公三件套, 极客不用, 而且拖着 pptx/xlsx 依赖
 *   generate_image / edit_image        出图
 *   java_debug_*                       Java 调试, 还要另外下 JAR
 *   open_surface / update_surface      桌面右栏画布, 极简版没有 GUI
 *   life_* / cron_*                    生活模式和定时任务
 *   analyze_code / smart_tree          走 tree-sitter, 那套原生依赖 ~20 MB
 *   execute_python / execute_javascript 有 execute_shell 就够了, 少两个 schema
 */
export const LITE_TOOL_ALLOWLIST: readonly string[] = [
  /* 看 —— 注意读文件的注册名是 `readfile` 不是 `read_file`, 后者根本不存在。
   * (第一版就是照直觉写的 read_file, 靠 editionAllowlist.test.ts 那条
   *  "白名单里每个名字都得在源码里真的注册过" 才戳穿 —— 名字写错的白名单
   *  不会报错, 只会静默少一个工具。) */
  'readfile',
  'list_directory',
  'search_files',
  'search',
  'show_tree',
  /* 改 */
  'write_file',
  'edit',
  'edit_batch',
  'delete_file',
  'rename_file',
  'create_directory',
  /* 跑 */
  'execute_shell',
  'bash_output',
  'bash_kill',
  /* git */
  'git_status',
  'git_diff',
  'git_commit',
  'git_branch',
  'git_branch_list',
  'git_blame',
  /* agent 骨架 */
  'update_plan',
  'ask_user',
  'use_skill',
  'web_fetch',
];

const LITE_SET = new Set(LITE_TOOL_ALLOWLIST);

/**
 * 按发行版形态过滤工具。standard 原样返回 —— 这条路径上标准版必须零行为变化。
 */
export function filterToolsByEdition<T extends { name: string }>(tools: T[]): T[] {
  if (!isLite()) return tools;
  return tools.filter(t => LITE_SET.has(t.name));
}
