/**
 * kernelConfigBridge exposes the configuration subset needed by kernel code.
 *
 * StreamedRunner 及其 helper(runnerProfileUtils / defaultGuardrails)需要读几个
 * 用户配置项(FGTS 开关 / 每模型 toolset 覆盖 / guardrail 兼容模式)。这些值在 Neox
 * 整车里来自 ~/.neox 的 NeoxConfig(`utils/config.ts` 的 loadConfig), 但 kernel 不该
 * 读盘、不该依赖 Neox 配置体系。
 *
 * 机制: core 的 utils/config.ts 在加载时**自注册** setKernelConfigProvider(() => loadConfig())。
 *   - 整车(core/CLI/desktop/server/cloud): config 模块必被加载 → provider 接上 → 行为不变。
 *   - 纯 kernel(第三方/colony, 不含 utils/config): provider 不接 → getKernelConfig() 返回 {}
 *     → 各处 graceful 降级到默认值(FGTS=初始值 / 无 toolset 覆盖 / compat=false)。
 *
 * Hosts register a provider; standalone kernel consumers receive an empty view
 * and keep their local defaults without filesystem dependencies.
 */

/** kernel 关心的配置子集 (NeoxConfig 的结构超集即可赋值进来)。 */
export interface KernelConfigView {
  experimental?: {
    enableFGTS?: boolean;
    guardrailsCompatMode?: boolean;
  };
  /** profileId → 禁用工具名列表 */
  toolsetOverrides?: Record<string, string[]>;
  /** modelKey(小写) → 禁用工具名列表 */
  toolsetOverridesByModel?: Record<string, string[]>;
  /** modelKey(小写) → 用户对该模型适配包的覆盖
   *  以 ModelProfile 的形状存部分字段, 在 resolveModelProfile 里作为**最后一层** deepMerge 进去。
   *  放在这里而不是各调用点, 是为了 CLI / 桌面 / runtime / systemPrompt 四个解析入口
   *  自动同口径 —— 否则只要漏一处, 用户改了设置却在某条路径上不生效。 */
  modelProfileOverrides?: Record<string, Record<string, unknown>>;
  /** Agent 运行时开关里 kernel 需要的那一格。
   *  「记住已批准的命令」此前**没有任何读点** —— PermissionManager 无条件缓存,
   *  用户把它关掉仍然不会被重新询问 (安全相关: 用户以为收紧了, 实际没有)。 */
  agentRuntime?: {
    approvalCache?: { enabled?: boolean };
  };
}

let _provider: (() => KernelConfigView) | null = null;

/** core 侧 boot 注入真实 config 读取器(utils/config 自注册)。传 null 可解绑(测试用)。 */
export function setKernelConfigProvider(fn: (() => KernelConfigView) | null): void {
  _provider = fn;
}

/** 读当前 kernel 配置视图; 无 provider(纯 kernel)时返回空对象 → 调用方各自 graceful 降级。 */
export function getKernelConfig(): KernelConfigView {
  if (!_provider) return {};
  try {
    return _provider() || {};
  } catch {
    return {};
  }
}
