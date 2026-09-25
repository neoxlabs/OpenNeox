/**
 * 从 Claude Code / Codex 搬家的 renderer 契约。
 *
 *   migrateScan / migrateApply、provider 和 session 通道统一在此声明，
 *   renderer 可以通过类型化的 window.neox 契约调用迁移流程。
 */

export interface MigrateSkillCandidate {
  id: string; name: string; source: string; path: string; alreadyImported: boolean;
}

export interface MigrateMcpCandidate {
  id: string; source: string; transport: string; summary: string;
  envKeys: string[]; disabledAtSource: boolean; alreadyImported: boolean;
}

export interface MigrateSessionCandidate {
  /** 'claude-code' | 'codex' —— 决定用哪个解析器 */
  source: string;
  sessionId: string;
  filePath: string;
  /** 会话原本在哪个目录跑的; 读不到为 null (**不从目录名猜**) */
  cwd: string | null;
  title: string | null;
  bytes: number;
  updatedAt: string;
  alreadyImported: boolean;
}

export interface MigrateScanResult {
  skills: MigrateSkillCandidate[];
  mcp: MigrateMcpCandidate[];
  sessions: {
    count: number; projects: number; totalBytes: number;
    bySource: Record<string, number>;
    recent: MigrateSessionCandidate[];
  };
  /** 全 0 就别打扰用户 —— 引导页据此决定要不要插这一屏 */
  freshCount: number;
}

export interface MigrateProviderCandidate {
  id: string;
  name: string;
  source: string;
  sourcePath: string;
  protocol: string;
  baseUrl?: string;
  urlSuffix?: string;
  defaultModel?: string;
  /** Key 读到了没。false = 端点对但要用户补 Key (Codex 把 Key 放环境变量里, 桌面进程读不到) */
  hasKey: boolean;
  keyOrigin: 'config' | 'process-env' | 'shell-profile' | null;
  keyEnvName?: string;
  /** **永远是掩码** —— 明文不过 IPC */
  keyPreview: string | null;
  alreadyImported: boolean;
}

export interface RendererAPIMigrate {
  migrateScan: () => Promise<MigrateScanResult>;
  migrateApply: (payload: {
    skillPaths?: string[];
    mcpIds?: string[];
    /** MCP 的 env 里常有密钥 —— 默认 false, 必须用户显式打开 */
    withEnv?: boolean;
    sessions?: Array<{ filePath: string; source: string }>;
  }) => Promise<{
    imported: number; failed: number; envStripped: string[]; errors: string[];
    sessionsImported: number; sessionsDuplicate: number;
  }>;
  /** BYOK 检测 —— 只在用户按下按钮时调用, 不要挂到任何自动路径上 */
  migrateScanProviders: () => Promise<{ providers: MigrateProviderCandidate[] }>;
  migrateImportProviders: (payload: {
    ids: string[];
    /** 用户手填的 Key (读不到的那些) */
    keys?: Record<string, string>;
    setDefault?: boolean;
  }) => Promise<{ imported: number; failed: number; skippedNoKey: string[]; errors: string[] }>;
}
