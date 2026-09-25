import type { Tool } from '@neoxlabs/kernel/types/index.js';

export interface BaseToolsDeps {
  analyzeCode: Tool;
  askUserTool: Tool;
  createDirectory: Tool;
  deleteFile: Tool;
  edit: Tool;
  editBatch: Tool;
  executeBash: Tool;
  executeJavaScript: Tool;
  executePython: Tool;
  executeShell: Tool;
  executePowerShell: Tool | null;
  gitBlame: Tool;
  gitBranch: Tool;
  gitBranchList: Tool;
  gitCommit: Tool;
  gitDiff: Tool;
  gitStatus: Tool;
  listDirectory: Tool;
  renameFile: Tool;
  runFormat: Tool;
  runLint: Tool;
  runTests: Tool;
  searchFiles: Tool;
  searchTool: Tool;
  showTree: Tool;
  smartTree: Tool;
  updatePlan: Tool;
  useSkill: Tool;
  webFetch: Tool;
  writeFile: Tool;
  // P0 新增工具
  cronTools?: Tool[];
  taskTools?: Tool[];
  planModeTools?: Tool[];
  worktreeTools?: Tool[];
  /** 后台 shell 观察/控制工具(bash_output, bash_kill)— 与 execute_shell(background=true) 配套 */
  bashSessionTools?: Tool[];
  /** Surface 工具(open/update/close_surface)— agent 把产出物推到右栏画布 */
  surfaceTools?: Tool[];
  /** Browser Surface 全部工具(BASE + PACK) — 注册进 toolMap. browser_list_surfaces 通过
   *  ALWAYS_ACTIVE_TOOLS 常驻; 其余 ~40 个走 browserPack 通过 tool_search 解锁 schema. */
  browserTools?: Tool[];
  /** Computer Use (macOS OS 级操作) — computer_snapshot / computer_run / computer_check_access。
   *  这里照收, 可见性闸在 runtimeTools.getTools() 里按 isComputerUseEnabled() 动态过滤
   *  (BASE_TOOLS 是模块加载时的常量, 在装配期判闸会让"装完插件要重启才生效")。 */
  computerTools?: Tool[];
  /** Sheet 工具(describe / get_range / new_workbook / write_range / export_file)— Excel/CSV I/O */
  sheetTools?: Tool[];
  /** Word 工具(describe / get_paragraphs / replace_text / edit_paragraph / insert / delete)
   * 通过 'word' pack 解锁, **不进 ALWAYS_ACTIVE** — agent 用 tool_search 拿 schema 才能调. */
  wordTools?: Tool[];
  /** Target Mission 工具(plan_target / check_target_done / abandon_target)
   *  — /target 命令激活后主 agent 通过这三个工具驱动长跑 loop.
   *  Phase 1: 单 agent 长跑, 对齐 Codex Goal / Droid Mission.
   *  参考 内部设计文档 */
  targetModeTools?: Tool[];
  /** 提醒 / 天气 / 画像 / macOS 桥 —— 通过 'life' pack (提醒与天气) 按需 fetch, 给 work 用 */
  lifeTools?: Tool[];
  /** PPT 生成工具 (create_slides + list_slide_templates) — 走自研 @neoxlabs/pptx-renderer.
   *  跟 sheetTools/wordTools 平级, 通用 (CLI + Desktop 都能用) 不限 GUI. */
  pptxTools?: Tool[];
  /** 图像生成工具 (generate_image / edit_image) — 走 NeoxCloud 网关或 BYOK.
   *  需要在 CLI / renderer 初始化时挂 imageGenService resolver. */
  imageGenTools?: Tool[];
}

export function createBaseTools(deps: BaseToolsDeps): Tool[] {
  return [
    deps.writeFile,
    deps.edit,
    deps.editBatch,
    deps.deleteFile,
    deps.renameFile,
    deps.searchFiles,
    deps.listDirectory,
    deps.createDirectory,
    deps.gitStatus,
    deps.gitDiff,
    deps.gitBlame,
    deps.gitBranchList,
    deps.gitBranch,
    deps.gitCommit,
    deps.runTests,
    deps.runLint,
    deps.runFormat,
    deps.executeShell,
    ...(deps.executePowerShell ? [deps.executePowerShell] : []),
    deps.showTree,
    deps.smartTree,
    deps.analyzeCode,
    deps.searchTool,
    deps.executePython,
    deps.executeJavaScript,
    deps.executeBash,
    deps.webFetch,
    deps.updatePlan,
    deps.askUserTool,
    deps.useSkill,
    // P0 新增工具
    ...(deps.cronTools || []),
    ...(deps.taskTools || []),
    ...(deps.planModeTools || []),
    ...(deps.worktreeTools || []),
    ...(deps.bashSessionTools || []),
    ...(deps.surfaceTools || []),
    ...(deps.browserTools || []),
    ...(deps.computerTools || []),
    ...(deps.sheetTools || []),
    ...(deps.wordTools || []),
    ...(deps.targetModeTools || []),
    ...(deps.lifeTools || []),
    ...(deps.pptxTools || []),
    ...(deps.imageGenTools || []),
  ];
}
