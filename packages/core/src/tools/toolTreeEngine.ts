
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { TOOL_CATEGORIES, getToolCategories, ALWAYS_ACTIVE_TOOLS, type ToolCategory } from './toolTree.js';
import { toolPackRegistry, type ToolPack, type ToolPackTier } from './packs/toolPack.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
/* 必填参数校验与 schema 文本的唯一实现 —— runner (直连调用) 与这里 (call_tool 派发)
 * 共用一份, 免得两边漂移。详见 kernel 的 toolArgsGuard 文件头。 */
import { findMissingRequiredArgs, buildMissingRequiredArgsMessage, formatToolSchemaForModel } from '@neoxlabs/kernel/core/toolArgsGuard.js';
import { runWithTargetSession } from './targetModeTools.js';

/**
 * 允许经 call_tool 直调的 browser_* —— 只有"看"和"会话管理"。
 * 其余单步动作 (navigate/click/type/eval/wait/…) 一律改道 browser_run:
 * 一步一次模型往返 22.2 秒 vs 脚本里 14ms, 差 1500 倍。
 */
const BROWSER_STEP_TOOL_EXEMPT = new Set([
  'browser_run',
  /* 看 */
  'browser_get_aria_tree', 'browser_screenshot', 'browser_get_state',
  'browser_query', 'browser_get_text', 'browser_get_bbox', 'browser_get_full_dom',
  /* 会话 / 诊断 / 登录态 —— 天然一次一个 */
  'browser_list_surfaces', 'browser_diagnose',
  'browser_export_storage_state', 'browser_import_storage_state', 'browser_sync_daily_logins',
  'browser_get_console_logs', 'browser_get_network', 'browser_get_response_body',
  'browser_get_cookies', 'browser_get_local_storage',
]);

/** Target Mission tools — session-scoped state; must run under ALS when dispatched via call_tool. */
const TARGET_SESSION_TOOLS = new Set([
  'activate_target',
  'plan_target',
  'plan_block',
  'check_target_done',
  'abandon_target',
  'pause_target',
  'continue_target',
]);

function isSafeToDispatchUngated(tool: Tool): boolean {
  if (tool.isReadOnly !== true) return false;
  const perm = (tool as { permission?: { defaultPermission?: string } }).permission;
  const dp = perm?.defaultPermission;
  /* 没写 defaultPermission 的只读工具视为安全 (只读 + 无策略要求);
     写了但不是 allow 的, 说明作者认为需要过闸 → 无闸就不许派发。 */
  return dp === undefined || String(dp).toLowerCase() === 'allow';
}

export class ToolTreeEngine {
  /** 所有工具 name → Tool */
  private toolMap = new Map<string, Tool>();
  /** 类别定义 */
  private categories: ToolCategory[];
  /** 调用方显式传入 categories 时不再跟 registry 同步 */
  private readonly categoriesFrozen: boolean;
  /** 常驻工具名 */
  private alwaysActive: Set<string>;

  readonly liveTools: Tool[];
  /**
   * 本 session 已解锁 (promote 进 liveTools) 的 deferred 工具名 → 最近一次被用到的序号。
   * Map 而不是 Set: 到顶时要按"最久没用"淘汰 (见 promote)。
   */
  private readonly unlocked = new Map<string, number>();
  /** 单调递增的使用序号 —— 只用来排先后, 不看时间 (避免同毫秒并列)。 */
  private useTick = 0;
  private static readonly MAX_UNLOCKED = 15;

  private decorateTool?: (tool: Tool) => Tool;

  private liteTool: Tool | null;
  private onEscalate?: () => void;

  constructor(tools: Tool[], options?: {
    categories?: ToolCategory[];
    alwaysActive?: Set<string>;
    decorateTool?: (tool: Tool) => Tool;
    /** 给了就以轻档起步, 见 liteTool */
    liteTool?: Tool;
    /** 离开轻档时调一次 (不管是谁触发的: 升级工具 / 点名工具 / 预解锁) */
    onEscalate?: () => void;
    liveTarget?: Tool[];
  }) {
    this.liveTools = options?.liveTarget ?? [];
    this.decorateTool = options?.decorateTool;
    this.liteTool = options?.liteTool ?? null;
    this.onEscalate = options?.onEscalate;
    this.categoriesFrozen = !!options?.categories;
    this.categories = options?.categories ?? getToolCategories();
    this.alwaysActive = options?.alwaysActive ?? ALWAYS_ACTIVE_TOOLS;

    for (const tool of tools) {
      this.toolMap.set(tool.name, tool);
    }

    this.hydrateDynamicPacks();

    this.buildLiveTools();

    cliLogger.info('TOOL_TREE', `Initialized v3: ${tools.length} total, ${this.liveTools.length} live (${this.alwaysActive.size} always + 2 meta)`);
  }

  /**
   * 把 registry 里动态 pack (插件 / connector) 的工具补进 toolMap。
   *
   *   runtime 的工具数组是**构造时**定下的 (collectRuntimeTools), 而插件可能更晚
   *   才注册 —— 不补的话三连死: 目录被 packLine 滤掉、tool_search 拉不到、
   *   call_tool 也找不到。构造时捞一次; tool_search 再捞一次, 好接「本轮会话
   *   中途装上的插件」。
   */
  private hydrateDynamicPacks(): void {
    if (!this.categoriesFrozen) {
      this.categories = getToolCategories();
    }
    for (const pack of toolPackRegistry.getAll()) {
      const missing = pack.toolNames.filter(n => !this.toolMap.has(n));
      if (missing.length === 0 || typeof pack.createTools !== 'function') continue;
      try {
        const created = pack.createTools();
        /* createTools 允许返回 Promise, 但这里不能 await —— 异步的那种由调用方
         * 自己把工具传进来, 这里只捞同步可得的 (插件路径都是同步返回固定数组) */
        if (!Array.isArray(created)) {
          cliLogger.warn('TOOL_TREE', `pack "${pack.id}" createTools is async — its tools stay invisible`);
          continue;
        }
        for (const tool of created) {
          if (!this.toolMap.has(tool.name)) this.toolMap.set(tool.name, tool);
        }
      } catch (err: any) {
        cliLogger.warn('TOOL_TREE', `pack "${pack.id}" createTools failed: ${err?.message ?? err}`);
      }
    }
  }

  /** 还在轻档 (只有升级工具)。 */
  get isLite(): boolean {
    return this.liteTool !== null;
  }

  /** 离开轻档, 原地换成满档工具集 (runner 持的是同一个数组)。已是满档返回 false。 */
  escalate(): boolean {
    if (!this.liteTool) return false;
    this.liteTool = null;
    this.buildLiveTools();
    cliLogger.info('TOOL_TREE', `escalated from lite: ${this.liveTools.length} live`);
    this.onEscalate?.();
    return true;
  }

  private buildLiveTools(): void {
    this.liveTools.length = 0;
    const decorate = (tool: Tool) => (this.decorateTool ? this.decorateTool(tool) : tool);

    if (this.liteTool) {
      this.liveTools.push(decorate(this.liteTool));
      return;
    }

    // 1. 常驻工具（完整注册，原生 function calling）
    for (const name of this.alwaysActive) {
      const tool = this.toolMap.get(name);
      if (tool) this.liveTools.push(decorate(tool));
    }

    // 2. 未分类的工具也直接注册（不在任何 category 里的 → 安全网）
    const allCategorized = new Set<string>();
    for (const cat of this.categories) {
      for (const n of cat.toolNames) allCategorized.add(n);
    }
    for (const [name, tool] of this.toolMap) {
      if (!this.alwaysActive.has(name) && !allCategorized.has(name)) {
        this.liveTools.push(decorate(tool));
      }
    }

    // 3. 已解锁的 deferred 工具 (tool_search 命中后 promote 进来, 见 promote())
    //    排在元工具之前、按解锁顺序追加 —— 顺序稳定, 不会让已有前缀反复重排。
    for (const name of this.unlocked.keys()) {
      if (this.alwaysActive.has(name)) continue;
      const tool = this.toolMap.get(name);
      if (!tool) continue;
      const decorated = decorate(tool);
      /* 记一笔"用过" —— LRU 淘汰要按真实使用, 不能只按解锁先后 (promote 对已解锁的工具
       * 不会再被调用, 光靠 promote 计时的话正在高频使用的工具反而先被淘汰)。 */
      this.liveTools.push(this.withUseTracking(name, decorated));
    }

    // 4. tool_search 元工具 (替代 v2 的 select_tools)
    this.liveTools.push(this.buildToolSearchTool());

    // 5. call_tool 元工具 (target_* 经它派发, 要 session 作用域)
    this.liveTools.push(decorate(this.buildCallTool()));
  }

  promote(names: string[]): string[] {
    /* 轻档里有人要具体工具 (模型点名 / Jev 晚到的预判) = 要干活了, 先升满档再解锁 */
    if (this.liteTool && names.some((n) => this.toolMap.has(n))) this.escalate();
    const added: string[] = [];
    const evicted: string[] = [];
    /* unlockTogether 的包: 点到其中一个就整包进来 (见 ToolPack.unlockTogether) */
    const wanted: string[] = [];
    for (const name of names) {
      if (!wanted.includes(name)) wanted.push(name);
      const pack = toolPackRegistry.findPackForTool(name);
      if (!pack?.unlockTogether) continue;
      for (const sibling of pack.unlockToolNames ?? pack.toolNames) {
        if (!wanted.includes(sibling)) wanted.push(sibling);
      }
    }
    for (const name of wanted) {
      if (this.alwaysActive.has(name) || this.unlocked.has(name)) continue;
      if (!this.toolMap.has(name)) continue;
      /* 到顶 → 淘汰最久没用的一个腾位子 (绝不拒绝: 见 MAX_UNLOCKED 注释)。
       * 本轮刚解锁的不参与淘汰, 否则同一批 promote 会自己踢自己。 */
      if (this.unlocked.size >= ToolTreeEngine.MAX_UNLOCKED) {
        let victim: string | null = null;
        let oldest = Infinity;
        for (const [n, tick] of this.unlocked) {
          if (added.includes(n)) continue;
          if (tick < oldest) { oldest = tick; victim = n; }
        }
        if (!victim) break;              // 一整批都是本轮新解的 → 这批已经占满, 停手
        this.unlocked.delete(victim);
        evicted.push(victim);
      }
      this.unlocked.set(name, ++this.useTick);
      added.push(name);
    }
    if (added.length > 0) {
      /* liveTools 是 runner 持有的同一个数组引用, 必须原地重建而不是换新数组 */
      this.buildLiveTools();
      cliLogger.info('TOOL_TREE', `promoted ${added.length} tool(s) to live: ${added.join(', ')}`
        + (evicted.length > 0 ? ` (LRU 淘汰: ${evicted.join(', ')})` : '')
        + ` (unlocked=${this.unlocked.size}/${ToolTreeEngine.MAX_UNLOCKED})`);
    }
    return added;
  }

  /** 把某个已解锁工具标记为"刚用过" —— LRU 排序依据。 */
  private touch(name: string): void {
    if (this.unlocked.has(name)) this.unlocked.set(name, ++this.useTick);
  }

  /** 给已解锁工具套一层"用过就记一笔"的壳; 不改变任何行为。 */
  private withUseTracking(name: string, tool: Tool): Tool {
    const original = tool.function;
    /* 形状不对的工具原样放行 —— 记 LRU 是优化, 绝不能因此把一个能用的工具搞坏 */
    if (typeof original !== 'function') return tool;
    return {
      ...tool,
      function: (args: any, context?: any) => {
        this.touch(name);
        return original(args, context);
      },
    } as Tool;
  }

  /** 已解锁的工具名, 按解锁先后 (= liveTools 里的排列顺序)。下一轮的工具树照这个顺序接上, 前缀不变。 */
  getUnlockedInOrder(): string[] {
    return [...this.unlocked.keys()];
  }

  /** 诊断/测试用 — 当前已解锁的工具名 (按最近使用从旧到新)。 */
  getUnlockedTools(): string[] {
    return [...this.unlocked.entries()].sort((a, b) => a[1] - b[1]).map(([n]) => n);
  }

  // ============================================================================
  // tool_search — 关键词/pack/工具名搜索
  // ============================================================================

  private buildToolSearchTool(): Tool {
    const self = this;

    // 构建紧凑目录 — 按 tier 分层
    const catalog = self.buildCatalog();

    return {
      name: 'tool_search',
      description: `Unlock deferred tools. Whatever this returns becomes directly callable by name on your next step — no wrapper.

Three query modes:
  - select:foo,bar       → fetch these exact tools by name (fastest, when you saw names below)
  - keyword              → fuzzy search across tool name/description/pack (top 15 by relevance)
  - { pack: "git" }      → load all tools in a pack at once

Unlock everything you expect to need in ONE call (e.g. { pack: "git" }), then just use the tools.
The tool list below is what's available right now; the names are real — pick from these, don't invent.

${catalog}`,
      parameters: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'Either "select:name1,name2,..." for exact fetch, or a fuzzy keyword like "git branch" / "debug breakpoint".',
          },
          pack: {
            type: 'string',
            description: 'Pack ID to load all tools in that pack (e.g. "git", "quality", "debug", "memory")',
          },
          tools: {
            type: 'array',
            items: { type: 'string' },
            description: 'Exact tool names array — equivalent to query: "select:..." (e.g. ["git_branch", "run_tests"])',
          },
        },
      },
      isReadOnly: true,
      group: 'agent',
      parallelSafety: 'safe',

      async function(args: { query?: string; pack?: string; tools?: string[] }) {
        /* 会话中途才注册的 connector pack, 构造时的那一次 hydrate 捞不到 */
        self.hydrateDynamicPacks();
        let { query, pack, tools: toolNames } = args;
        const results: Tool[] = [];
        const alreadyShown = new Set<string>();
        const notFound: string[] = [];

        /* `select:a,b,c` 语法糖 — 对齐 CC 的 ToolSearchTool, model 习惯这一套.
         * 把 query 拆成 toolNames 走 Mode 2 (精确名查), 不进 fuzzy. */
        if (query) {
          const selectMatch = query.match(/^\s*select\s*:\s*(.+)$/i);
          if (selectMatch) {
            const requested = selectMatch[1]!
              .split(',')
              .map(s => s.trim())
              .filter(Boolean);
            toolNames = toolNames ? [...toolNames, ...requested] : requested;
            query = undefined; // 已转成精确查询, 不再走 fuzzy
          }
        }

        // Mode 1: Pack 批量加载
        if (pack) {
          const packDef = toolPackRegistry.resolve(pack);
          if (!packDef) {
            return `Pack "${pack}" not found.\n\nAvailable packs:\n${self.buildCatalog()}`;
          }
          /* unlockToolNames: 包里可能有一部分工具只是"给别的工具当指令集"的, 不该交到
           * 模型手里 (见 toolPack.ts 的说明和 browser 包的实例)。不填就等于全给。 */
          for (const name of (packDef.unlockToolNames ?? packDef.toolNames)) {
            const tool = self.toolMap.get(name);
            if (tool && !alreadyShown.has(name)) {
              results.push(tool);
              alreadyShown.add(name);
            }
          }
        }

        // Mode 2: 精确工具名
        if (toolNames) {
          for (const name of toolNames) {
            if (alreadyShown.has(name)) continue;
            const tool = self.toolMap.get(name);
            if (tool) {
              results.push(tool);
              alreadyShown.add(name);
            } else {
              notFound.push(name);
            }
          }
        }

        // Mode 3: 关键词模糊搜索
        if (query) {
          const q = query.toLowerCase();
          const candidates: Array<{ tool: Tool; score: number; pack?: ToolPack }> = [];

          for (const [name, tool] of self.toolMap) {
            if (alreadyShown.has(name)) continue;
            if (self.alwaysActive.has(name)) continue; // 常驻工具不需要搜

            let score = 0;
            // 工具名匹配 (权重最高)
            if (name.toLowerCase().includes(q)) score += 10;
            if (name.toLowerCase() === q) score += 5; // 精确匹配加分
            // 描述匹配
            if (tool.description.toLowerCase().includes(q)) score += 3;

            // pack 匹配
            const p = toolPackRegistry.findPackForTool(name);
            if (p) {
              if (p.id.toLowerCase().includes(q)) score += 8;
              if (p.label.toLowerCase().includes(q)) score += 5;
              if (p.keywords?.some(k => k.toLowerCase().includes(q))) score += 6;
              // tier 加权: primary 略优先
              if (p.tier === 'primary') score += 1;
            }

            if (score > 0) {
              candidates.push({ tool, score, pack: p ?? undefined });
            }
          }

          candidates.sort((a, b) => b.score - a.score);
          const top = candidates.slice(0, 15);

          for (const { tool } of top) {
            if (!alreadyShown.has(tool.name)) {
              results.push(tool);
              alreadyShown.add(tool.name);
            }
          }
        }

        // 格式化输出
        const parts: string[] = [];

        if (results.length > 0) {
          const promoted = self.promote(results.map((t) => t.name));
          parts.push(`Found ${results.length} tool(s):\n`);
          for (const tool of results) {
            parts.push(formatToolSchemaForModel(tool));
          }
          if (promoted.length > 0) {
            parts.push(
              `\n✅ Now callable directly as normal tools (no wrapper needed): ${promoted.join(', ')}.`
              + `\nJust call them by name on your next step. (call_tool({ name, args }) still works as a fallback.)`,
            );
          } else {
            parts.push(`\nUse call_tool({ name: "tool_name", args: {...} }) to execute.`);
          }
        }

        if (notFound.length > 0) {
          parts.push(`\nNot found: ${notFound.join(', ')}`);
        }

        if (results.length === 0 && notFound.length === 0) {
          parts.push(`No tools matched "${query || pack || ''}".`);
          parts.push(`\nAvailable packs:\n${self.buildCatalog()}`);
        }

        cliLogger.info('TOOL_TREE', `tool_search: query=${query || ''} pack=${pack || ''} tools=${toolNames?.join(',') || ''} → ${results.length} results`);
        return parts.join('\n');
      },
    };
  }

  // ============================================================================
  // call_tool — 代理执行
  // ============================================================================

  private buildCallTool(): Tool {
    const self = this;

    return {
      name: 'call_tool',
      description: `Execute a tool discovered via tool_search. Pass the tool name and arguments.`,
      parameters: {
        type: 'object' as const,
        properties: {
          name: {
            type: 'string',
            description: 'Tool name (from tool_search results)',
          },
          args: {
            type: 'object',
            description: 'Tool arguments (as described in tool_search schema)',
            additionalProperties: true,
          },
        },
        required: ['name'],
      },

      isConcurrencySafe(args: any): boolean {
        const inner = self.toolMap.get(String(args?.name || ''));
        if (!inner) return false; // 工具名都不认识 → 保守串行

        const innerArgs = (args?.args ?? {}) as Record<string, unknown>;
        /* 被包工具自己有参数敏感判定 (如 readfile 大文件不并发) → 尊重它 */
        if (inner.isConcurrencySafe) {
          try {
            return inner.isConcurrencySafe(innerArgs);
          } catch {
            return false;
          }
        }
        if (inner.parallelSafety === 'unsafe') return false;
        if (inner.parallelSafety === 'safe') return true;
        return inner.isReadOnly === true;
      },

      async function(callArgs: any, context?: {
        signal?: AbortSignal;
        toolCallId?: string;
        sessionId?: string;
        checkNestedToolGate?: (
          tool: Tool,
          args: Record<string, unknown>,
        ) => Promise<{ allowed: boolean; reason?: string }>;
      }) {
        const { name, args = {} } = callArgs;
        const tool = self.toolMap.get(name);

        if (typeof name === 'string' && name.startsWith('browser_')
            && !BROWSER_STEP_TOOL_EXEMPT.has(name) && self.toolMap.has('browser_run')) {
          cliLogger.info('TOOL_TREE', `call_tool: 把 ${name} 改道到 browser_run`);
          return JSON.stringify({
            precondition: 'use_browser_run',
            guidance:
              `Don't drive the browser one step at a time — each single step costs a full model `
              + `round-trip (~20s), while the same action inside a browser_run script takes ~14ms. `
              + `Put "${name.replace(/^browser_/, '')}" and the steps around it into ONE browser_run call: `
              + `{ steps: [ { action: "...", args: {...}, expectChange: {...} }, ... ] }. `
              + `Give every page-changing step an expectChange so "clicked but nothing happened" `
              + `fails loudly instead of silently. Perception tools (get_aria_tree / query / screenshot / `
              + `get_state) are still fine to call directly when you need to LOOK before writing the script.`,
          });
        }

        if (!tool) {
          /* 工具名拼错是 model 自己的失误, 不是 runtime 内部错误.
           * 不带 [ERROR] 前缀, 避免 model 误把自己的输入错误归类成"工具内部错误".
           * 列出最近候选名, 引导 model 自我纠正. */
          cliLogger.warn('TOOL_TREE', `call_tool: unknown tool "${name}"`);
          const reqTokens = String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1);
          const scored = Array.from(self.toolMap.entries()).map(([toolName, t]) => {
            const nameTokens = new Set(toolName.toLowerCase().split(/[^a-z0-9]+/));
            const desc = (t.description || '').toLowerCase();
            let score = 0;
            for (const tok of reqTokens) {
              if (nameTokens.has(tok)) score += 2;
              else if (desc.includes(tok)) score += 1;
            }
            return { toolName, score };
          }).filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
          const suggestText = scored.length > 0
            ? ` Did you mean: ${scored.map(s => s.toolName).join(', ')}?`
            : '';
          return `Tool "${name}" not registered.${suggestText} Run tool_search({ query: "..." }) to discover available tools.`;
        }

        const missing = findMissingRequiredArgs(tool, args);
        if (missing.length > 0) {
          return buildMissingRequiredArgsMessage(tool, missing);
        }

        if (context?.checkNestedToolGate) {
          const gate = await context.checkNestedToolGate(tool, args as Record<string, unknown>);
          if (!gate.allowed) {
            cliLogger.warn('TOOL_TREE', `call_tool: ${name} 被安全闸拦截: ${gate.reason ?? 'denied'}`);
            return `Tool "${name}" was blocked before execution: ${gate.reason ?? 'permission denied by user or policy'}`;
          }
        } else if (!isSafeToDispatchUngated(tool)) {
          cliLogger.warn('TOOL_TREE',
            `call_tool: ${name} 被拒 — 当前调用路径没有安全闸 (fail-closed)`);
          return `Tool "${name}" was blocked: this dispatch path has no permission gate wired, `
            + `so only read-only tools may be dispatched. Call "${name}" directly instead of through call_tool.`;
        }

        cliLogger.info('TOOL_TREE', `call_tool: ${name}`, { args: JSON.stringify(args).substring(0, 200) });

        try {
          /* Target Mission 状态按 session 分片; call_tool 直调 toolMap 里的裸 function
           * 时若没有 ALS, 会落到被其它 buildRunner 改写过的 _fallbackSessionId.
           * runner 注入的 sessionId (或外层已包的 ALS) 在这里再钉一次. */
          const invoke = () => tool.function(args, context);
          const sid = typeof context?.sessionId === 'string' ? context.sessionId : null;
          if (sid && TARGET_SESSION_TOOLS.has(name)) {
            return await runWithTargetSession(sid, invoke);
          }
          return await invoke();
        } catch (error: any) {
          cliLogger.error('TOOL_TREE', `call_tool: ${name} threw`, { error: error.message, stack: error.stack });
          return `[ERROR] ${name}: ${error.message}`;
        }
      },
    };
  }

  // ============================================================================
  // 辅助方法
  // ============================================================================

  private buildCatalog(): string {
    const packs = toolPackRegistry.getAll();
    const primary = packs.filter(p => (p.tier ?? 'primary') === 'primary');
    const extended = packs.filter(p => p.tier === 'extended');

    const packLine = (pack: ToolPack): string | null => {
      const names = pack.toolNames.filter(n =>
        this.toolMap.has(n) && !this.alwaysActive.has(n),
      );
      if (names.length === 0) return null;
      return `  · ${pack.id} (${names.length}): ${names.join(', ')}`;
    };

    const lines: string[] = ['Deferred tools by pack — these names are canonical and the only ones call_tool accepts (tool_search({pack}) loads a whole pack):'];
    for (const pack of primary) {
      const line = packLine(pack);
      if (line) lines.push(line);
    }

    /* 插件带来的 pack **不列工具名**, 只报来源。
     *
     *   目录是常驻的 —— 每请求都要付钱。内置 pack 数量由我们控制, 插件不是: 用户装
     *   100 个的时候, 每 pack 一行列全名就是数千 token 常驻, 而那个规模下把几百个
     *   工具名摊开模型也扫不动, 花了钱买不到发现性。
     *
     *   而且本来就不需要: 关键词模糊搜 (Mode 3) 扫的是整个 toolMap, 插件工具一直
     *   搜得到; 搜到之后 call_tool 直接调。目录里留来源名, 只是为了让模型把
     *   「存到 Notion」跟「有个 notion 来源」连上, 知道该去搜 —— 这一行就够了。 */
    const isPluginPack = (id: string) =>
      id.startsWith('plugin:') || id.startsWith('connector:') || id.startsWith('extagent:');
    const pluginPacks = extended.filter(p => isPluginPack(p.id));
    const builtinExtended = extended.filter(p => !isPluginPack(p.id));

    if (builtinExtended.length > 0) {
      lines.push('Extended (domain):');
      for (const pack of builtinExtended) {
        const line = packLine(pack);
        if (line) lines.push(line);
      }
    }

    if (pluginPacks.length > 0) {
      const pluginLines = this.buildPluginCatalogLines(pluginPacks, packLine);
      if (pluginLines.length > 0) {
        lines.push('Plugins (installed — 用户装的, 优先用它们而不是自己 shell 摸索):');
        lines.push(...pluginLines);
      }
    }

    return lines.join('\n');
  }

  private buildPluginCatalogLines(
    pluginPacks: ToolPack[],
    packLine: (p: ToolPack) => string | null,
  ): string[] {
    const BUDGET_CHARS = 400;

    const full = pluginPacks.map(packLine).filter((l): l is string => l !== null);
    if (full.length === 0) return [];
    if (full.join('\n').length <= BUDGET_CHARS) return full;

    /* 放不下就退到只列来源 —— 这时候插件已经多到列全名也没人扫得动了 */
    const sources: string[] = [];
    for (const p of pluginPacks) {
      const n = p.toolNames.filter(t => this.toolMap.has(t) && !this.alwaysActive.has(t)).length;
      if (n > 0) sources.push(p.id.replace(/^(plugin|connector|extagent):/, ''));
    }

    let listed = sources;
    let suffix = '';
    while (listed.length > 1 && listed.join(', ').length > BUDGET_CHARS) {
      listed = listed.slice(0, -1);
      suffix = ` +${sources.length - listed.length}`;
    }
    return [
      `  · ${listed.join(', ')}${suffix}`,
      '  · 装了很多插件, 上面只列来源 —— tool_search({pack:"<来源>"}) 取具体工具名',
    ];
  }

  /**
   * 获取状态摘要
   */
  getStatus(): { total: number; live: number; categories: number; packs: number } {
    return {
      total: this.toolMap.size,
      live: this.liveTools.length,
      categories: this.categories.length,
      packs: toolPackRegistry.getAll().length,
    };
  }
}
