
export interface CurrentModelProfileInfo {
  profileId: string;
  model: string;
  providerId: string;
  protocol: string;
  sourceProfileIds: string[];
  toolset?: {
    disabledTools?: string[];
  } | null;
  prompt?: any;
  completion?: any;
  transport?: any;
  behavior?: any;
  reasoning?: any;
  are?: any;
}

export interface ModelProfileListEntry {
  providerId: string;
  providerName: string;
  model: string;
  profileId: string;
  isDefault: boolean;
  sourceProfileIds: string[];
  disabledTools: string[];
  builtinDisabledTools?: string[];
  modelOverrideDisabledTools?: string[] | null;
  profileOverrideDisabledTools?: string[] | null;
  maxTokens?: number;
}

// ==================== MCP 服务器类型 ====================
export type MCPTransport = 'stdio' | 'sse' | 'http';
export type MCPConfigScope = 'user' | 'workspace';

export interface MCPServerEntry {
  id: string;
  name?: string;
  transport: MCPTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled?: boolean;
  autoConnect?: boolean;
  allowlist?: string[];
  scope: MCPConfigScope;
  /** 仓库 .neox/mcp.json 带的 server 是否已批准 (mcp:list 填; 用户级恒为 true) */
  trusted?: boolean;
}

// ==================== Skills 类型 ====================
export type SkillCategory = 'git' | 'code' | 'test' | 'docs' | 'refactor' | 'debug' | 'deploy' | 'custom';
export type SkillSource = 'builtin' | 'user' | 'workspace' | 'mcp';

export interface SkillInfo {
  id: string;
  path: string;
  source: SkillSource;
  metadata: {
    name: string;
    description: string;
    /** 英文描述 —— 内置技能的 SKILL.md 里都带这个字段。类型里漏了它,
     *  于是设置页只能渲染中文那份 (英文界面下技能描述全中文)。 */
    description_en?: string;
    'user-invocable'?: boolean;
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'max';
    paths?: string[];
    whenToUse?: string;
    version?: string;
    disableModelInvocation?: boolean;
    neox?: {
      category?: SkillCategory;
      aliases?: string[];
      dangerLevel?: 'safe' | 'moderate' | 'dangerous';
      allowedTools?: string[];
      arguments?: Array<{
        name: string;
        description: string;
        required?: boolean;
      }>;
    };
  };
  content: string;
}
