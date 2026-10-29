/**
 * workspaceRootsContext — 多根工作区"附加根"的进程内 ambient 上下文 (server 进程)。
 *
 * 背景: 多根工作区下, 一个会话的 primary root = workDir, 但工作区还可能挂了别的项目根。
 * 让 agent 在系统提示里**知道**这些根存在 (它的 bash 本就能读任意绝对路径, 缺的只是"知道")。
 *
 * 为什么用 ambient 而不是把 roots 一路 thread 进 runner 构造器:
 *   - env 段由 `buildEnvironmentInfo(workDir)` 生成, 同时被 agenticRuntime(每轮组装) 和
 *     openai provider(自建 responses 指令) 两条路径调用。ambient 在这一个读取点统一覆盖两路,
 *     不必改 runner 构造器 / provider / 各层签名 (零侵入主路径, 回归面最小)。
 *   - 安全性: roots 缺省/单根 → getAdditionalRoots 返 []  → buildEnvironmentInfo 不追加任何行
 *     → **完全零行为变化**。即便 server 没收到 roots, 也只是不显示, 绝不破坏。
 *
 * 键: primary workDir (= 会话 workspacePath)。server 在 chat() 入口按请求设置。
 */

const _rootsByWorkDir = new Map<string, string[]>();

/** server chat 入口调用: 登记某 workDir(primary)对应工作区的全部根。单根/空 → 清除。 */
export function setWorkspaceAdditionalRoots(workDir: string | undefined, roots: string[] | undefined): void {
  if (!workDir) return;
  if (!roots || roots.length <= 1) {
    _rootsByWorkDir.delete(workDir);
    return;
  }
  _rootsByWorkDir.set(workDir, roots.slice());
}

/** buildEnvironmentInfo 调用: 返回 workDir 之外的附加根 (已排除 primary 自身)。无 → []。 */
export function getWorkspaceAdditionalRoots(workDir: string): string[] {
  const roots = _rootsByWorkDir.get(workDir);
  if (!roots || roots.length === 0) return [];
  return roots.filter((r) => r && r !== workDir);
}
