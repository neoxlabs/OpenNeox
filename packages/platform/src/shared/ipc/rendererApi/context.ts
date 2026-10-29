type ContextConfig = import('../../ipc.js').ContextConfig;
type ContextUsage = import('../../ipc.js').ContextUsage;

export interface RendererAPIContext {
  // ==================== 上下文管理 ====================
  contextGetUsage: (sessionId: string) => Promise<ContextUsage | null>;
  contextGetConfig: () => Promise<ContextConfig>;
  contextSetConfig: (config: Partial<ContextConfig>) => Promise<void | { runtimeWarning?: string }>;
  contextTriggerCompaction: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
  /** 回复风格: 内置四档 + 用户 / 项目目录里的 Markdown 风格, 以及当前选中的 id */
  outputStyleList: () => Promise<{
    styles: Array<{ id: string; name: string; description: string; builtin: boolean }>;
    current: string;
  }>;
  outputStyleSet: (id: string) => Promise<{ success: boolean; error?: string }>;
  /** 设置 → 诊断: 最近 N 小时 (默认 24) 的请求汇总 —— 形状见 core runtime/diagnostics/requestLog.ts RequestLogSummary */
  diagnosticsSummary: (hours?: number) => Promise<any>;
  /** 设置 → 网页分享 (用户自己的 Cloudflare R2); secret 回显打码 */
  shareGetConfig: () => Promise<{ accountId?: string; bucket?: string; accessKeyId?: string; secretAccessKey?: string; publicBaseUrl?: string }>;
  shareSetConfig: (cfg: { accountId?: string; bucket?: string; accessKeyId?: string; secretAccessKey?: string; publicBaseUrl?: string }) => Promise<{ success: boolean; error?: string }>;
  shareTest: () => Promise<{ ok: boolean; stage?: 'config' | 'upload' | 'public'; url?: string; error?: string; missing?: string[] }>;
}
