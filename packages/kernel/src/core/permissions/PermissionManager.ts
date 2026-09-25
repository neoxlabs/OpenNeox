/**
 * Permission Manager - 工具权限管理系统
 *
 * 职责：
 * 1. 管理工具权限配置
 * 2. 检查工具是否允许执行
 * 3. 请求用户 approval
 * 4. 记忆用户的权限决策
 */

import type { Tool } from '../../types/index.js';
import type { ApprovalMode } from '../../types/configTypes.js';
import {
  ToolPermission,
  ToolCategory,
  type ToolPermissionConfig,
  type PermissionDecision,
  type PermissionMemory,
} from '../../types/permissions.js';
import {
  evaluateToolRisk,
  isHighRiskLevel,
  type ToolRiskAssessment,
} from '../toolRiskEvaluator.js';
import { getApprovalCache, type ApprovalKey } from './approvalCache.js';
import { getKernelConfig } from '../kernelConfigBridge.js';
import { cliLogger } from '../../platform/cliLogger.js';
import { NEOX_HOME_DIRNAME } from '../../platform/neoxHome.js';

/** "Always Allow" 永久记忆的固定 scope. 用户勾 remember 时强制写这个 scope,
 *  跟 sessionId 解耦, 所有会话共享, 配合 persistencePath 写盘后 daemon 重启不丢. */
const ALWAYS_ALLOW_SCOPE = '__always__';

/**
 * "Always Allow" 的持久化后端由宿主注入，kernel 本身不访问磁盘。
 * 不传 storage 时没有持久化；需要落盘的宿主显式提供 storage 实现。
 */
export interface PermissionMemoryStorage {
  /** 启动时读回。文件不存在 / 解析失败一律返回 null, 不要抛。 */
  load(): Record<string, PermissionMemory> | null;
  /** 覆盖写。宿主自己负责原子性 (临时文件 + rename)。 */
  save(entries: Record<string, PermissionMemory>): void;
}

/** 从 args 提取"细粒度缓存 key" — 只对 shell/exec 类工具启用,其他工具用 PermissionMemory 粗粒度够用 */
function extractFineGrainedApprovalKey(
  toolName: string,
  args: Record<string, any>,
): ApprovalKey | null {
  const name = toolName.toLowerCase();
  if (name === 'execute_shell' || name === 'execute_bash' || name === 'bash' || name === 'shell') {
    const command = typeof args?.command === 'string' ? args.command : null;
    if (!command) return null;
    const cwd = typeof args?.cwd === 'string' ? args.cwd : process.cwd();
    return { command, cwd };
  }
  // 其他工具:不启用细粒度缓存
  return null;
}

/**
 * Approval Request
 */
export interface ApprovalRequest {
  toolName: string;
  toolCategory: ToolCategory;
  args: Record<string, any>;
  reason?: string;
  allowRemember?: boolean;
  scopeKey?: string;
  risk?: ToolRiskAssessment;
}

/**
 * Approval Result
 */
export interface ApprovalResult {
  approved: boolean;
  remember?: boolean;
}

/**
 * Approval Handler
 */
export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalResult>;

/**
 * Permission Manager Configuration
 */
export interface PermissionManagerConfig {
  /** Approval Handler (用于请求用户确认) */
  approvalHandler?: ApprovalHandler;

  /** 默认权限（如果工具没有配置） */
  defaultPermission?: ToolPermission;

  /** 权限记忆过期时间（毫秒） */
  memoryExpirationMs?: number;

  /** 按 scopeKey 解析审批模式（global / agent） */
  scopeModeResolver?: (scopeKey?: string) => ApprovalMode | undefined;

  /** "Always Allow" 的持久化后端。不传 = 不持久化 (测试 / cloud-runtime 的默认期望)。
   *  想落盘的宿主传 core 的 createFilePermissionStorage()。 */
  storage?: PermissionMemoryStorage | null;
}

export interface PermissionCheckContext {
  scopeKey?: string;
}

/**
 * Permission Manager
 */
export class PermissionManager {
  private config: PermissionManagerConfig;
  private toolPermissions: Map<string, ToolPermissionConfig> = new Map();
  private permissionMemory: Map<string, PermissionMemory> = new Map();

  /** 持久化后端 (null = 不持久化). */
  private readonly storage: PermissionMemoryStorage | null;
  private persistenceLoaded = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: PermissionManagerConfig = {}) {
    this.config = config;
    this.storage = config.storage ?? null;
    this.loadPersistedMemory();
  }

  /** 启动时 restore "always allow" memory. fail-safe: 后端返 null / 抛异常都不影响启动.
   *  诊断走 cliLogger (落 ~/.neox/logs, daemon 模式也写) — 不用 console.* (会被 patch-console
   *  污染 Ink 卡片, 见 memory feedback_infra_diagnostics_never_console). */
  private loadPersistedMemory(): void {
    if (!this.storage || this.persistenceLoaded) return;
    this.persistenceLoaded = true;
    try {
      const parsed = this.storage.load();
      if (parsed && typeof parsed === 'object') {
        for (const [key, mem] of Object.entries(parsed)) {
          if (mem && typeof mem === 'object' && typeof mem.toolName === 'string') {
            if (mem.expiresAt && Date.now() > mem.expiresAt) continue;
            this.permissionMemory.set(key, mem);
          }
        }
        cliLogger.info('PERM_PERSIST', `Loaded ${this.permissionMemory.size} always-allow entries`);
      }
    } catch (e: any) {
      cliLogger.warn('PERM_PERSIST', `Failed to load persisted permissions: ${e?.message ?? e}`);
    }
  }

  /** 防抖写盘 — 同 turn 多次 saveMemory 合并为一次写入. */
  private schedulePersist(): void {
    if (!this.storage) return;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, 100);
  }

  private persistNow(): void {
    if (!this.storage) return;
    try {
      const serializable: Record<string, PermissionMemory> = {};
      for (const [key, mem] of this.permissionMemory.entries()) {
        if (key.startsWith(`${ALWAYS_ALLOW_SCOPE}::`)) {
          if (mem.expiresAt && Date.now() > mem.expiresAt) continue;
          serializable[key] = mem;
        }
      }
      this.storage.save(serializable);
    } catch (e: any) {
      cliLogger.warn('PERM_PERSIST', `Failed to persist permissions: ${e?.message ?? e}`);
    }
  }

  /**
   * 设置工具权限配置
   */
  setToolPermission(config: ToolPermissionConfig): void {
    this.toolPermissions.set(config.toolName, config);
  }

  /**
   * 批量设置工具权限
   */
  setToolPermissions(configs: ToolPermissionConfig[]): void {
    configs.forEach(config => this.setToolPermission(config));
  }

  /**
   * 检查工具权限
   * @returns PermissionDecision
   */
  async checkPermission(
    tool: Tool,
    args: Record<string, any>,
    context: PermissionCheckContext = {}
  ): Promise<PermissionDecision> {
    const toolName = tool.name;
    const category = this.getToolCategory(tool);
    const configuredPermission = this.getToolPermission(tool);
    const scopeKey = context.scopeKey;
    const scopeMode = this.resolveScopeMode(scopeKey);
    const risk = evaluateToolRisk({ toolName, args, category });
    const highRisk = isHighRiskLevel(risk.level);
    const permission = this.resolveEffectivePermission({
      category,
      configuredPermission,
      scopeMode,
      risk,
    });
    /* DIAG (yolo-still-asks): 决策一行 log, 写 ~/.neox/logs/cli-*.log. 复现后 grep [PERM_DECIDE]. */
    cliLogger.info('PERM_DECIDE', `tool=${toolName} scopeKey=${scopeKey ?? '<none>'} scopeMode=${scopeMode ?? '<undef>'} risk=${risk.level} cfgPerm=${configuredPermission} category=${category} -> ${permission}`);
    /* K2 注: skill scope 强制执行在 Runner.invokeTool 那一层 (直接读 skillScopeBox.current,
     *   limited + 工具不在 allowedTools → return deny). 这里不再重复检查 —
     *   PermissionManager 不持有 box 引用, 走 ALS getSkillScope() 在本 context 下永远 null,
     *   等于死代码. 真要在这层 nice 拒绝 UX, 后续可 wrap orchestrator.evaluatePreExecution
     *   在 runWithSkillScopeBox 里, 但目前 invokeTool 层已足够防御. */

    // 1. DENY - 直接拒绝
    if (permission === ToolPermission.DENY) {
      const config = this.toolPermissions.get(toolName);
      /* sandbox READ_ONLY 拒绝要说清是沙箱拒的, 别甩一句 "is denied" 让模型去猜 */
      const sandboxSignal = risk.signals.find((s) => s.domain === 'sandbox');
      return {
        allowed: false,
        source: 'config',
        reason: sandboxSignal?.message || config?.reason || `Tool "${toolName}" is denied`,
        denyKind: 'denied_by_config',
      };
    }

    // 2. ALLOW - 直接允许
    if (permission === ToolPermission.ALLOW) {
      return {
        allowed: true,
        /* dangerous / auto 的放行是**档位**决定的, 不是工具配置 —— 消费端据此显示
         * "按当前档位直接执行", 别再说成"这个工具本来就允许". */
        source: scopeMode === 'dangerous' || scopeMode === 'auto' ? 'mode' : 'config',
      };
    }

    // 3. ASK - 需要确认
    // manual 模式：用户明确要逐条审, Always Allow / 细粒度缓存都不生效（只读工具在上面已 ALLOW）.
    const honorRemembered = scopeMode !== 'manual';
    // 先检查粗粒度记忆(per-tool "永远 allow/deny")
    if (honorRemembered && !highRisk) {
      const memory = this.checkMemory(toolName, scopeKey);
      if (memory) {
        return {
          allowed: memory.decision,
          source: 'remembered',
          reason: memory.decision ? undefined : 'User previously denied this tool',
          denyKind: memory.decision ? undefined : 'denied_by_user',
        };
      }
    }

    //  细粒度 approval cache — 按 (command, cwd) 精确匹配,session 内同命令免重复询问。
    // 只对 shell/exec 类工具启用(其他工具用粗粒度 memory 足够)。
    /* 设置里的「记住已批准的命令」以前没有任何读点: 这里无条件缓存,
       关掉开关照样免问 —— 用户以为收紧了权限, 实际没有。缺省 true 保持原行为。 */
    /* 同一 (command, cwd) 在本 session 内可复用批准结果；critical 仍然每次询问。 */
    const approvalCacheEnabled = getKernelConfig().agentRuntime?.approvalCache?.enabled !== false;
    const fineKey = extractFineGrainedApprovalKey(toolName, args);
    const cacheable = risk.level !== 'critical';
    if (approvalCacheEnabled && honorRemembered && fineKey && cacheable) {
      const cached = getApprovalCache().get(fineKey);
      if (cached === 'approved') {
        return {
          allowed: true,
          source: 'remembered',
          reason: 'Approved earlier in this session (same command + cwd)',
        };
      }
      if (cached === 'denied') {
        return {
          allowed: false,
          source: 'remembered',
          reason: 'Denied earlier in this session (same command + cwd)',
          denyKind: 'denied_by_user',
        };
      }
    }

    // 请求用户确认（fail-close：没有 handler 时拒绝）
    if (!this.config.approvalHandler) {
      const riskSuffix = highRisk
        ? ` (risk=${risk.level.toUpperCase()}: ${risk.summary})`
        : '';
      return {
        allowed: false,
        source: 'config',
        reason: `No approval handler configured - denied by fail-close policy${riskSuffix}`,
        denyKind: 'denied_by_config',
      };
    }

    try {
      const config = this.toolPermissions.get(toolName);
      const composedReason = this.composeApprovalReason(config?.reason, risk);
      const allowRemember = (config?.allowRemember ?? true) && !highRisk;
      const result = await this.config.approvalHandler({
        toolName,
        toolCategory: category,
        args,
        reason: composedReason,
        allowRemember,
        scopeKey,
        risk,
      });

      // 保存粗粒度记忆(用户勾了 "永远允许/永远拒绝")
      if (result.remember && allowRemember) {
        /* 强制 ALWAYS_ALLOW_SCOPE — 用户期望"Always Allow"是跨 session 永久生效,
         * 不只是本 session. 这里写永久桶 + schedulePersist 落盘. */
        this.saveMemory(toolName, result.approved, ALWAYS_ALLOW_SCOPE);
      }

      //  保存细粒度 cache — 高风险命令不缓存(每次都问更安全)
      // 用户没勾 remember 但这一次批准了 → 同 session 同命令下次免问
      if (approvalCacheEnabled && fineKey && cacheable) {
        getApprovalCache().set(fineKey, result.approved ? 'approved' : 'denied');
      }

      return {
        allowed: result.approved,
        source: 'user',
        reason: result.approved ? undefined : 'User denied approval',
        denyKind: result.approved ? undefined : 'denied_by_user',
        remember: result.remember,
      };
    } catch (error) {
      return {
        allowed: false,
        source: 'config',
        reason: `Approval handler failed: ${error instanceof Error ? error.message : String(error)}`,
        denyKind: 'error',
      };
    }
  }

  /**
   * 获取工具权限级别
   */
  private getToolPermission(tool: Tool): ToolPermission {
    // 优先级：显式配置 > 工具元数据 > 默认
    const config = this.toolPermissions.get(tool.name);
    if (config) {
      return config.permission;
    }

    if (tool.permission?.defaultPermission) {
      return tool.permission.defaultPermission;
    }

    return this.config.defaultPermission ?? ToolPermission.ASK;
  }

  /**
   * 获取工具分类
   * 优先级: 显式 permission.category > tool.isReadOnly → READ > 按名字推断
   *
   * isReadOnly 是工具元数据中的只读标记，大多数 agent-pack 工具
   * (open_surface / update_plan / list_surfaces / ...) 用它声明只读. 接入这条让
   * Manual 模式下这些工具不再被 inferToolCategory 误归到 SYSTEM/WRITE 弹审批.
   */
  private getToolCategory(tool: Tool): ToolCategory {
    if (tool.permission?.category) {
      return tool.permission.category;
    }
    if (tool.isReadOnly === true) {
      return ToolCategory.READ;
    }
    return this.inferToolCategory(tool.name);
  }

  /**
   * 自动推断工具分类
   */
  private inferToolCategory(toolName: string): ToolCategory {
    const name = toolName.toLowerCase();

    if (name.includes('read') || name.includes('grep') || name.includes('glob') ||
        name.includes('search') || name.includes('list') || name.includes('show')) {
      return ToolCategory.READ;
    }

    if (name.includes('write') || name.includes('edit') || name.includes('create') ||
        name.includes('delete') || name.includes('update')) {
      return ToolCategory.WRITE;
    }

    if (name.includes('bash') || name.includes('exec') || name.includes('run') ||
        name.includes('command')) {
      return ToolCategory.EXECUTE;
    }

    if (name.includes('fetch') || name.includes('request') || name.includes('api') ||
        name.includes('http') || name.includes('download')) {
      return ToolCategory.NETWORK;
    }

    return ToolCategory.SYSTEM;
  }

  /**
   * 检查权限记忆
   */
  private checkMemory(toolName: string, scopeKey?: string): PermissionMemory | null {
    /* Why: 旧实现只查 scopeKey-scoped 桶, 用户勾 "Always Allow" 在某 session 后, 切到
     * 别的 session (或 daemon 重启) 这条 memory 找不到 → 仍弹审批. 现在: 先查永久 scope
     * (ALWAYS_ALLOW_SCOPE), 命中即返; 否则才回退 session-scoped. saveMemory 端把
     * remember=true 的项目强制写永久 scope, 实现"勾一次, 全局生效". */
    const alwaysKey = `${ALWAYS_ALLOW_SCOPE}::${toolName}`;
    /* allowRemember=false 优先于已有永久授权；读取侧也清除不再适用的条目。 */
    if (this.toolPermissions.get(toolName)?.allowRemember === false
        && this.permissionMemory.has(alwaysKey)) {
      cliLogger.warn('PERM',
        `忽略并清除 ${toolName} 的永久授权 — 该工具策略为 allowRemember:false`);
      this.permissionMemory.delete(alwaysKey);
      this.schedulePersist();
    }
    const alwaysMem = this.permissionMemory.get(alwaysKey);
    cliLogger.debug('PERM_CHECK_MEM', `tool=${toolName} scopeKey=${scopeKey ?? '<none>'} alwaysHit=${!!alwaysMem} mapSize=${this.permissionMemory.size}`);
    if (alwaysMem) {
      if (alwaysMem.expiresAt && Date.now() > alwaysMem.expiresAt) {
        this.permissionMemory.delete(alwaysKey);
        this.schedulePersist();
      } else {
        return alwaysMem;
      }
    }
    const memory = this.permissionMemory.get(this.getMemoryKey(toolName, scopeKey));
    if (!memory) {
      return null;
    }

    // 检查是否过期
    if (memory.expiresAt && Date.now() > memory.expiresAt) {
      this.permissionMemory.delete(this.getMemoryKey(toolName, scopeKey));
      return null;
    }

    return memory;
  }

  /**
   * 保存权限记忆
   *
   * scopeKey 决定 "存到哪个桶":
   *   - 'always' (内部强制 ALWAYS_ALLOW_SCOPE) → 跨 session 永久, 持久化到磁盘
   *   - 别的 → 仅当前 PermissionManager 实例内存有效 (daemon 重启就丢)
   *
   * 调用方:用户勾 "Always Allow" → 走 saveAlwaysAllow 路径 (强制 always scope).
   */
  private saveMemory(toolName: string, decision: boolean, scopeKey?: string): void {
    const expiresAt = this.config.memoryExpirationMs
      ? Date.now() + this.config.memoryExpirationMs
      : undefined;

    this.permissionMemory.set(this.getMemoryKey(toolName, scopeKey), {
      toolName,
      decision,
      timestamp: Date.now(),
      expiresAt,
    });
    if (scopeKey === ALWAYS_ALLOW_SCOPE) {
      /* Why: 之前 100ms schedulePersist 防抖导致 race — 同 LLM 输出里多个 edit 并发,
       * 第一次写盘还没完成第二个就 check, 如果消费方有别的 PermissionManager 实例就 miss.
       * 同步 persistNow 立即落盘, 消除 race. */
      this.persistNow();
      cliLogger.debug('PERM_SAVE', `tool=${toolName} decision=${decision} scope=ALWAYS persisted`);
    }
  }

  private normalizeMemoryScope(scopeKey?: string): string {
    const normalized = (scopeKey || 'global').trim().toLowerCase();
    return normalized || 'global';
  }

  private getMemoryKey(toolName: string, scopeKey?: string): string {
    return `${this.normalizeMemoryScope(scopeKey)}::${toolName}`;
  }

  private resolveEffectivePermission(options: {
    category: ToolCategory;
    configuredPermission: ToolPermission;
    scopeMode?: ApprovalMode;
    risk: ToolRiskAssessment;
  }): ToolPermission {
    const { category, configuredPermission, scopeMode, risk } = options;

    /* Sandbox READ_ONLY 是**范围**硬约束, 不是审批档位 —— 任何模式 (含 dangerous) 都直接拒,
     * 不弹审批也不放行。放在最前面, 因为它跟"用户愿不愿意承担风险"无关。 */
    if (risk.signals.some((s) => s.domain === 'sandbox')) {
      return ToolPermission.DENY;
    }

    /* dangerous 表示完全无人托管；sandbox 硬约束和显式 DENY 仍然优先。 */
    if (scopeMode === 'dangerous') {
      return ToolPermission.ALLOW;
    }

    /* auto 只对 critical 请求审批；high 直接允许，显式 DENY 仍然拒绝。 */
    if (scopeMode === 'auto') {
      if (risk.level === 'critical') return ToolPermission.ASK;
      return configuredPermission === ToolPermission.DENY
        ? ToolPermission.DENY
        : ToolPermission.ALLOW;
    }

    if (isHighRiskLevel(risk.level)) {
      return ToolPermission.ASK;
    }

    // manual: 非只读操作全部审批（读工具直通）
    if (scopeMode === 'manual') {
      return category === ToolCategory.READ ? ToolPermission.ALLOW : ToolPermission.ASK;
    }

    return configuredPermission;
  }

  private composeApprovalReason(configReason: string | undefined, risk: ToolRiskAssessment): string | undefined {
    const parts: string[] = [];
    if (configReason) {
      parts.push(configReason);
    }
    if (isHighRiskLevel(risk.level)) {
      parts.push(`Risk ${risk.level.toUpperCase()}: ${risk.summary}`);
    }
    return parts.length > 0 ? parts.join(' | ') : undefined;
  }

  /** 当前 scope 生效的审批档位 — 供 runner 判断"要不要挂无人值守 risk 闸"。
   *  dangerous 下调用方必须整条闸都不挂, 否则 critical 会在 permission 之前被硬拦,
   *  用户开了 yolo 还是跑不动。 */
  getScopeMode(context: PermissionCheckContext = {}): ApprovalMode | undefined {
    return this.resolveScopeMode(context.scopeKey);
  }

  shouldForcePermissionCheck(context: PermissionCheckContext = {}): boolean {
    const mode = this.resolveScopeMode(context.scopeKey);
    return mode === 'auto' || mode === 'manual';
  }

  /**
   * 子作用域继承父作用域的审批档。
   *
   * 子作用域没有专属设置时继承父作用域；resolver 负责识别显式设置，映射数量有上限。
   */
  inheritScope(childScopeKey: string, parentScopeKey: string): void {
    if (!childScopeKey || !parentScopeKey || childScopeKey === parentScopeKey) return;
    this.scopeParents.set(childScopeKey, parentScopeKey);
    if (this.scopeParents.size > 500) {
      const oldest = this.scopeParents.keys().next().value;
      if (oldest !== undefined) this.scopeParents.delete(oldest);
    }
  }

  private readonly scopeParents = new Map<string, string>();

  private resolveScopeMode(scopeKey?: string): ApprovalMode | undefined {
    const resolver = this.config.scopeModeResolver;
    if (!resolver) {
      return undefined;
    }
    /* 沿父链找到最上层的会话 (子 agent 再派子 agent 也能继承), 防环最多走 8 层 */
    let key = scopeKey;
    for (let hop = 0; key && hop < 8; hop++) {
      const parent = this.scopeParents.get(key);
      if (!parent) break;
      key = parent;
    }
    return resolver(key);
  }

  /**
   * 清除权限记忆
   */
  clearMemory(toolName?: string): void {
    if (toolName) {
      for (const key of this.permissionMemory.keys()) {
        if (key.endsWith(`::${toolName}`)) {
          this.permissionMemory.delete(key);
        }
      }
    } else {
      this.permissionMemory.clear();
    }
  }

  clearMemoryForScope(scopeKey?: string): void {
    const normalizedScope = this.normalizeMemoryScope(scopeKey);
    const prefix = `${normalizedScope}::`;
    for (const key of this.permissionMemory.keys()) {
      if (key.startsWith(prefix)) {
        this.permissionMemory.delete(key);
      }
    }
  }

  /**
   * 设置 Approval Handler
   */
  setApprovalHandler(handler?: ApprovalHandler): void {
    this.config.approvalHandler = handler;
  }

  // ====================  权限统计 ====================

  /**
   * 获取权限统计信息
   */
  getStats(): {
    totalConfigured: number;
    allowCount: number;
    askCount: number;
    denyCount: number;
    memorizedDecisions: number;
    memorizedApproved: number;
    memorizedDenied: number;
  } {
    let allowCount = 0;
    let askCount = 0;
    let denyCount = 0;

    for (const config of this.toolPermissions.values()) {
      switch (config.permission) {
        case ToolPermission.ALLOW: allowCount++; break;
        case ToolPermission.ASK: askCount++; break;
        case ToolPermission.DENY: denyCount++; break;
      }
    }

    let memorizedApproved = 0;
    let memorizedDenied = 0;
    for (const memory of this.permissionMemory.values()) {
      if (memory.decision === true) memorizedApproved++;
      else if (memory.decision === false) memorizedDenied++;
    }

    return {
      totalConfigured: this.toolPermissions.size,
      allowCount,
      askCount,
      denyCount,
      memorizedDecisions: this.permissionMemory.size,
      memorizedApproved,
      memorizedDenied,
    };
  }
}
