/**
 * ToolPack — 工具包架构定义
 *
 * 设计理念：
 *   每个 ToolPack 是一个独立的功能领域（如 git、neox_config、database...）
 *   通过 ToolPackRegistry 统一注册和发现
 *   LLM 通过 tool_search 按需加载工具包，不污染常驻上下文
 *
 * 架构层次：
 *   Layer 0: 常驻工具（search, readfile, edit_file...） — 始终可见
 *   Layer 1: tool_search — 关键词/pack/工具名搜索，返回完整 schema
 *   Layer 2: call_tool — 代理执行 Layer 1 发现的工具
 *
 * 缓存友好: tools 数组固定不变 → 前缀缓存 100% 命中
 *
 * 扩展方式：
 *   1. 创建新文件 src/tools/packs/xxx.pack.ts
 *   2. 实现 ToolPack 接口
 *   3. 在 ToolPackRegistry 中注册
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import type { AgentMode } from '@neoxlabs/platform/runtime/agentMode.js';

// ==================== 核心接口 ====================

/**
 * 工具可见性层级
 *
 * primary:  在 tool_search 目录中优先展示，描述详细
 * extended: 在 tool_search 目录中展示，描述简短
 * hidden:   不在目录中展示，只有精确查询才能发现
 */
export type ToolPackTier = 'primary' | 'extended' | 'hidden';

/**
 * 工具包定义
 */
export interface ToolPack {
    /** 唯一标识（用于 tool_search 查询） */
    id: string;

    /** 显示名称 */
    label: string;

    /** 图标 emoji */
    icon: string;

    /** 给 LLM 看的简短描述（一行，出现在 tool_search 目录中） */
    description: string;

    toolNames: string[];

    /**
     * tool_search 解锁这个包时, **实际交给模型**的工具名。不填 = 等于 toolNames。
     *
     * 用途: 一个包里既有"给模型直接调的"又有"只给别的工具当指令集的"。
     * 例: browser 包 55 个工具全部归类在 toolNames (否则会泄漏成常驻), 但解锁时只交
     * browser_run + 感知工具; 其余 40 多个单步工具留在 toolMap 里由 browser_run 本地调用
     * —— 模型每步往返 22.2 秒 vs 工具本身 93ms, 单步工具一旦在模型手里就必然被一步一调。
     */
    unlockToolNames?: string[];

    /**
     * 提前预判 (Jev 加持) 命中这个包时预解锁的入口工具。不填 = 等于 unlockToolNames。
     * 大包 (browser / word 十几个工具) 只给头几个最常用的, 其余照旧 tool_search 拉 ——
     * 解锁名额一共 15 个, 整包预解锁会把 tool_search 的位子占光。
     */
    preloadToolNames?: string[];

    /**
     * 一句话说这个包用来做**哪类事** (Jev 加持的分类器只看这句, 不填就截 description 前 140 字)。
     * description 是写给模型的用法说明 (browser 那段讲的是 browser_run 怎么一次跑完整个脚本),
     * 拿它去判「这条消息要不要浏览器」, 淘宝/12306/后台导出这类没写网址的任务全判不上。
     */
    useFor?: string;

    /**
     * 点到包里任何一个工具 (tool_search 命中 / 模型直调点名解锁), 整包一起进 liveTools。
     *
     * 用途: 一条流程由同包几个工具串起来, 第一步之后紧跟着就要下一步 —— 比如团队规划
     * team_run → team_roster → team_member_review → team_claim。只解锁被点名的那个,
     * 模型对后面几步手里没有 schema, 只能凭名字猜参数 (见 feedback: 别让模型猜我们的参数名)。
     */
    unlockTogether?: boolean;

    /** 分组标签（用于在目录中分组显示） */
    group: ToolPackGroup;

    /** 可见性层级 — 决定在 tool_search 目录中的展示方式 */
    tier?: ToolPackTier;

    /** 搜索关键词（扩展模糊匹配命中率） */
    keywords?: string[];

    /**
     * 用途模式硬白名单 — 本 pack 在哪些模式下可用。
     * undefined = 全模式可用。模式外的工具从 allTools 直接裁掉:
     * tool_search 搜不到、call_tool 调不了、子 agent 也继承不到 (单一收口)。
     * 见 filterToolsByAgentMode / 内部设计文档 §3
     */
    modes?: AgentMode[];

    /** 是否为内置包（内置不可删除） */
    builtin?: boolean;

    /** 版本号 */
    version?: string;

    /** 工具创建函数（懒加载，只在 tool_search 选中时才创建） */
    createTools?: () => Tool[] | Promise<Tool[]>;
}

/**
 * 工具包分组
 */
export type ToolPackGroup =
    | 'core'        // 核心：文件、搜索、执行
    | 'vcs'         // 版本控制：git
    | 'web'         // 网络：抓取、搜索、浏览器
    | 'agent'       // Agent：子任务、协作
    | 'platform'    // 平台管理：Neox 配置、MCP
    | 'devops'      // DevOps：Docker、CI/CD、部署
    | 'data'        // 数据：数据库、API
    | 'community';  // 社区：用户自定义

// 分组元数据
export const TOOL_PACK_GROUPS: Record<ToolPackGroup, { label: string; icon: string; order: number }> = {
    core: { label: '核心工具', icon: '◆', order: 0 },
    vcs: { label: '版本控制', icon: '◇', order: 1 },
    web: { label: '网络', icon: '◈', order: 2 },
    agent: { label: 'Agent', icon: '●', order: 3 },
    platform: { label: '平台', icon: '○', order: 4 },
    devops: { label: 'DevOps', icon: '▪', order: 5 },
    data: { label: '数据', icon: '▫', order: 6 },
    community: { label: '扩展', icon: '◌', order: 7 },
};

// ==================== 注册表 ====================

function validatePack(pack: ToolPack): string[] {
    const errs: string[] = [];
    if (!pack || typeof pack !== 'object') return ['pack must be an object'];
    if (!pack.id || typeof pack.id !== 'string' || pack.id.length < 2) {
        errs.push(`pack.id must be a string of length >=2 (got ${JSON.stringify(pack.id)})`);
    }
    if (!pack.label || typeof pack.label !== 'string') errs.push('pack.label missing');
    if (!pack.icon || typeof pack.icon !== 'string') errs.push('pack.icon missing');
    if (!pack.description || typeof pack.description !== 'string') errs.push('pack.description missing');
    else if (pack.description.length < 10) errs.push(`pack.description too short (${pack.description.length} chars)`);
    if (!pack.group || typeof pack.group !== 'string') errs.push('pack.group missing');
    if (!Array.isArray(pack.toolNames)) errs.push('pack.toolNames must be array');
    else {
        if (pack.toolNames.length === 0) errs.push('pack.toolNames empty');
        for (const tn of pack.toolNames) {
            if (typeof tn !== 'string' || !/^[a-z][a-z0-9_]*$/i.test(tn)) {
                errs.push(`toolName "${tn}" violates pattern [a-zA-Z][a-zA-Z0-9_]*`);
            }
        }
    }
    return errs;
}

function isStrictMode(): boolean {
    return (globalThis as any).process?.env?.NEOX_DEBUG === '1'
        || (globalThis as any).process?.env?.NEOX_STRICT_TOOL_REGISTRY === '1';
}

export class ToolPackRegistry {
    private packs = new Map<string, ToolPack>();
    /** toolName → 第一个 declare 它的 pack id (用于跨 pack 冲突检测) */
    private toolOwnership = new Map<string, string>();

    /** 注册工具包。结构非法在 NEOX_DEBUG=1 时抛错, 否则 warn 后跳过。 */
    register(pack: ToolPack): void {
        const errs = validatePack(pack);
        if (errs.length > 0) {
            const msg = `[ToolPackRegistry] invalid pack "${pack?.id}": ${errs.join('; ')}`;
            if (isStrictMode()) throw new Error(msg);
            // eslint-disable-next-line no-console
            console.warn(msg);
            return;
        }
        if (this.packs.has(pack.id)) {
            // eslint-disable-next-line no-console
            console.warn(`[ToolPackRegistry] pack id "${pack.id}" already registered — overwriting (hot reload?)`);
            /* 旧 pack 的 toolName 占用要先释放, 否则新 pack 的 toolName 显示为冲突 */
            const prev = this.packs.get(pack.id)!;
            for (const tn of prev.toolNames) {
                if (this.toolOwnership.get(tn) === prev.id) this.toolOwnership.delete(tn);
            }
        }
        for (const tn of pack.toolNames) {
            const owner = this.toolOwnership.get(tn);
            if (owner && owner !== pack.id) {
                /* 跨 pack 冲突: 先注册的保持所有权, 当前 pack 仍存但 findPackForTool 返回先者 */
                const msg = `[ToolPackRegistry] toolName "${tn}" in pack "${pack.id}" conflicts with "${owner}" — keeping "${owner}"`;
                if (isStrictMode()) throw new Error(msg);
                // eslint-disable-next-line no-console
                console.warn(msg);
            } else {
                this.toolOwnership.set(tn, pack.id);
            }
        }
        this.packs.set(pack.id, pack);
    }

    /** 批量注册 */
    registerAll(packs: ToolPack[]): void {
        for (const pack of packs) {
            this.register(pack);
        }
    }

    /** 获取工具包 */
    get(id: string): ToolPack | undefined {
        return this.packs.get(id);
    }

    /**
     * 按 id 取 pack, 并认插件目录里的短名。
     *
     *   插件多了之后目录会折叠成来源名 (`google-calendar`), 模型按提示去
     *   tool_search({ pack: "google-calendar" }), 但注册 id 是
     *   `connector:google-calendar`。只认精确 id 时, 工具明明在表上也会回
     *   "Pack not found"。
     */
    resolve(id: string): ToolPack | undefined {
        if (!id) return undefined;
        const direct = this.packs.get(id);
        if (direct) return direct;
        const trimmed = id.replace(/^(plugin|connector|extagent):/, '');
        if (!trimmed) return undefined;
        for (const prefix of ['connector:', 'plugin:', 'extagent:'] as const) {
            const hit = this.packs.get(`${prefix}${trimmed}`);
            if (hit) return hit;
        }
        return undefined;
    }

    /** 获取所有工具包 */
    getAll(): ToolPack[] {
        return Array.from(this.packs.values());
    }

    /** 反注册 (插件 disable / uninstall 时用) */
    unregister(id: string): boolean {
        const pack = this.packs.get(id);
        if (pack) {
            for (const tn of pack.toolNames) {
                if (this.toolOwnership.get(tn) === id) this.toolOwnership.delete(tn);
            }
        }
        return this.packs.delete(id);
    }

    /** 移除 id 前缀匹配的所有包 (批量反注册插件) */
    unregisterByPrefix(prefix: string): number {
        let n = 0;
        for (const id of [...this.packs.keys()]) {
            if (id.startsWith(prefix)) {
                this.unregister(id);
                n++;
            }
        }
        return n;
    }

    /** 按分组获取工具包 */
    getByGroup(group: ToolPackGroup): ToolPack[] {
        return this.getAll().filter(p => p.group === group);
    }

    /** 获取分组后的所有工具包（用于 select_tools 目录显示） */
    getGrouped(): Map<ToolPackGroup, ToolPack[]> {
        const grouped = new Map<ToolPackGroup, ToolPack[]>();
        for (const pack of this.packs.values()) {
            const list = grouped.get(pack.group) || [];
            list.push(pack);
            grouped.set(pack.group, list);
        }
        return grouped;
    }

    getAllToolNames(): string[] {
        const seen = new Set<string>();
        const ordered: string[] = [];
        for (const pack of this.packs.values()) {
            for (const tn of pack.toolNames) {
                if (seen.has(tn)) continue;
                seen.add(tn);
                ordered.push(tn);
            }
        }
        return ordered;
    }

    /** 根据工具名查找所属工具包 — 用 toolOwnership map O(1) 查找,
     *  跨 pack 冲突时返回先注册者 (跟 register() 的 warn 一致)。 */
    findPackForTool(toolName: string): ToolPack | undefined {
        const owner = this.toolOwnership.get(toolName);
        if (owner) return this.packs.get(owner);
        /* 兜底: 极端情况下 toolOwnership 没填 (老代码直接改 packs Map 绕过 register), 退回线性扫 */
        for (const pack of this.packs.values()) {
            if (pack.toolNames.includes(toolName)) return pack;
        }
        return undefined;
    }

    /** 生成目录文本（给 select_tools 用） */
    formatCatalog(): string {
        // 紧凑格式：每个 pack 一行，展示工具名让 LLM 能精准查单个工具
        const lines: string[] = [];
        for (const pack of this.packs.values()) {
            const tools = pack.toolNames.join(', ');
            lines.push(`${pack.id}: ${tools}`);
        }
        return lines.join('\n');
    }

    /** 统计信息 */
    getStats(): { packCount: number; toolCount: number; groups: number } {
        return {
            packCount: this.packs.size,
            toolCount: this.getAllToolNames().length,
            groups: new Set(Array.from(this.packs.values()).map(p => p.group)).size,
        };
    }
}

// ==================== 全局单例 ====================

export const toolPackRegistry = new ToolPackRegistry();

/**
 * Agent runtime (尤其是桌面 worker) 在组 ToolTreeEngine 之前要先把本进程的
 * 插件 pack 装上。主进程的 bootstrap 到不了 worker 那份 toolPackRegistry,
 * 不接这个钩子就会出现「设置页已连接、模型 tool_search 却说没有」。
 *
 * 宿主在 worker 入口 set 一次; 没 set 就是 no-op (CLI / 单测)。
 */
type RuntimePluginBootstrap = () => void | Promise<void>;
let runtimePluginBootstrap: RuntimePluginBootstrap | null = null;

export function setRuntimePluginBootstrap(fn: RuntimePluginBootstrap | null): void {
    runtimePluginBootstrap = fn;
}

export async function ensureRuntimePluginsLoaded(): Promise<void> {
    if (!runtimePluginBootstrap) return;
    try {
        await runtimePluginBootstrap();
    } catch (err: any) {
        // eslint-disable-next-line no-console
        console.warn(`[PLUGIN] runtime plugin bootstrap failed: ${err?.message ?? err}`);
    }
}

// ==================== 用途模式硬白名单 ====================

export function filterToolsByAgentMode(tools: Tool[], mode: AgentMode): Tool[] {
    if (mode === 'code') return tools;
    return tools.filter(tool => {
        const pack = toolPackRegistry.findPackForTool(tool.name);
        if (!pack?.modes) return true;
        return pack.modes.includes(mode);
    });
}
