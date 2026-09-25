/**
 * ToolTree v2 - 工具分类树定义
 *
 * 将所有工具按功能分类，LLM 通过 tool_search 按需发现工具，
 * 通过 call_tool 代理执行，而不是一次性看到全部工具定义。
 *
 *  v2: 基于 ToolPack 架构重构
 *   - TOOL_CATEGORIES 从 ToolPackRegistry 动态生成
 *   - 保持向后兼容：外部代码继续使用 ToolCategory 接口
 *   - 新增 ToolPack 分组显示能力
 *
 * 参考：AnyTool 层级检索 + ToolLLM 分类思想
 */

import { toolPackRegistry, type ToolPack } from './packs/toolPack.js';
import { BUILTIN_PACKS } from './packs/builtinPacks.js';

// ==================== 向后兼容接口 ====================

export interface ToolCategory {
  /** 类别 ID */
  id: string;
  /** 类别显示名 */
  label: string;
  /** 给 LLM 看的类别描述（简短） */
  description: string;
  /** 该类别包含的工具名列表 */
  toolNames: string[];
}

// ==================== 工具包初始化 ====================

// 注册所有内置工具包
toolPackRegistry.registerAll(BUILTIN_PACKS);

/**
 * 从 ToolPackRegistry 动态生成 TOOL_CATEGORIES
 * 保持与旧代码的完全兼容
 */
function buildCategories(): ToolCategory[] {
  return toolPackRegistry.getAll().map(pack => ({
    id: pack.id,
    label: pack.label,
    description: `${pack.icon} ${pack.description}`,
    toolNames: [...pack.toolNames],
  }));
}

/**
 * 模块加载时生成的分类快照，保留给依赖静态导出的调用方。
 * 动态注册的 pack 通过 getToolCategories() 读取最新分类；ToolTreeEngine 默认使用该 getter。
 */
export const TOOL_CATEGORIES: ToolCategory[] = buildCategories();

/** 实时拿当前 registry 快照 — 跟 register/unregister 同步. */
export function getToolCategories(): ToolCategory[] {
  return buildCategories();
}

/**
 * 常驻工具集合。集合覆盖代码编辑、文件探索、计划管理、验证、委派、用户交互和
 * 浏览器入口等每轮都可能需要的基础能力；其余工具按 pack 延迟解锁。
 *
 * 工具是否常驻同时考虑 schema 成本和调用链路：高频且 schema 较小的只读、验证和
 * 后台任务控制工具保持可见，低频或领域专用工具由 tool_search 按需加入。
 */
export const ALWAYS_ACTIVE_TOOLS = new Set([
  'search',        // grep — 最高频
  'search_files',  // glob，与 search 配套
  'readfile',      // 读文件 — 最高频
  'edit',          // 统一编辑 (内容寻址 old_string/new_string)
  'write_file',    // 写文件 — 高频
  'update_plan',   // 计划更新 — verification mandate 直接依赖
  'execute_shell', // shell — 一切 IO / 验证的基石
  'explore',       // 任务 Agent — 长上下文研究, 高频用
  'agent',         // typed 子 agent 委派入口，模型需要始终可见
  'ask_user',      // 向用户提问 — 异常路径必须秒可达
  'open_surface',  // 右栏画布主入口 — vibe IDE "改完立刻看到" 的反馈环, 跟 edit/write 同等地位
  'browser_list_surfaces', // 浏览器发现入口 — 让 agent 永远能知道用户有没有开 web surface
                           // (其余 30 个 browser_* 走 browserPack, tool_search 解锁)
  'read_lints',    // 读 IDE Monaco 诊断 — 对齐 Cursor ReadLints, 改完立刻能看红线
  'list_directory',// 目录探索原语
  'git_status',
  'git_diff',
  'run_tests',     // 验证入口
  'run_lint',      // 验证入口
  'bash_output',   // 读取后台 execute_shell 输出
  'bash_kill',     // 停止后台任务并清理服务面板登记
  /* 调研入口保持可见；provider 和 capabilityFilters 仍决定其是否实际装配。 */
  'web_search',
  'web_fetch',
  'memory',
  'use_skill',
                   //   装了 commit skill 说"帮我提交", 模型裸跑 git 完全无视 skill)。
                   //   Life 模式 7-14 已同因同修 (agenticRuntime.ts "技能入口必须常驻"),
                   //   Code 模式是同一个洞。prompt 广告与工具表面必须一致。
]);

/**
 * 根据工具名查找所属类别
 */
export function findCategoryForTool(toolName: string): string | undefined {
  const pack = toolPackRegistry.findPackForTool(toolName);
  return pack?.id;
}

// ==================== 新 API ====================

/**
 * 获取工具包注册表（供外部访问）
 */
export { toolPackRegistry } from './packs/toolPack.js';
export type { ToolPack } from './packs/toolPack.js';
export { BUILTIN_PACKS } from './packs/builtinPacks.js';
