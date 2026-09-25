import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { createBaseTools } from './baseTools.js';

interface RuntimeBaseToolsDeps {
  analyzeCode: Tool;
  askUserTool: Tool;
  executeBash: Tool;
  executeJavaScript: Tool;
  executePython: Tool;
  executeShell: Tool;
  executePowerShell: Tool | null;
  fileTools: {
    createDirectory: Tool;
    deleteFile: Tool;
    edit: Tool;
    editBatch: Tool;
    listDirectory: Tool;
    renameFile: Tool;
    searchFiles: Tool;
    writeFile: Tool;
  };
  gitTools: {
    gitBlame: Tool;
    gitBranch: Tool;
    gitBranchList: Tool;
    gitCommit: Tool;
    gitDiff: Tool;
    gitStatus: Tool;
  };
  runTools: {
    runFormat: Tool;
    runLint: Tool;
    runTests: Tool;
  };
  searchTool: Tool;
  showTree: Tool;
  smartTree: Tool;
  updatePlan: Tool;
  useSkill: Tool;
  webFetch: Tool;
  // P0 新增工具
  cronTools?: Tool[];
  taskTools?: Tool[];
  planModeTools?: Tool[];
  worktreeTools?: Tool[];
  bashSessionTools?: Tool[];
  surfaceTools?: Tool[];
  browserTools?: Tool[];
  computerTools?: Tool[];
  sheetTools?: Tool[];
  wordTools?: Tool[];
  targetModeTools?: Tool[];
  lifeTools?: Tool[];
  pptxTools?: Tool[];
  imageGenTools?: Tool[];
}

export function createRuntimeBaseTools(deps: RuntimeBaseToolsDeps): Tool[] {
  return createBaseTools({
    analyzeCode: deps.analyzeCode,
    askUserTool: deps.askUserTool,
    createDirectory: deps.fileTools.createDirectory,
    deleteFile: deps.fileTools.deleteFile,
    edit: deps.fileTools.edit,
    editBatch: deps.fileTools.editBatch,
    executeBash: deps.executeBash,
    executeJavaScript: deps.executeJavaScript,
    executePython: deps.executePython,
    executeShell: deps.executeShell,
    executePowerShell: deps.executePowerShell,
    gitBlame: deps.gitTools.gitBlame,
    gitBranch: deps.gitTools.gitBranch,
    gitBranchList: deps.gitTools.gitBranchList,
    gitCommit: deps.gitTools.gitCommit,
    gitDiff: deps.gitTools.gitDiff,
    gitStatus: deps.gitTools.gitStatus,
    listDirectory: deps.fileTools.listDirectory,
    renameFile: deps.fileTools.renameFile,
    runFormat: deps.runTools.runFormat,
    runLint: deps.runTools.runLint,
    runTests: deps.runTools.runTests,
    searchFiles: deps.fileTools.searchFiles,
    searchTool: deps.searchTool,
    showTree: deps.showTree,
    smartTree: deps.smartTree,
    updatePlan: deps.updatePlan,
    useSkill: deps.useSkill,
    webFetch: deps.webFetch,
    writeFile: deps.fileTools.writeFile,
    // P0 新增工具
    cronTools: deps.cronTools,
    taskTools: deps.taskTools,
    planModeTools: deps.planModeTools,
    worktreeTools: deps.worktreeTools,
    bashSessionTools: deps.bashSessionTools,
    surfaceTools: deps.surfaceTools,
    browserTools: deps.browserTools,
    computerTools: deps.computerTools,
    sheetTools: deps.sheetTools,
    wordTools: deps.wordTools,
    targetModeTools: deps.targetModeTools,
    lifeTools: deps.lifeTools,
    pptxTools: deps.pptxTools,
    imageGenTools: deps.imageGenTools,
  });
}
