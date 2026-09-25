/**
 * Resolve execute_shell's optional cwd relative to the workspace. Callers use
 * it for subdirectories instead of embedding a persistent cd prefix.
 */
import path from 'node:path';
import fs from 'node:fs';

export interface ShellCwdResolution {
  /** 命令实际执行目录 */
  dir: string;
  /** 解析失败的原因 (给模型看的完整话术); 有值时不要执行命令 */
  error?: string;
}

/**
 * 把 cwd 参数解析成绝对目录。
 *   · 不传 → 工作区根目录 (老行为, 零变化)
 *   · 相对路径 → 相对工作区根目录
 *   · 绝对路径 → 原样用 (agent 有时确实要去 /tmp 跑脚本)
 * 目录不存在 / 不是目录 → 返回 error, 由调用方当工具失败报出去 (别默默跑到别的目录里)。
 */
export function resolveShellCwd(cwd: unknown, workspaceRoot: string): ShellCwdResolution {
  const raw = typeof cwd === 'string' ? cwd.trim() : '';
  if (!raw) return { dir: workspaceRoot };
  const dir = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(workspaceRoot, raw);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    return { dir: workspaceRoot, error: `cwd 不存在: ${dir}\n(相对路径按工作区根目录 ${workspaceRoot} 解析; 先用 list_directory 确认路径, 或去掉 cwd 直接在工作区根目录跑)` };
  }
  if (!stat.isDirectory()) {
    return { dir: workspaceRoot, error: `cwd 不是目录: ${dir}` };
  }
  return { dir };
}
