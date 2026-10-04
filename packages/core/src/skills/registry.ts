
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { fileURLToPath } from 'node:url';
import type { Skill, SkillListOptions, SkillSource } from '@neoxlabs/kernel/skills/types.js';
import { SkillLoader } from './loader.js';
import { getBakedSkills } from './bakedSkills.generated.js';

/** 数一个 skill 目录里都带了什么 —— 导入前把"附带内容"摆给用户看, 而不是让他导完再猜。
 *   分桶按约定目录名 (references/ scripts/ agents/), 其余算 other。SKILL.md 自己不计。 */
function summarizeSkillAssets(dir: string): { references: number; scripts: number; agents: number; other: number; bytes: number } {
  const out = { references: 0, scripts: 0, agents: 0, other: 0, bytes: 0 };
  const walk = (cur: string, top: string | null): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules' || e.name === '.DS_Store') continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        walk(full, top ?? e.name);
      } else if (e.isFile()) {
        if (top === null && e.name === 'SKILL.md') continue;
        try { out.bytes += fs.statSync(full).size; } catch { /* 读不到大小不影响计数 */ }
        const bucket = (top ?? '').toLowerCase();
        if (bucket === 'references' || bucket === 'reference' || bucket === 'docs') out.references += 1;
        else if (bucket === 'scripts' || bucket === 'script' || bucket === 'bin') out.scripts += 1;
        else if (bucket === 'agents' || bucket === 'agent') out.agents += 1;
        else out.other += 1;
      }
    }
  };
  walk(dir, null);
  return out;
}

/** 递归拷目录 —— skill 的 references/ scripts/ agents/ 必须跟着一起过来, 见 importFromPath 里的说明。 */
function copyDirRecursive(srcDir: string, destDir: string, skipTopLevel: string[] = []): void {
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (skipTopLevel.includes(entry.name)) continue;
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.DS_Store') continue;
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      copyDirRecursive(src, dest);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dest);
    }
    /* symlink 不跟随: 拷过来会是一条指向别人家的死链, 且可能指到目录外 */
  }
}
import { onUserIdChange } from '@neoxlabs/platform/utils/config.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

/** 烘焙快照里的 skill.path 前缀 — 不是真实磁盘路径, 只用于日志/UI 展示与去重身份. */
const BAKED_SKILLS_ORIGIN = '<baked: scripts/bake-skills.mjs>';


type SignalListener = () => void;
const skillsLoadedListeners = new Set<SignalListener>();

/** 订阅 skills 加载/变更事件 — 用于外部缓存清除 */
export function onSkillsLoaded(callback: SignalListener): () => void {
  skillsLoadedListeners.add(callback);
  return () => { skillsLoadedListeners.delete(callback); };
}

function emitSkillsLoaded(): void {
  skillsLoadedListeners.forEach(cb => { try { cb(); } catch (err: any) { cliLogger.debug('SKILLS', `Skills loaded listener failed: ${err?.message}`); } });
}


/**
 * 简易 gitignore 匹配器
 * 支持: *, **, ?, 目录分隔符
 */
function matchesGlob(pattern: string, filePath: string): boolean {
  // 使用占位符避免多轮替换冲突
  let regex = pattern
    .replace(/\*\*\//g, '\x00DSTAR_SLASH\x00')  // **/ 占位
    .replace(/\/\*\*/g, '\x00SLASH_DSTAR\x00')   // /** 占位
    .replace(/\*\*/g, '\x00DSTAR\x00')            // ** 占位
    .replace(/\./g, '\\.')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\x00DSTAR_SLASH\x00/g, '([^/]+/)*')   // **/ → 零或多层目录
    .replace(/\x00SLASH_DSTAR\x00/g, '(/.*)?')       // /** → 可选任意后缀
    .replace(/\x00DSTAR\x00/g, '.*');                 // ** → 任意

  // 处理目录末尾斜杠
  if (pattern.endsWith('/')) {
    regex = regex.slice(0, -1) + '(/.*)?';
  }

  try {
    return new RegExp(`^${regex}$`).test(filePath);
  } catch (err: any) {
    cliLogger.debug('SKILLS', `Gitignore pattern match failed: ${err?.message}`);
    return false;
  }
}

function matchesAnyPattern(patterns: string[], filePath: string, cwd: string): boolean {
  const relative = path.relative(cwd, filePath).replace(/\\/g, '/');
  return patterns.some(pattern => matchesGlob(pattern, relative));
}

/**
 * SkillRegistry 类 - 管理所有 skills 的注册和查找
 */
export class SkillRegistry {
  private skills = new Map<string, Skill>();
  private aliasIndex = new Map<string, string>();
  private loader = new SkillLoader();
  private initialized = false;
  /** 工作区技能已从哪个目录装过 —— initialize 幂等的依据不只是"初始化过", 还有"带没带工作区" */
  private loadedWorkDir: string | null = null;
  private watchers: fs.FSWatcher[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private watchWorkDir: string | undefined;

  private conditionalSkills = new Map<string, Skill>();
  private activatedConditionalNames = new Set<string>();
  private dynamicSkills = new Map<string, Skill>();

  private seenFileIdentities = new Set<string>();

  register(skill: Skill): void {
    if (skill.fileIdentity && this.seenFileIdentities.has(skill.fileIdentity)) {
      return; // 已通过不同路径加载过
    }
    if (skill.fileIdentity) {
      this.seenFileIdentities.add(skill.fileIdentity);
    }

    if (skill.metadata.paths && skill.metadata.paths.length > 0) {
      this.conditionalSkills.set(skill.id, skill);
      return; // 不加入 skills map，等碰到匹配文件再激活
    }

    // 记录内容长度
    skill.contentLength = skill.content.length;

    // 注册主 ID
    this.skills.set(skill.id, skill);

    // 注册别名
    if (skill.metadata.neox?.aliases) {
      for (const alias of skill.metadata.neox.aliases) {
        this.aliasIndex.set(alias, skill.id);
      }
    }
  }

  /**
   * 注销一个 skill
   */
  unregister(skillId: string): void {
    const skill = this.skills.get(skillId);
    if (!skill) return;

    // 移除别名
    if (skill.metadata.neox?.aliases) {
      for (const alias of skill.metadata.neox.aliases) {
        this.aliasIndex.delete(alias);
      }
    }

    // 移除主 ID
    this.skills.delete(skillId);
  }

  find(nameOrAlias: string): Skill | undefined {
    // 首先尝试直接查找
    const direct = this.skills.get(nameOrAlias);
    if (direct) return direct;

    const dynamic = this.dynamicSkills.get(nameOrAlias);
    if (dynamic) return dynamic;

    // 尝试通过别名查找
    const realId = this.aliasIndex.get(nameOrAlias);
    if (realId) {
      return this.skills.get(realId) || this.dynamicSkills.get(realId);
    }

    // 尝试模糊匹配（忽略大小写）
    const lowerName = nameOrAlias.toLowerCase();
    const allSkills = [...Array.from(this.skills.entries()), ...Array.from(this.dynamicSkills.entries())];
    for (const [id, skill] of allSkills) {
      if (id.toLowerCase() === lowerName) {
        return skill;
      }
      if (skill.metadata.name.toLowerCase() === lowerName) {
        return skill;
      }
    }

    return undefined;
  }

  /**
   * 检查 skill 是否存在
   */
  has(nameOrAlias: string): boolean {
    return this.find(nameOrAlias) !== undefined;
  }

  list(options?: SkillListOptions): Skill[] {
    // 合并常规 + 动态激活的 skill
    let skills = [
      ...Array.from(this.skills.values()),
      ...Array.from(this.dynamicSkills.values()),
    ];

    if (options?.category) {
      skills = skills.filter(
        (s) => s.metadata.neox?.category === options.category
      );
    }

    if (options?.source) {
      skills = skills.filter((s) => s.source === options.source);
    }

    if (options?.userInvocable !== undefined) {
      skills = skills.filter(
        (s) => (s.metadata['user-invocable'] !== false) === options.userInvocable
      );
    }

    if (options?.enabledOnly) {
      skills = skills.filter(
        (s) => !s.metadata.isEnabled || s.metadata.isEnabled()
      );
    }

    // 按 ID 排序
    return skills.sort((a, b) => a.id.localeCompare(b.id));
  }


  activateForPaths(filePaths: string[], cwd: string): string[] {
    const activated: string[] = [];

    const toActivate: string[] = [];
    this.conditionalSkills.forEach((skill, id) => {
      if (!skill.metadata.paths || skill.metadata.paths.length === 0) return;

      for (const fp of filePaths) {
        if (matchesAnyPattern(skill.metadata.paths, fp, cwd)) {
          toActivate.push(id);
          break;
        }
      }
    });

    for (const id of toActivate) {
      const skill = this.conditionalSkills.get(id)!;
      this.conditionalSkills.delete(id);
      this.dynamicSkills.set(id, skill);
      this.activatedConditionalNames.add(skill.metadata.name);
      // 注册别名
      if (skill.metadata.neox?.aliases) {
        for (const alias of skill.metadata.neox.aliases) {
          this.aliasIndex.set(alias, skill.id);
        }
      }
      activated.push(skill.metadata.name);
    }

    if (activated.length > 0) {
      emitSkillsLoaded();
    }

    return activated;
  }

  getAutoInjectBody(skillName: string): string | undefined {
    const MAX = 8000;
    for (const skill of this.dynamicSkills.values()) {
      if (skill.metadata.name !== skillName) continue;
      const body = (skill.content || '').trim();
      if (!body) return undefined;
      const clipped = body.length > MAX
        ? body.slice(0, MAX) + `\n\n… (正文 ${body.length} 字, 只注入了前 ${MAX} 字; 需要全文时调 use_skill("${skill.id}"))`
        : body;
      return clipped;
    }
    return undefined;
  }

  /** 获取待条件激活的 skill 数量 */
  get conditionalCount(): number {
    return this.conditionalSkills.size;
  }

  /** 获取已动态激活的 skill 数量 */
  get dynamicCount(): number {
    return this.dynamicSkills.size;
  }

  /**
   * 获取所有 skills 数量
   */
  get size(): number {
    return this.skills.size;
  }

  async loadBuiltin(): Promise<void> {
    const skills = await this.resolveBuiltinSkills();
    if (skills.length === 0) {
      throw new Error(
        '[skills] 内置技能加载结果为空 — 磁盘 builtin 目录和烘焙快照都没给出技能. ' +
          'dev 请确认 neox-core 的 skills/builtin 目录存在; 发行版说明 build 漏跑 scripts/bake-skills.mjs.',
      );
    }
    for (const skill of skills) {
      this.register(skill);
    }
  }

  private async resolveBuiltinSkills(): Promise<Skill[]> {
    const override = process.env.NEOX_BUILTIN_SKILLS_DIR;
    if (override) {
      if (!fs.existsSync(override)) {
        throw new Error(
          `[skills] NEOX_BUILTIN_SKILLS_DIR="${override}" 指向的目录不存在 — 拒绝静默回落, 请修正或删掉该变量.`,
        );
      }
      return this.loader.loadFromDirectory(override, 'builtin');
    }

    /* 打包/dev 都是相对本模块定位:
     *   tsup 产物: dist/cli/main.js  → ../skills/builtin = dist/skills/builtin (build-electron.js 会拷)
     *   tsx 源码:  src/skills/registry.ts → ../skills/builtin = src/skills/builtin */
    const here = path.dirname(fileURLToPath(import.meta.url));
    const builtinDir = path.join(here, '..', 'skills', 'builtin');
    if (fs.existsSync(builtinDir)) {
      const fromDisk = await this.loader.loadFromDirectory(builtinDir, 'builtin');
      /* 目录存在但一个技能都没解析出来 = 目录被 `!**\/*.md` 之类掏空了, 别当成"就是没有" */
      if (fromDisk.length > 0) return fromDisk;
      cliLogger.warn(
        'SKILLS',
        `builtin 目录存在但没解析出任何技能 (${builtinDir}) — 回退到烘焙快照`,
      );
    }

    const baked = getBakedSkills();
    return this.loader.loadFromSnapshot(baked, 'builtin', BAKED_SKILLS_ORIGIN);
  }

  async loadUser(): Promise<void> {
    const userDir = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'skills');
    migratePerUserSkillsToGlobal(userDir);
    const skills = await this.loader.loadFromDirectory(userDir, 'user');
    for (const skill of skills) {
      this.register(skill);
    }
  }

  async loadPlugins(): Promise<void> {
    const pluginsRoot = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'plugins');
    let registry: { plugins?: unknown };
    try {
      registry = JSON.parse(fs.readFileSync(path.join(pluginsRoot, 'registry.json'), 'utf-8'));
    } catch {
      return; /* 没装过插件 */
    }
    const plugins = Array.isArray(registry.plugins)
      ? registry.plugins
      : Object.values((registry.plugins ?? {}) as Record<string, unknown>);
    for (const p of plugins as Array<{ name?: string; enabled?: boolean; installPath?: string; manifest?: { skills?: unknown } }>) {
      if (!p?.enabled || !p.installPath || !Array.isArray(p.manifest?.skills)) continue;
      const installDir = path.resolve(p.installPath);
      for (const rel of p.manifest.skills) {
        if (typeof rel !== 'string') continue;
        const dir = path.resolve(installDir, rel);
        /* 清单里的路径不许跑出插件目录 */
        const inside = path.relative(installDir, dir);
        if (inside.startsWith('..') || path.isAbsolute(inside)) continue;
        try {
          for (const skill of await this.loader.loadFromDirectory(dir, 'plugin')) this.register(skill);
        } catch (err) {
          cliLogger.warn('SKILLS', `plugin ${p.name} skills 加载失败 (${dir}): ${(err as Error).message}`);
        }
      }
    }
  }

  /**
   * 加载工作区 skills
   */
  async loadWorkspace(workDir: string): Promise<void> {
    const workspaceDir = path.join(workDir, '.neox', 'skills');
    const skills = await this.loader.loadFromDirectory(
      workspaceDir,
      'workspace'
    );
    for (const skill of skills) {
      this.register(skill);
    }
  }

  /**
   * 初始化：加载所有 skills
   */
  async initialize(workDir?: string): Promise<void> {
    if (this.initialized) {
      if (workDir && this.loadedWorkDir !== workDir) {
        await this.loadWorkspace(workDir);
        this.loadedWorkDir = workDir;
      }
      return;
    }

    // 按优先级顺序加载（后加载的会覆盖先加载的同名 skill）: 内置 < 插件 < 用户 < 工作区
    await this.loadBuiltin();
    await this.loadPlugins();
    await this.loadUser();
    if (workDir) {
      await this.loadWorkspace(workDir);
      this.loadedWorkDir = workDir;
    }

    this.initialized = true;
  }

  /**
   * 刷新所有 skills
   */
  async refresh(workDir?: string): Promise<void> {
    this.skills.clear();
    this.aliasIndex.clear();
    this.conditionalSkills.clear();
    this.dynamicSkills.clear();
    this.seenFileIdentities.clear();
    this.initialized = false;
    const dir = workDir ?? this.loadedWorkDir ?? undefined;
    this.loadedWorkDir = null;
    await this.initialize(dir);
    emitSkillsLoaded();
  }

  /**
   * 启动热加载 — 监听 user 和 workspace skills 目录变更
   */
  watch(workDir?: string): void {
    this.watchWorkDir = workDir;
    const dirs = [
      this.getUserSkillsDir(),
      ...(workDir ? [this.getWorkspaceSkillsDir(workDir)] : []),
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const watcher = fs.watch(dir, { recursive: true }, (_event, _filename) => {
          this.scheduleRefresh();
        });
        this.watchers.push(watcher);
      } catch (err: any) {
        cliLogger.debug('SKILLS', `fs.watch recursive not supported: ${err?.message}`);
      }
    }
  }

  /**
   * 停止热加载
   */
  stopWatch(): void {
    for (const w of this.watchers) {
      w.close();
    }
    this.watchers = [];
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private scheduleRefresh(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(async () => {
      try {
        await this.refresh(this.watchWorkDir);
      } catch (err: any) {
        cliLogger.debug('SKILLS', `Skill refresh failed: ${err?.message}`);
      }
    }, 500);
  }

  getSkillsForPrompt(): string {
    const invocableSkills = this.list({ userInvocable: true, enabledOnly: true })
      .filter(s => !s.metadata.disableModelInvocation);

    if (invocableSkills.length === 0) {
      return '';
    }

    const lines: string[] = [];
    for (const skill of invocableSkills) {
      const aliases = skill.metadata.neox?.aliases;
      const aliasStr = aliases?.length ? ` (aliases: ${aliases.join(', ')})` : '';
      const modelStr = skill.metadata.model ? ` [model: ${skill.metadata.model}]` : '';
      const effortStr = skill.metadata.effort ? ` [effort: ${skill.metadata.effort}]` : '';
      const hintStr = skill.metadata.argumentHint ? ` ${skill.metadata.argumentHint}` : '';
      lines.push(`- /${skill.id}${hintStr}: ${skill.metadata.description}${aliasStr}${modelStr}${effortStr}`);
      if (skill.metadata.whenToUse) {
        lines.push(`  When to use: ${skill.metadata.whenToUse}`);
      }
    }

    return lines.join('\n');
  }

  getUnifiedCommands(): Array<{ name: string; description: string; source: SkillSource; skill: Skill }> {
    const seen = new Set<string>();
    const commands: Array<{ name: string; description: string; source: SkillSource; skill: Skill }> = [];

    // 优先级：dynamic > workspace > user > builtin
    const sources: Array<[Map<string, Skill>, SkillSource]> = [
      [this.dynamicSkills, 'workspace'],
      [this.skills, 'builtin'],
    ];

    for (const [map] of sources) {
      map.forEach((skill) => {
        if (skill.metadata.isEnabled && !skill.metadata.isEnabled()) return;

        if (!seen.has(skill.id)) {
          seen.add(skill.id);
          commands.push({
            name: skill.id,
            description: skill.metadata.description,
            source: skill.source,
            skill,
          });
        }
      });
    }

    return commands.sort((a, b) => a.name.localeCompare(b.name));
  }

  discoverExternalSkills(workDir?: string): Array<{
    id: string;
    name: string;
    description: string;
    path: string;
    source: string;
    /** 同名技能已经在 ~/.neox/skills 里了 */
    alreadyImported: boolean;
    /** 随技能一起过来的东西 —— 导入前让用户看清自己拿到的是什么 */
    assets: { references: number; scripts: number; agents: number; other: number; bytes: number };
  }> {
    const roots: Array<{ dir: string; source: string }> = [
      { dir: path.join(os.homedir(), '.claude', 'skills'), source: 'Claude Code' },
      { dir: path.join(os.homedir(), '.codex', 'skills'), source: 'Codex' },
    ];
    if (workDir) {
      roots.push({ dir: path.join(workDir, '.claude', 'skills'), source: 'Claude Code (项目)' });
      roots.push({ dir: path.join(workDir, '.codex', 'skills'), source: 'Codex (项目)' });
    }

    const userDir = this.getUserSkillsDir();
    const out: Array<{ id: string; name: string; description: string; path: string; source: string; alreadyImported: boolean; assets: { references: number; scripts: number; agents: number; other: number; bytes: number } }> = [];
    const seen = new Set<string>();

    for (const { dir, source } of roots) {
      let entries: fs.Dirent[];
      try {
        if (!fs.existsSync(dir)) continue;
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch { continue; }

      for (const entry of entries) {
        const skillDir = path.join(dir, entry.name);
        if (!entry.isDirectory()) {
          if (!entry.isSymbolicLink()) continue;
          try {
            if (!fs.statSync(skillDir).isDirectory()) continue;  /* 死链 / 链到文件 */
          } catch { continue; }
        }
        const mdPath = path.join(skillDir, 'SKILL.md');
        if (!fs.existsSync(mdPath)) continue;
        let name = entry.name;
        let description = '';
        try {
          const { metadata } = this.loader.parseSkillFile(fs.readFileSync(mdPath, 'utf-8'));
          if (typeof metadata.name === 'string' && metadata.name.trim()) name = metadata.name.trim();
          if (typeof metadata.description === 'string') description = metadata.description.trim();
        } catch { /* frontmatter 坏了也照样列出来, 让用户自己判断 */ }

        const id = this.generateSkillId(name);
        /* 同一个技能同时在 ~/.claude 和 ~/.codex 里 (用户两边都装了) — 只列一次,
         * 先扫到的赢 (roots 顺序 = 优先级)。 */
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          name,
          description,
          path: skillDir,
          source,
          alreadyImported: fs.existsSync(path.join(userDir, id)),
          assets: summarizeSkillAssets(skillDir),
        });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * 获取用户 skills 目录路径
   */
  getUserSkillsDir(): string {
    return path.join(os.homedir(), NEOX_HOME_DIRNAME, 'skills');
  }

  /**
   * 获取工作区 skills 目录路径
   */
  getWorkspaceSkillsDir(workDir: string): string {
    return path.join(workDir, '.neox', 'skills');
  }

  /**
   * 从URL导入 skill
   * @param url - SKILL.md 文件的 URL
   * @param target - 保存位置: 'user' (全局) 或 'workspace' (当前项目)
   * @param workDir - 工作目录 (当 target='workspace' 时必需)
   */
  async importFromUrl(
    url: string,
    target: 'user' | 'workspace',
    workDir?: string
  ): Promise<{ success: boolean; skillId?: string; error?: string }> {
    try {
      // 验证 URL
      const urlObj = new URL(url);

      // 下载内容
      const response = await fetch(url);
      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
      }
      const content = await response.text();

      // 解析内容获取 skill ID
      const { metadata } = this.loader.parseSkillFile(content);
      if (!metadata.name) {
        return { success: false, error: 'Invalid SKILL.md: missing name field' };
      }

      // 从 URL 或 name 生成 skill ID
      const skillId = this.generateSkillId(metadata.name as string);

      // 确定保存目录
      const targetDir = target === 'user'
        ? this.getUserSkillsDir()
        : this.getWorkspaceSkillsDir(workDir!);

      const skillDir = path.join(targetDir, skillId);

      // 创建目录并保存文件
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf-8');

      // 加载并注册
      const skill = await this.loader.loadSkill(skillDir, skillId, target);
      this.register(skill);

      return { success: true, skillId };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * 从本地路径导入 skill
   * @param sourcePath - SKILL.md 文件或包含 SKILL.md 的目录路径
   * @param target - 保存位置: 'user' (全局) 或 'workspace' (当前项目)
   * @param workDir - 工作目录 (当 target='workspace' 时必需)
   */
  async importFromPath(
    sourcePath: string,
    target: 'user' | 'workspace',
    workDir?: string
  ): Promise<{ success: boolean; skillId?: string; error?: string }> {
    try {
      const resolvedPath = path.resolve(sourcePath);

      // 检查是文件还是目录
      const stat = fs.statSync(resolvedPath);
      let skillMdPath: string;
      let sourceDir: string;

      if (stat.isDirectory()) {
        skillMdPath = path.join(resolvedPath, 'SKILL.md');
        sourceDir = resolvedPath;
      } else {
        skillMdPath = resolvedPath;
        sourceDir = path.dirname(resolvedPath);
      }

      if (!fs.existsSync(skillMdPath)) {
        return { success: false, error: `SKILL.md not found at ${skillMdPath}` };
      }

      // 读取并解析
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      const { metadata } = this.loader.parseSkillFile(content);
      if (!metadata.name) {
        return { success: false, error: 'Invalid SKILL.md: missing name field' };
      }

      const skillId = this.generateSkillId(metadata.name as string);

      // 确定保存目录
      const targetDir = target === 'user'
        ? this.getUserSkillsDir()
        : this.getWorkspaceSkillsDir(workDir!);

      const destDir = path.join(targetDir, skillId);

      // 复制整个目录
      fs.mkdirSync(destDir, { recursive: true });

      // 复制 SKILL.md
      fs.copyFileSync(skillMdPath, path.join(destDir, 'SKILL.md'));

      copyDirRecursive(sourceDir, destDir, ['SKILL.md']);

      // 加载并注册
      const skill = await this.loader.loadSkill(destDir, skillId, target);
      this.register(skill);

      return { success: true, skillId };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * 创建新 skill
   * @param options - 创建选项
   */
  async createSkill(options: {
    id: string;
    name: string;
    description: string;
    category?: string;
    target: 'user' | 'workspace';
    workDir?: string;
    /** SKILL.md 正文 (Instructions 段)。不传就写占位模板 —— 见下面的说明。 */
    instructions?: string;
  }): Promise<{ success: boolean; path?: string; error?: string }> {
    try {
      const { id, name, description, category, target, workDir, instructions } = options;

      // 验证 ID
      if (!/^[a-z][a-z0-9-]*$/.test(id)) {
        return {
          success: false,
          error: 'Skill ID must start with lowercase letter and contain only lowercase letters, numbers, and hyphens'
        };
      }

      // 检查是否已存在
      if (this.has(id)) {
        return { success: false, error: `Skill '${id}' already exists` };
      }

      // 确定保存目录
      const targetDir = target === 'user'
        ? this.getUserSkillsDir()
        : this.getWorkspaceSkillsDir(workDir!);

      const skillDir = path.join(targetDir, id);

      if (fs.existsSync(skillDir)) {
        return { success: false, error: `Directory already exists: ${skillDir}` };
      }

      const body = (instructions ?? '').trim();
      const instructionsSection = body || (
        '请在此处编写技能的具体指令...'
      );
      const skillContent = `---
name: "${name}"
description: "${description}"
user-invocable: true
neox:
  category: ${category || 'custom'}
  aliases: []
---

## Overview

${description}

## Instructions

${instructionsSection}

## Examples

\`\`\`
用户: /${id}
AI: [技能执行结果]
\`\`\`
`;

      // 创建目录和文件
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillContent, 'utf-8');

      // 加载并注册
      const skill = await this.loader.loadSkill(skillDir, id, target);
      this.register(skill);

      return { success: true, path: skillDir };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  readSkillRaw(skillId: string): { success: boolean; content?: string; path?: string; error?: string } {
    try {
      const skill = this.find(skillId);
      if (!skill) return { success: false, error: `Skill '${skillId}' not found` };
      if (!skill.path) return { success: false, error: `Skill '${skillId}' 没有磁盘路径 (内置技能烘焙在包里)` };
      return { success: true, content: fs.readFileSync(skill.path, 'utf-8'), path: skill.path };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async writeSkillContent(
    skillId: string,
    content: string,
    workDir?: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const skill = this.find(skillId);
      if (!skill) return { success: false, error: `Skill '${skillId}' not found` };
      if (skill.source === 'builtin') {
        return { success: false, error: '内置技能不可编辑 (随包发布, 磁盘上没有明文)' };
      }
      const filePath = skill.path;
      if (!filePath || path.basename(filePath) !== 'SKILL.md') {
        return { success: false, error: `Skill '${skillId}' 没有可写的 SKILL.md 路径` };
      }
      const roots = [this.getUserSkillsDir()];
      if (workDir) roots.push(this.getWorkspaceSkillsDir(workDir));
      const real = fs.realpathSync(path.dirname(filePath));
      const inside = roots.some((root) => {
        let r: string;
        try { r = fs.realpathSync(root); } catch { return false; }
        return real === r || real.startsWith(r + path.sep);
      });
      if (!inside) {
        return { success: false, error: `拒绝写入技能目录之外的路径: ${filePath}` };
      }
      fs.writeFileSync(filePath, content, 'utf-8');
      /* 重新解析并替换注册表里的那份, 否则列表/详情还是旧内容 */
      try {
        const reloaded = await this.loader.loadSkill(path.dirname(filePath), skillId, skill.source);
        this.register(reloaded);
      } catch (e) {
        /* 写进去了但解析不了 (比如 frontmatter 被改坏) —— 告诉用户, 别假装成功 */
        return { success: false, error: `已写入, 但解析失败: ${e instanceof Error ? e.message : String(e)}` };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 删除 skill
   */
  async deleteSkill(skillId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const skill = this.find(skillId);
      if (!skill) {
        return { success: false, error: `Skill '${skillId}' not found` };
      }

      if (skill.source === 'builtin') {
        return { success: false, error: 'Cannot delete built-in skills' };
      }

      // 删除文件
      const skillDir = path.dirname(skill.path);
      fs.rmSync(skillDir, { recursive: true, force: true });

      // 从注册表移除
      this.unregister(skillId);

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * 从名称生成合法的 skill ID
   */
  private generateSkillId(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
  }
}

// 单例实例
export const skillRegistry = new SkillRegistry();

/** 一次性迁移: ~/.neox/users/<uid>/skills/ 并回全局 ~/.neox/skills/
 *  (同名不覆盖, 全局优先; 并空后删源目录, 幂等)。 */
let _skillsMigrated = false;
function migratePerUserSkillsToGlobal(globalDir: string): void {
  if (_skillsMigrated) return;
  _skillsMigrated = true;
  const usersRoot = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'users');
  let buckets: string[] = [];
  try { buckets = fs.readdirSync(usersRoot); } catch { return; }
  for (const bucket of buckets) {
    const src = path.join(usersRoot, bucket, 'skills');
    let entries: string[] = [];
    try { entries = fs.readdirSync(src); } catch { continue; }
    try { fs.mkdirSync(globalDir, { recursive: true }); } catch { /* noop */ }
    let remaining = 0;
    for (const name of entries) {
      const from = path.join(src, name);
      const to = path.join(globalDir, name);
      try {
        if (fs.existsSync(to)) { remaining++; continue; }
        fs.renameSync(from, to);
      } catch {
        try { fs.cpSync(from, to, { recursive: true }); fs.rmSync(from, { recursive: true, force: true }); }
        catch { remaining++; }
      }
    }
    if (remaining === 0) {
      try { fs.rmSync(src, { recursive: true, force: true }); } catch { /* noop */ }
    }
    if (entries.length > 0) {
      cliLogger.info('SKILLS', `并桶迁移 users/${bucket}/skills → 全局 (${entries.length - remaining}/${entries.length} 项)`);
    }
  }
}

let _skillsRefreshing: Promise<void> | null = null;
onUserIdChange((next, prev) => {
  void next; void prev;
  if (_skillsRefreshing) return;
  _skillsRefreshing = skillRegistry.refresh()
    .catch((err) => { cliLogger.warn('SKILLS', `refresh after user switch failed: ${err?.message || err}`); })
    .finally(() => { _skillsRefreshing = null; });
});
