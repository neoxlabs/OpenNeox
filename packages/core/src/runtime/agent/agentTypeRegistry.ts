
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import { setCustomAgentTypes } from './agentTypes.js';

// ─── Frontmatter 解析 (支持 .md agent 定义) ───

/**
 * 解析 `.md` agent 定义: YAML frontmatter + body.
 *
 * 格式:
 * ```
 * ---
 * name: my-agent
 * description: 我的 agent
 * tools: [readfile, grep]
 * model: gpt-4
 * maxTurns: 20
 * ---
 * <systemPromptPrefix 内容 (body 全部)>
 * ```
 *
 * 为避免引入 yaml 依赖, 只支持有限子集:
 *   - `key: value` (scalar)
 *   - `key: [a, b, c]` (inline array)
 *   - `key:\n  - a\n  - b` (block array)
 *   - `#` 开头行视为注释
 *   - 字符串可加引号 "..." / '...', 也可不加
 */
function parseMdAgentDefinition(filePath: string): Record<string, any> {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) {
    throw new Error('Missing YAML frontmatter delimited by "---"');
  }
  const [, frontmatter, body] = match;
  const result: Record<string, any> = parseSimpleYaml(frontmatter);
  const trimmedBody = body.trim();
  if (trimmedBody && !result.systemPromptPrefix && !result.system_prompt_prefix) {
    result.systemPromptPrefix = trimmedBody;
  }
  return result;
}

function stripQuotes(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function coerceScalar(v: string): any {
  const t = v.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  return stripQuotes(t);
}

function parseSimpleYaml(src: string): Record<string, any> {
  const result: Record<string, any> = {};
  const lines = src.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) { i++; continue; }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) { i++; continue; }
    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1).trim();

    if (rest === '') {
      // block array: 下面的缩进 `- item`
      const arr: any[] = [];
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (!next.startsWith(' ') && !next.startsWith('\t')) break;
        const t = next.trim();
        if (t.startsWith('- ')) arr.push(coerceScalar(t.slice(2)));
        else if (t === '-') { /* empty item skip */ }
        else break;
        i++;
      }
      result[key] = arr;
      continue;
    }

    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      result[key] = inner === '' ? [] : inner.split(',').map(s => coerceScalar(s));
    } else {
      result[key] = coerceScalar(rest);
    }
    i++;
  }
  return result;
}

// ─── Agent 类型定义 ───

export interface AgentTypeDefinition {
  /** 类型名称（唯一标识） */
  name: string;
  /** 描述 */
  description: string;
  /** 何时使用 */
  whenToUse?: string;
  /** 允许的工具列表 */
  tools?: string[];
  /** 禁止的工具列表 */
  disallowedTools?: string[];
  /** 模型覆盖 */
  model?: string;
  /** 底座内置类型 (code/shell/plan/research/verify/online) —— 决定工具集和提示骨架。
   *  缺省 code。写 shell 就等于"这个角色能跑命令"。 */
  base?: string;
  /** 最大迭代次数 */
  maxTurns?: number;
  /** 是否默认后台执行 */
  background?: boolean;
  /** 系统提示前缀 */
  systemPromptPrefix?: string;
  /** 来源 */
  source: 'builtin' | 'user' | 'workspace' | 'plugin';
  /** 来源插件名 (source = 'plugin' 时) */
  pluginName?: string;
}

// ─── 内置 Agent 类型 ───

const BUILTIN_AGENTS: AgentTypeDefinition[] = [
  {
    name: 'explorer',
    description: 'Read-only code exploration agent. Searches, reads, and analyzes code but never modifies files.',
    whenToUse: 'When you need to understand code structure, find patterns, or research how something works without making changes.',
    tools: ['readfile', 'read_file', 'glob', 'grep'],
    disallowedTools: ['write_file', 'edit_file', 'execute_shell'],
    maxTurns: 30,
    source: 'builtin',
  },
  {
    name: 'coder',
    description: 'Full-capability coding agent. Can read, write, edit files and run shell commands.',
    whenToUse: 'When you need to implement features, fix bugs, or make code changes.',
    maxTurns: 50,
    source: 'builtin',
  },
  {
    name: 'reviewer',
    description: 'Code review agent. Analyzes code quality, security, and best practices. Read-only.',
    whenToUse: 'When you need a code review, security audit, or quality check.',
    tools: ['readfile', 'read_file', 'glob', 'grep'],
    disallowedTools: ['write_file', 'edit_file', 'execute_shell'],
    maxTurns: 20,
    source: 'builtin',
  },
  {
    name: 'tester',
    description: 'Test writing and execution agent. Can write test files and run test suites.',
    whenToUse: 'When you need to write tests, run test suites, or verify functionality.',
    maxTurns: 30,
    source: 'builtin',
  },
];

// ─── Agent 类型注册表 ───

export class AgentTypeRegistry {
  private types = new Map<string, AgentTypeDefinition>();
  private watchers: fs.FSWatcher[] = [];
  private watchWorkDir?: string;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // 注册内置类型
    for (const agent of BUILTIN_AGENTS) {
      this.types.set(agent.name, agent);
    }
  }

  /** 注册 agent 类型 */
  register(definition: AgentTypeDefinition): void {
    this.types.set(definition.name, definition);
    this.publish();
  }

  private publish(): void {
    const custom = this.list()
      .filter(t => t.source !== 'builtin')
      .map(t => ({
        name: t.name,
        description: t.description,
        whenToUse: t.whenToUse,
        base: t.base,
        tools: t.tools,
        disallowedTools: t.disallowedTools,
        model: t.model,
        maxTurns: t.maxTurns,
        systemPromptPrefix: t.systemPromptPrefix,
        source: t.source as 'user' | 'workspace' | 'plugin',
      }));
    const { accepted, rejected } = setCustomAgentTypes(custom);
    if (rejected.length > 0) {
      /* 撞内置 id 的直接拒 —— 一个 md 文件不该能悄悄改掉 'code' 每天在用的工具集。
       * 但必须说出来: 静默丢弃的话用户只会看到"我的 agent 怎么没生效"。 */
      cliLogger.warn('AGENT_TYPE', `这些自定义 agent 没生效 (名字跟内置类型冲突, 换个名字): ${rejected.join(', ')}`);
    }
    if (accepted.length > 0) {
      cliLogger.info('AGENT_TYPE', `自定义 agent 已生效: ${accepted.join(', ')}`);
    }
    this.warnUnknownModels(custom);
  }

  /** 角色文件里写的模型现在能不能用 —— **加载时**就说, 不要等到派发那一刻。
   *
   *  派发时也有一道 (agentTool 会直接报错不跑), 但那太晚了: 用户是在写角色文件的时候
   *  打错的字, 隔几小时真派出去才发现, 中间那几小时他以为配好了。
   *  这里只警告不拒绝 —— 模型清单可能只是这一刻拉不到 (订阅缓存冷 / provider 还没初始化),
   *  因为一时列不出来就把角色作废是更糟的失败方式。 */
  private warnUnknownModels(specs: Array<{ name: string; model?: string }>): void {
    const wanted = specs.filter(s => s.model);
    if (wanted.length === 0) return;
    const known = this.knownModelIds?.();
    /* 列不出来就别判 —— 拿一个空清单去判"都不认识"会把每个角色都报一遍假警 */
    if (!known || known.size === 0) return;
    const bad = wanted.filter(s => !known.has(String(s.model)));
    if (bad.length === 0) return;
    cliLogger.warn(
      'AGENT_TYPE',
      `这些角色写的模型现在用不了, 派出去会直接报错: ${bad.map(s => `${s.name} → ${s.model}`).join(' / ')}`
      + `。当前可用: ${[...known].slice(0, 12).join(', ')}${known.size > 12 ? ' …' : ''}`,
    );
  }

  /** 由运行时装上 —— 注册表本身不该知道模型是从订阅还是 BYOK 来的。
   *  没装 = 不做这项校验 (CLI 早期 boot、SDK 等场景), 不是报错。 */
  knownModelIds?: () => Set<string>;

  /** 获取 agent 类型 */
  get(name: string): AgentTypeDefinition | undefined {
    return this.types.get(name);
  }

  /** 列出所有类型 */
  list(): AgentTypeDefinition[] {
    return Array.from(this.types.values());
  }

  /** 获取类型数量 */
  get size(): number {
    return this.types.size;
  }

  /**
   * 从目录加载 agent 类型定义（JSON 文件）
   *
   * 文件格式：
   * ```json
   * {
   *   "name": "my-agent",
   *   "description": "Custom agent",
   *   "tools": ["readfile", "grep"],
   *   "model": "gpt-4",
   *   "maxTurns": 10
   * }
   * ```
   */
  async loadFromDirectory(
    dir: string,
    source: 'user' | 'workspace' | 'plugin',
    pluginName?: string,
  ): Promise<number> {
    if (!fs.existsSync(dir)) return 0;

    let loaded = 0;
    const stat = fs.statSync(dir);

    // 支持传入单个文件 (插件 manifest 可能直接指向 .md / .json)
    const candidates: string[] = [];
    if (stat.isFile()) {
      candidates.push(dir);
    } else {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.json') && !entry.name.endsWith('.md')) continue;
        candidates.push(path.join(dir, entry.name));
      }
    }

    for (const filePath of candidates) {
      try {
        const raw = filePath.endsWith('.md')
          ? parseMdAgentDefinition(filePath)
          : JSON.parse(fs.readFileSync(filePath, 'utf-8'));

        if (!raw.name || !raw.description) {
          cliLogger.warn('AGENT_TYPE', `Invalid agent type (missing name/description): ${filePath}`);
          continue;
        }

        this.register({
          name: raw.name,
          description: raw.description,
          whenToUse: raw.whenToUse ?? raw.when_to_use,
          tools: raw.tools,
          disallowedTools: raw.disallowedTools ?? raw.disallowed_tools,
          model: raw.model,
          base: raw.base ?? raw.baseType ?? raw.base_type,
          maxTurns: raw.maxTurns ?? raw.max_turns,
          background: raw.background,
          systemPromptPrefix: raw.systemPromptPrefix ?? raw.system_prompt_prefix,
          source,
          pluginName: source === 'plugin' ? pluginName : undefined,
        });
        loaded++;
      } catch (err: any) {
        cliLogger.warn('AGENT_TYPE', `Failed to load ${filePath}: ${err.message}`);
      }
    }

    return loaded;
  }

  /** 移除某插件注册的所有 agent 类型 (卸载 / disable 时用). */
  unregisterPlugin(pluginName: string): number {
    let removed = 0;
    for (const [name, def] of [...this.types.entries()]) {
      if (def.source === 'plugin' && def.pluginName === pluginName) {
        this.types.delete(name);
        removed++;
      }
    }
    /* 卸载也要推 —— 否则插件已经禁用了, 主 agent 的类型清单里还挂着它的角色,
     * 派出去就是 Unknown agent type。 */
    if (removed > 0) this.publish();
    return removed;
  }

  /**
   * 初始化 — 加载用户和工作区 agent 类型
   */
  async initialize(workDir?: string): Promise<void> {
    /* 切工作区会再调一次 —— 先把上一个工作区的角色清掉, 否则 A 项目的 auditor
     * 会跟着你切到 B 项目, 而 B 里根本没有那个文件。插件注册的不动 (它们不属于工作区)。 */
    for (const [name, def] of [...this.types.entries()]) {
      if (def.source === 'user' || def.source === 'workspace') this.types.delete(name);
    }

    const userDir = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'agents');
    await this.loadFromDirectory(userDir, 'user');

    if (workDir) {
      const workspaceDir = path.join(workDir, '.neox', 'agents');
      await this.loadFromDirectory(workspaceDir, 'workspace');
    }
    /* 目录里一个文件都没有时 loadFromDirectory 不会 register, 也就不会 publish;
     * 而"上一个工作区有、这个没有"恰恰要靠这一发把运行时那侧清空。 */
    this.publish();
  }

  /** 目录热加载 —— 跟 skills 同一套做法 (见 skills/registry.ts 的 watch)。
   *
   *  改一次 .neox/agents/auditor.md 就要重启一次应用, 等于没人会去调它。
   *  角色文件本来就是要反复试出来的: 改一句提示、换个模型、收一收工具集,
   *  每次都重启的话第二次就没人改了。 */
  watch(workDir?: string): void {
    this.stopWatch();
    this.watchWorkDir = workDir;
    const dirs = [
      path.join(os.homedir(), NEOX_HOME_DIRNAME, 'agents'),
      ...(workDir ? [path.join(workDir, '.neox', 'agents')] : []),
    ];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        this.watchers.push(fs.watch(dir, { recursive: true }, () => this.scheduleRefresh()));
      } catch (err: any) {
        cliLogger.debug('AGENT_TYPE', `fs.watch 不可用: ${err?.message}`);
      }
    }
  }

  stopWatch(): void {
    for (const w of this.watchers) { try { w.close(); } catch { /* 已经关了 */ } }
    this.watchers = [];
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
  }

  /* 编辑器保存一次会连发好几个事件 (写临时文件 → rename), 不 debounce 就是连着重扫几遍 */
  private scheduleRefresh(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      void this.initialize(this.watchWorkDir).catch((err) => {
        cliLogger.warn('AGENT_TYPE', `热加载失败, 保持上一份: ${err?.message || err}`);
      });
    }, 300);
  }

  /**
   * 生成 agent 类型列表（供 LLM 系统提示使用）
   */
  getAgentTypesForPrompt(): string {
    const types = this.list();
    if (types.length === 0) return '';

    const lines = ['## Available Agent Types', ''];
    for (const t of types) {
      const modelStr = t.model ? ` [model: ${t.model}]` : '';
      const turnsStr = t.maxTurns ? ` [max ${t.maxTurns} turns]` : '';
      const bgStr = t.background ? ' [background]' : '';
      lines.push(`- **${t.name}**: ${t.description}${modelStr}${turnsStr}${bgStr}`);
      if (t.whenToUse) {
        lines.push(`  When to use: ${t.whenToUse}`);
      }
    }

    return lines.join('\n');
  }
}

// ─── 全局单例 ───

export const agentTypeRegistry = new AgentTypeRegistry();
