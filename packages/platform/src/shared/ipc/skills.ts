export type SkillCategory =
  | 'git'
  | 'code'
  | 'test'
  | 'docs'
  | 'refactor'
  | 'debug'
  | 'deploy'
  | 'custom';

export type SkillSource = 'builtin' | 'user' | 'workspace' | 'mcp';
export type DangerLevel = 'safe' | 'moderate' | 'dangerous';

export interface SkillHooks {
  PreToolUse?: string;
  PostToolUse?: string;
  Stop?: string;
}

export interface NeoxSkillExtension {
  category?: SkillCategory;
  aliases?: string[];
  requiredTools?: string[];
  allowedTools?: string[];
  dangerLevel?: DangerLevel;
  arguments?: Array<{ name: string; description: string; required?: boolean }>;
}

export interface SkillMetadata {
  name: string;
  description: string;
  /** 英文描述, 用于 UI i18n. 若缺失则消费端 fallback 到 description. */
  description_en?: string;
  dependencies?: string;
  context?: 'main' | 'fork';
  agent?: string;
  'user-invocable'?: boolean;
  hooks?: SkillHooks;
  neox?: NeoxSkillExtension;
}

export interface SkillInfo {
  id: string;
  path: string;
  source: SkillSource;
  metadata: SkillMetadata;
  content: string;
}

export interface SkillListOptions {
  category?: SkillCategory;
  source?: SkillSource;
  userInvocable?: boolean;
}

export interface SkillCreateOptions {
  id: string;
  name: string;
  description: string;
  category?: string;
  target: 'user' | 'workspace';
  /** SKILL.md 正文。创建表单里直接写, 不用保存完再进编辑页补。 */
  instructions?: string;
}

export interface SkillDirs {
  user: string;
  workspace: string;
}
