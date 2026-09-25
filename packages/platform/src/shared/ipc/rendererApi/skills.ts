type SkillCreateOptions = import('../../ipc.js').SkillCreateOptions;
type SkillDirs = import('../../ipc.js').SkillDirs;
type SkillInfo = import('../../ipc.js').SkillInfo;
type SkillListOptions = import('../../ipc.js').SkillListOptions;

export interface RendererAPISkills {
  // ==================== Skills 管理 ====================
  skillsList: (options?: SkillListOptions) => Promise<SkillInfo[]>;
  skillsGet: (skillId: string) => Promise<SkillInfo | null>;
  skillsRefresh: () => Promise<void>;
  skillsCreate: (options: SkillCreateOptions) => Promise<{ success: boolean; path?: string; error?: string }>;
  skillsDelete: (skillId: string) => Promise<{ success: boolean; error?: string }>;
  skillsImportUrl: (url: string, target: 'user' | 'workspace') => Promise<{ success: boolean; skillId?: string; error?: string }>;
  skillsImportPath: (sourcePath: string, target: 'user' | 'workspace') => Promise<{ success: boolean; skillId?: string; error?: string }>;
  /** 扫 Claude Code / Codex 的 skill 目录 (只读). 导入仍走 skillsImportPath。 */
  skillsDiscoverExternal: () => Promise<Array<{
    id: string;
    name: string;
    description: string;
    path: string;
    source: string;
    alreadyImported: boolean;
    assets: { references: number; scripts: number; agents: number; other: number; bytes: number };
  }>>;
  /** 读技能的 SKILL.md 原文 (含 frontmatter)。SkillInfo.content 是解析后的正文, 不能拿来存回去。 */
  skillsReadRaw: (skillId: string) => Promise<{ success: boolean; content?: string; path?: string; error?: string }>;
  /** 覆写技能的 SKILL.md。不走通用 writeFile —— 那个是工作区作用域的, 用户级技能在它之外。 */
  skillsWriteContent: (skillId: string, content: string) => Promise<{ success: boolean; error?: string }>;
  skillsGetDirs: () => Promise<SkillDirs>;
}
