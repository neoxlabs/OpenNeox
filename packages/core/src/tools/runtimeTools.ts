/**
 * Runtime Tools - File operations, search, shell commands, code execution, etc.
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import type { PlatformServices } from '@neoxlabs/platform/platform/services.js';
import type { ActionLogService } from '../platform/actionLog/actionLogService.js';
import {
  executePython,
  executeJavaScript,
  executeBash,
} from './index.js';

export { listRecipes } from '../runtime/browser/browserRecipes.js';
export { replayAll } from '../runtime/browser/browserRun.js';
export { BROWSER_INSTRUCTION_SET } from '../runtime/browser/browserToolDefs.js';
export { browserSyncDailyLogins } from '../runtime/browser/browserTools.js';
export { syncDailyLogins, readDailyLoginsConfig } from '../runtime/browser/dailyLogins.js';
export { resolveGithubToken, resetGithubTokenCache } from './githubToken.js';
export { patchXlsxFile } from './sheet/sheetEditTools.js';
import { smartTree } from './smartTree.js';
import { webFetch } from './webTools.js';
import type { TerminalExecutor } from './terminal/executorRegistry.js';
import { createRuntimeTerminalExecutorBridge } from './terminal/runtimeTerminalExecutor.js';
import { createRuntimeCommandRunner } from './git/runtimeCommandRunner.js';
import { createUseSkillTool } from './skills/useSkillTool.js';
import { createShowTreeTool } from './tree/showTreeTool.js';
import { createRuntimeFileTools } from './files/runtimeFileTools.js';
import { collectRuntimeTools, getAllTools } from './registry/runtimeToolAssembly.js';
import { createRuntimeBaseTools } from './registry/runtimeBaseTools.js';
import { createRuntimeDeveloperTools } from './registry/runtimeDeveloperTools.js';
import { getToolLogger, getToolServices, setToolServices } from './runtimeToolServices.js';
import { isSandboxEnabled } from './shell/sandboxState.js';
import { createRuntimeShellTool } from './shell/runtimeShellTool.js';
import { createRuntimePowerShellTool } from './powershell/runtimePowerShellTool.js';
import { getWindowsShell, isPowerShellToolEnabled } from './powershell/powershellDetection.js';
import { createUpdatePlanTool } from './updatePlan.js';
import { askUserTool } from './askUserTool.js';
import { cronCreateTool, cronDeleteTool, cronListTool } from './cronTools.js';
import { REMINDER_TOOLS } from './reminderTools.js';
import { MACOS_BRIDGE_TOOLS } from './macosBridgeTools.js';
import { getWeatherTool } from './weatherTool.js';
import { updateProfileTool } from './profileTool.js';
import { taskCreateTool, taskGetTool, taskUpdateTool, taskListTool, taskStopTool, taskOutputTool } from './taskManagementTools.js';
import { enterPlanModeTool, exitPlanModeTool } from './planModeTools.js';
import { activateTargetTool, planTargetTool, planBlockTool, checkTargetDoneTool, abandonTargetTool, pauseTargetTool, continueTargetTool } from './targetModeTools.js';
import { enterWorktreeTool, exitWorktreeTool } from './worktreeTools.js';
import { bashOutputTool } from './shell/bashOutputTool.js';
import { bashKillTool } from './shell/bashKillTool.js';
import { serviceScanTool } from './shell/serviceScanTool.js';
import { serviceAdoptTool } from './shell/serviceAdoptTool.js';
import { runDevServerTool } from './shell/runDevServerTool.js';
import { registerRunConfigTool } from './shell/registerRunConfigTool.js';
import { bindRunConfigTool } from './shell/bindRunConfigTool.js';
import { openSurfaceTool } from './surface/openSurfaceTool.js';
import { updateSurfaceTool } from './surface/updateSurfaceTool.js';
import { closeSurfaceTool } from './surface/closeSurfaceTool.js';
import { updatePlanTool } from './surface/updatePlanTool.js';
import { updateTodosTool } from './surface/updateTodosTool.js';
import { createSlidesTool, listSlideTemplatesTool } from './pptx/createSlidesTool.js';
import { DECK_TOOLS } from './pptx/deckTools.js';
import { PPTX_EDIT_TOOLS } from './pptx/pptxEditTools.js';
import { IMAGE_GEN_TOOLS } from './imagegen/imageGenTools.js';
import { sheetDescribeTool, sheetGetRangeTool } from './sheet/sheetTools.js';
import { sheetNewWorkbookTool, sheetWriteRangeTool, sheetExportFileTool } from './sheet/sheetWriteTools.js';
import { sheetSetCellsTool } from './sheet/sheetEditTools.js';
import { sheetExportTool } from './sheet/sheetExportTool.js';
import { ALL_WORD_TOOLS } from './word/wordTools.js';
import { BROWSER_BASE_TOOLS, BROWSER_PACK_TOOLS, BROWSER_INSTRUCTION_SET } from '../runtime/browser/browserToolDefs.js';
import { COMPUTER_TOOLS, COMPUTER_TOOL_NAMES } from '../runtime/computer/computerToolDefs.js';
import { isComputerUseEnabled } from '../runtime/computer/computerCapability.js';
import { makeBrowserRunTool, makeBrowserReplayTool } from '../runtime/browser/browserRun.js';
import { scheduleWakeupTool } from './scheduleWakeupTool.js';
import { contextStatusTool } from './contextStatusTool.js';
import { readDocumentTool } from './readDocumentTool.js';
import { formatDisplayPath, getWorkspaceRoot, resolveWorkspacePath } from './workspace/pathHelpers.js';

export type { TerminalExecutor } from './terminal/executorRegistry.js';
export { setPdfExporter, getPdfExporter } from './export/pdfExporterRegistry.js';
export type { PdfExporter, PdfExportOptions, PdfExportResult } from './export/pdfExporterRegistry.js';
export { setBackgroundTaskCallback, setShellOutputStreamCallback } from './shell/shellUiCallbacks.js';
export { setSandboxEnabled, isSandboxEnabled } from './shell/sandboxState.js';
export { setToolServices, getToolServices, preloadShellEnv } from './runtimeToolServices.js';

const runtimeCommandRunner = createRuntimeCommandRunner(() => getToolServices().shellEnv.getShellEnv());
const runtimeTerminalExecutorBridge = createRuntimeTerminalExecutorBridge(getToolLogger);

/* Win: 传绝对路径, 避免裸 powershell.exe 撞坏 PATH (打包版 / node-runtime 劫持)。
 * 仍走前台 execa 路径, 不改道后台 worker。 */
const isWin = process.platform === 'win32';
const shellOption: string | boolean = isWin
  ? (getWindowsShell()?.shellPath ?? 'powershell.exe')
  : true;


// ==================== 终端执行器（Electron UI 模式） ====================
/**
 * 设置终端执行器（由 Electron 主进程调用）
 */
export const setTerminalExecutor: (executor: TerminalExecutor | null) => void =
  runtimeTerminalExecutorBridge.setTerminalExecutor;

/**
 * 获取终端执行器
 */
export const getTerminalExecutor: () => TerminalExecutor | null =
  runtimeTerminalExecutorBridge.getTerminalExecutor;

export {
  setDiagnosticsExecutor,
  getDiagnosticsExecutor,
} from './editor/diagnosticsExecutorRegistry.js';
export type {
  DiagnosticsExecutor,
  DiagnosticsQuery,
  DiagnosticItem,
} from './editor/diagnosticsExecutorRegistry.js';

const MAX_PATCH_BYTES = 1_000_000;

const { getGitRepoRoot, runCommand } = runtimeCommandRunner;

// - 默认使用 Search + Chunk 方式（无需构建索引）
// - 可选 AST 索引方式（适合大型项目、频繁查询）
// 详见 src/tools/smart-read/

const runtimeFileTools = createRuntimeFileTools({
  resolveWorkspacePath,
  formatDisplayPath,
  getWorkspaceRoot,
});
export const {
  writeFile,
  edit,
  editBatch,
  searchFiles,
  listDirectory,
  createDirectory,
  deleteFile,
  renameFile,
} = runtimeFileTools;

export const executeShell: Tool = createRuntimeShellTool({
  shellOption,
  getWorkspaceRoot,
  getSandboxEnabled: isSandboxEnabled,
  getToolLogger,
  getToolServices,
  getTerminalExecutor,
});

// PowerShell 工具 — Windows 默认启用, 其他平台通过 NEOX_POWERSHELL_TOOL=1 启用
export const executePowerShell: Tool | null = isPowerShellToolEnabled()
  ? createRuntimePowerShellTool({
      getSandboxEnabled: isSandboxEnabled,
      getTerminalExecutor,
      getToolLogger,
      getToolServices,
      getWorkspaceRoot,
    })
  : null;

export const showTree: Tool = createShowTreeTool({
  resolveWorkspacePath,
  formatDisplayPath,
});

const runtimeDeveloperTools = createRuntimeDeveloperTools({
  formatDisplayPath,
  getGitRepoRoot,
  getLogger: getToolLogger,
  getWorkspaceRoot,
  resolveWorkspacePath,
  runCommand,
});
export const {
  gitStatus,
  gitDiff,
  gitBlame,
  gitBranchList,
  gitBranch,
  gitCommit,
  runTests,
  runLint,
  runFormat,
  analyzeCode,
  searchTool,
} = runtimeDeveloperTools;

// 基础工具列表（始终可用）
// ==================== update_plan Tool ====================

export const updatePlan: Tool = createUpdatePlanTool({
  getWorkspaceRoot,
  /* sessionId 暂从 ToolServices 拉 — getToolServices() 是 ambient runtime context.
   * 没接通的进程 (CLI 一次性调用) 退化为 'current.md' 也 OK. */
  getSessionId: () => {
    try {
      const services = getToolServices();
      return (services as any)?.sessionId;
    } catch { return undefined; }
  },
});

export const useSkill: Tool = createUseSkillTool({ getWorkspaceRoot });

function tagGuiCapability(tools: Tool[]): Tool[] {
  return tools.map((t) => ({
    ...t,
    capabilities: t.capabilities ? Array.from(new Set([...t.capabilities, 'gui' as const])) : ['gui' as const],
  }));
}

// 注意：readfile 在 getTools 中动态加载
const BASE_TOOLS: Tool[] = createRuntimeBaseTools({
  analyzeCode,
  askUserTool,
  executeBash,
  executeJavaScript,
  executePython,
  executeShell,
  executePowerShell,
  fileTools: runtimeFileTools,
  gitTools: runtimeDeveloperTools,
  runTools: runtimeDeveloperTools,
  searchTool,
  showTree,
  smartTree,
  updatePlan,
  useSkill,
  webFetch,
  // P0 新增工具
  cronTools: [cronCreateTool, cronDeleteTool, cronListTool],
  taskTools: [taskCreateTool, taskGetTool, taskUpdateTool, taskListTool, taskStopTool, taskOutputTool],
  /* macOS 桥 (日历/提醒事项/联系人/iMessage) 非 darwin 平台是空数组, pack 目录里自然搜不到 */
  lifeTools: [...REMINDER_TOOLS, ...MACOS_BRIDGE_TOOLS, getWeatherTool, updateProfileTool],
  planModeTools: [enterPlanModeTool, exitPlanModeTool],
  /* Target Mission (Phase 1: 单 agent 长跑).
   * 两条激活路径:
   *   A) 用户 /target <文本>     → CLI targetCommandRouting → activateTargetFromCommand
   *   B) LLM 主 agent 自主判断  → activate_target 工具 (桌面端 & 自然语言触发也走这条)
   * 双层规划: plan_target 战略层(几十个战略块 + status), update_plan 战术层(当前块细步).
   * 激活后 loop 由 check_target_done/abandon_target/pause_target 驱动.
   * runner.ts 在 no-tool 退出点检查 isTargetActive(), 未 done 时注入 system 提醒 + continue.
   * pause_target: model 需要用户澄清时主动暂停, 保留 target 状态可 continue. */
  targetModeTools: [activateTargetTool, planTargetTool, planBlockTool, checkTargetDoneTool, abandonTargetTool, pauseTargetTool, continueTargetTool],
  worktreeTools: [enterWorktreeTool, exitWorktreeTool],
  bashSessionTools: [bashOutputTool, bashKillTool, serviceScanTool, serviceAdoptTool, runDevServerTool, registerRunConfigTool, bindRunConfigTool, scheduleWakeupTool, contextStatusTool, readDocumentTool],
  /* GUI tools 全部 tag capability=['gui'] — CLI 默认 gui:false 自动过滤掉, 桌面端 gui:true 放行. */
  surfaceTools: tagGuiCapability([openSurfaceTool, updateSurfaceTool, closeSurfaceTool, updatePlanTool, updateTodosTool]),
  browserTools: [
    ...BROWSER_BASE_TOOLS,
    makeBrowserRunTool(() => BROWSER_INSTRUCTION_SET),
    makeBrowserReplayTool(() => BROWSER_INSTRUCTION_SET),
    ...BROWSER_PACK_TOOLS,
  ],
  /* Computer Use (macOS OS 级操作)。
   *
   * 这里**照收不误**, 闸不在装配期 —— 在 getTools() 里按 isComputerUseEnabled() 动态过滤。
   * 理由: BASE_TOOLS 是模块加载时算一次的常量, 而插件是之后才加载的。在这儿判闸,
   * 用户装完 computer-use 插件得重启才生效 —— 又一个"机制写好了没接上"。 */
  /* 同样**不打 gui 标签**: Computer Use 走的是独立的 os-bridge 进程 (open -a 拉起的
   * 「Neox Computer Use.app」), 跟 Electron 一点关系都没有 —— 它操作的是用户的整台电脑,
   * 终端里跑跟桌面里跑完全一样。装没装插件、有没有授权由 getTools() 里的
   * isComputerUseEnabled() 动态判, 那才是真闸。 */
  computerTools: COMPUTER_TOOLS,
  /* Sheet S1 Phase 1 — 5 件套全:
   * 读 (D3): sheet_describe, sheet_get_range
   * 写 (D4): sheet_new_workbook, sheet_write_range, sheet_export_file
   *   工作流: new → write × N → export → 用户拖/点开 SheetSurfaceViewer 看. */
  sheetTools: tagGuiCapability([
    sheetDescribeTool, sheetGetRangeTool,
    sheetNewWorkbookTool, sheetWriteRangeTool, sheetExportFileTool,
    sheetExportTool,
    sheetSetCellsTool,
  ]),
  /* Word — pack 模式, 全部进 toolMap 不进 ALWAYS_ACTIVE.
   * agent 通过 tool_search({pack:'word'}) 解锁 schema 后才能调用.
   * 工具描述里包含 "live editing note" 提示用户可能在 docx surface 同步看到改动. */
  wordTools: tagGuiCapability(ALL_WORD_TOOLS),
  /* PPTX — create_slides + list_slide_templates (走自研 @neoxlabs/pptx-renderer).
   * 通用工具 (CLI + Desktop 都能生成 pptx 到磁盘), 不限 gui capability. */
  /* deck_* 是逐页路径 (6 页以上 / 长中文内容走这条), create_slides 是 ≤5 页的一次成型路径.
   * deck_* 的预览要 surface, 但导出本身不要 —— CLI 下预览 HTML 照样落盘, 用户能自己打开. */
  pptxTools: [createSlidesTool, listSlideTemplatesTool, ...DECK_TOOLS, ...PPTX_EDIT_TOOLS],
  /* Image generation — generate_image / edit_image.
   * 走 NeoxCloud 网关 (登录用户) 或 BYOK. 生图落盘到 workspace/generated-images/<date>/,
   * agent 可 open_surface 预览. 需要在 CLI / renderer 初始化时挂 resolver
   * (imageGenService.setCloudResolver / setBYOKResolver). */
  imageGenTools: IMAGE_GEN_TOOLS,
});

/**
 * 获取所有可用工具（根据配置动态加载）
 * Get all available tools (dynamically loaded based on config)
 */
export async function getTools(workspacePath?: string, services?: PlatformServices, actionLog?: ActionLogService): Promise<Tool[]> {
  if (services) {
    setToolServices(services);
  }
  const capabilities = services?.capabilities ?? getToolServices().capabilities;
  const tools = await collectRuntimeTools({
    actionLog,
    baseTools: BASE_TOOLS,
    capabilities,
    logger: getToolLogger(),
    workspacePath,
  });
  return applyComputerUseGate(tools);
}

function applyComputerUseGate(tools: Tool[]): Tool[] {
  if (process.env.NEOX_DEBUG_CAPABILITIES === '1') {
    // eslint-disable-next-line no-console
    console.log(`[COMPUTER_USE] gate=${isComputerUseEnabled() ? 'open' : 'closed'} platform=${process.platform}`);
  }
  if (isComputerUseEnabled()) return tools;
  const blocked = new Set<string>(COMPUTER_TOOL_NAMES);
  return tools.filter((t) => !blocked.has(t.name));
}

// 向后兼容：静态导出所有工具（包含 webSearch，但 webSearch 会在执行时检查配置）
export const ALL_TOOLS: Tool[] = getAllTools(BASE_TOOLS);
