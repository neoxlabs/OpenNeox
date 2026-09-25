/**
 * Neox Skills 系统类型定义。
 * Skill metadata follows the compatible SKILL.md format and adds runtime
 * controls for path activation, model and effort overrides, tool scoping,
 * enablement checks, lazy prompts, and realpath-based deduplication.
 */

import type { AgentMode } from '../types/permissions.js';

/**
 * Skill 分类
 */
export type SkillCategory =
  | 'git'
  | 'code'
  | 'test'
  | 'docs'
  | 'refactor'
  | 'debug'
  | 'deploy'
  | 'custom';

/**
 * Skill 来源（扩展：采用 兼容格式 loadedFrom）
 */
export type SkillSource = 'builtin' | 'user' | 'workspace' | 'mcp' | 'plugin' | 'managed' | 'marketplace';

/**
 * Skill 信任级别 (K2)
 *
 *   trusted: skill 跑起来后可调任意 agent 可见的工具 (按 normal 权限链, 不被 skill 层挡)
 *   limited: skill 只能调它在 metadata.neox.allowedTools 里声明的工具,
 *            调任何其它工具被 PermissionManager 直接拒, denyKind='denied_by_skill_scope'
 *
 *   推导规则 (loader 自动写, 用户可在 .neox-skill.json 覆盖):
 *     builtin / user / workspace  → trusted (自己写的, 信)
 *     marketplace / mcp / plugin  → limited (外人写的, 默认沙盒)
 *
 *   K2 必须配合 ALS 的 skillScope 才能强制 — 仅看 trustLevel 不防御.
 */
export type SkillTrustLevel = 'trusted' | 'limited';

/**
 * 危险等级
 */
export type DangerLevel = 'safe' | 'moderate' | 'dangerous';

/**
 *  Effort 级别（采用 兼容格式 effort 字段）
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

/**
 * Skill 生命周期钩子
 */
export interface SkillHooks {
  PreToolUse?: string;
  PostToolUse?: string;
  Stop?: string;
}

/**
 * Neox 扩展字段
 */
export interface NeoxSkillExtension {
  /** 分类 */
  category?: SkillCategory;
  /** 别名 */
  aliases?: string[];
  /** 必需工具 */
  requiredTools?: string[];
  /** 允许工具 —  现在会强制执行 */
  allowedTools?: string[];
  /** 需要的模式 */
  requiredMode?: AgentMode;
  /** 危险等级 */
  dangerLevel?: DangerLevel;
  /** 参数定义 */
  arguments?: Array<{ name: string; description: string; required?: boolean }>;
}

/**
 * Skill 元数据（兼容 Claude Code）
 */
export interface SkillMetadata {
  // 基础信息（兼容 Claude Code）
  /** 必需：最多 64 字符 */
  name: string;
  /** 必需：最多 200 字符，用于自动发现 */
  description: string;
  /** 可选: 英文描述, 用于 UI i18n 展示. 若缺失, 消费端 fallback 到 description. */
  description_en?: string;

  // 可选配置
  /** 依赖项 */
  dependencies?: string;
  /** 执行上下文 */
  context?: 'main' | 'fork';
  /** 代理类型 */
  agent?: string;
  /** 是否在菜单显示 */
  'user-invocable'?: boolean;

  /** 生命周期钩子 */
  hooks?: SkillHooks;

  /** 模型覆盖；该 skill 使用指定模型运行。 */
  model?: string;
  /** 思考努力级别 */
  effort?: EffortLevel;
  /** 条件激活路径，使用 gitignore 风格的 glob 匹配。 */
  paths?: string[];
  /** Shell 类型 */
  shell?: 'bash' | 'powershell';
  /** 详细使用场景 */
  whenToUse?: string;
  /** 参数提示 */
  argumentHint?: string;
  /** 版本号 */
  version?: string;
  /** 是否隐藏在 LLM 的 Skill 工具中 */
  disableModelInvocation?: boolean;

  /** 运行时门控回调；返回 false 时 skill 不可用。 */
  isEnabled?: () => boolean;

  /** Neox 扩展字段 */
  neox?: NeoxSkillExtension;
}

/**
 * 完整的 Skill 定义
 */
export interface Skill {
  /** skill 文件夹名 */
  id: string;
  /** SKILL.md 路径 */
  path: string;
  /** 来源 */
  source: SkillSource;
  /** 信任级别 (K2) — loader 根据 source 推断, 用户在 .neox-skill.json 可覆盖 */
  trustLevel: SkillTrustLevel;

  /** 元数据 */
  metadata: SkillMetadata;

  /** SKILL.md body 内容 */
  content: string;

  /** 支持文件 */
  supportFiles?: Map<string, string>;

  /** 文件系统 realpath，用于识别同一 skill 的不同路径。 */
  fileIdentity?: string;

  /** 内容长度，用于 token 估算。 */
  contentLength?: number;

  /** 懒加载函数，按需构建 prompt。 */
  lazyPrompt?: () => Promise<string>;
}

/**
 * Skill 执行结果
 */
export interface SkillResult {
  success: boolean;
  output?: string;
  error?: string;
  /** 使用的模型（如果覆盖了） */
  model?: string;
  /** 允许的工具列表（用于隔离执行） */
  allowedTools?: string[];
  /** K2: 执行时的 trustLevel. Caller (useSkillTool) 用它决定要不要 setSkillScope */
  trustLevel?: SkillTrustLevel;
  /** K2: skill id, useSkillTool 设 skillScope 用 */
  skillId?: string;
}

/**
 * Derive the default trust level from the skill source and its tool scope.
 * Built-in and user skills are trusted. Workspace skills remain trusted when
 * they declare no tool allowlist; a workspace allowlist is enforced as a
 * limited scope. Marketplace, MCP, plugin, and managed skills are limited by
 * default. Explicit metadata overrides are applied by the loader.
 */
export function deriveDefaultTrustLevel(source: SkillSource, hasAllowedTools = false): SkillTrustLevel {
  switch (source) {
    /* Built-in and user-provided skills are trusted by default. */
    case 'builtin':
    case 'user':
      return 'trusted';
    /* A workspace allowlist is enforceable only when it is present; without
     * one, the skill keeps the normal trusted behavior. */
    case 'workspace':
      return hasAllowedTools ? 'limited' : 'trusted';
    case 'marketplace':
    case 'mcp':
    case 'plugin':
    case 'managed':
      return 'limited';
  }
}

/**
 * Skill 列表查询选项
 */
export interface SkillListOptions {
  category?: SkillCategory;
  source?: SkillSource;
  userInvocable?: boolean;
  /** 只返回启用的 skill */
  enabledOnly?: boolean;
}

/**
 * Skill 执行上下文
 */
export interface SkillExecutionContext {
  /** 当前工作目录 */
  workDir: string;
  /** 用户输入的参数 */
  args: string;
  /** 原始用户输入 */
  rawInput: string;
}
