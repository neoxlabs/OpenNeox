
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface WorkspaceConfig {
  version?: number;
  /** override 默认 provider id ('neox-cloud' / '<byok-id>') */
  defaultProvider?: string;
  /** override 默认 model id */
  defaultModel?: string;
  /** override 审批策略 */
  approvalPolicy?: 'auto' | 'manual' | 'dangerous';
  /** override 工具开关 (true=允许, false=禁) */
  tools?: Record<string, boolean>;
  /** 自由字段, 给上层 UI 用 */
  metadata?: Record<string, unknown>;
}

let cached: { cwd: string; config: WorkspaceConfig | null } | null = null;

/** 找当前 cwd 下的 workspace.json, 没有返 null. cache by cwd. */
export function loadWorkspaceConfig(cwd: string = process.cwd()): WorkspaceConfig | null {
  if (cached && cached.cwd === cwd) return cached.config;
  const path = join(cwd, '.neox', 'workspace.json');
  if (!existsSync(path)) {
    cached = { cwd, config: null };
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as WorkspaceConfig;
    /* 简单校验 — 不抛错, 只剔除明显错的字段 */
    const cleaned: WorkspaceConfig = {
      version: parsed.version,
      defaultProvider: typeof parsed.defaultProvider === 'string' ? parsed.defaultProvider : undefined,
      defaultModel: typeof parsed.defaultModel === 'string' ? parsed.defaultModel : undefined,
      approvalPolicy:
        parsed.approvalPolicy === 'auto' || parsed.approvalPolicy === 'manual' || parsed.approvalPolicy === 'dangerous'
          ? parsed.approvalPolicy
          : undefined,
      tools: parsed.tools && typeof parsed.tools === 'object' ? parsed.tools : undefined,
      metadata: parsed.metadata && typeof parsed.metadata === 'object' ? parsed.metadata : undefined,
    };
    cached = { cwd, config: cleaned };
    return cleaned;
  } catch (e) {
    /* JSON 损坏 — 静默, 不让 workspace.json 错误把 cli 卡死 */
    cached = { cwd, config: null };
    return null;
  }
}

/** 给上层调试 / `neox whoami` 显示用 — 当前 workspace.json 路径 (存在与否都返). */
export function workspaceConfigPath(cwd: string = process.cwd()): string {
  return join(cwd, '.neox', 'workspace.json');
}

/** invalidate cache (test 用 / 切 cwd 时) */
export function invalidateWorkspaceCache(): void {
  cached = null;
}
