/**
 * AgentRegistry — 全局活跃 agent 注册表 (P0-2 Multi-agent)
 *
 * 痛点: Neox explore 单向 (主→子), sibling agent 之间不能互通. CC TeamCreate +
 *   SendMessage 双向通信是真 multi-agent. 我们要做同等能力.
 *
 * 设计: 全局 (process-wide) Map sessionId → AgentMetadata. 主 agent / explore
 *   subagent 启动时 register, 退出时 unregister. sibling 关系靠 parentSessionId
 *   推断 (同一 parent 的 agent 都是 sibling).
 *
 * 跟 AgentMessageBus 配套用 — Registry 知道"谁在", Bus 负责"传消息".
 *
 * 隔离: 不同 task / 不同 session 的 agent 互相不可见 (靠 parentSessionId 拓扑).
 */

export type AgentRole = 'main' | 'subagent' | 'sibling';

export interface AgentMetadata {
  /** sessionId — 全局唯一 (主 agent 或 sub-agent 各自的 session id) */
  sessionId: string;
  /** agent 显示名 — 'main' / 'Explorer-1' / 用户自定义 */
  agentName: string;
  /** agent 角色 */
  role: AgentRole;
  /** 父 agent sessionId — main agent 为 undefined */
  parentSessionId?: string;
  /** 启动时间 (Date.now()) */
  startedAt: number;
  /** 任务描述 (subagent 启动时由 explore tool 传入, 主 agent 一般是用户 prompt 摘要) */
  taskDescription?: string;
}

class AgentRegistryImpl {
  private agents = new Map<string, AgentMetadata>();

  /**
   * 注册 agent. 重复 register 同 sessionId 会覆盖 (用最新 metadata).
   */
  register(meta: AgentMetadata): void {
    this.agents.set(meta.sessionId, meta);
  }

  /**
   * 注销 agent. 不存在不报错 (idempotent).
   */
  unregister(sessionId: string): void {
    this.agents.delete(sessionId);
  }

  /** 查单个 agent */
  get(sessionId: string): AgentMetadata | undefined {
    return this.agents.get(sessionId);
  }

  /** 列出所有 active agent (全局) */
  list(): AgentMetadata[] {
    return Array.from(this.agents.values());
  }

  /**
   * 列出指定 agent 的 sibling — 同一 parentSessionId 但排除自己.
   *
   * 主 agent (parentSessionId=undefined) 的 sibling = 其他 main agent (一般为空, 因为
   *   每个 task 只有 1 个 main).
   * Sub-agent 的 sibling = 同一 parent 下的其他 sub-agent + parent 本身.
   */
  listSiblings(sessionId: string): AgentMetadata[] {
    const self = this.agents.get(sessionId);
    if (!self) return [];

    const parentId = self.parentSessionId;
    const result: AgentMetadata[] = [];

    for (const [id, meta] of this.agents) {
      if (id === sessionId) continue; // 排除自己
      /* parent (如果存在 + 不是自己) */
      if (parentId && id === parentId) {
        result.push(meta);
        continue;
      }
      /* sibling: 同一 parent */
      if (parentId && meta.parentSessionId === parentId) {
        result.push(meta);
        continue;
      }
      /* 主 agent (parent=undefined) 看子 agent — 倒过来, 子 parent = 主 sessionId */
      if (!parentId && meta.parentSessionId === sessionId) {
        result.push(meta);
        continue;
      }
    }
    return result;
  }

  /**
   * 按 agent 名查 sessionId — 当 LLM 用 agentName 引用 sibling 时反查.
   *   优先匹配 sibling (同 task), 找不到再全局找.
   */
  resolveByName(callerSessionId: string, agentName: string): AgentMetadata | undefined {
    const siblings = this.listSiblings(callerSessionId);
    const hit = siblings.find(a => a.agentName === agentName);
    if (hit) return hit;
    /* fallback 全局找 (跨 task 通信, rare). 排除 caller 自己 —
     *   "我给 Explorer-1 发消息" 几乎不会是给自己 (自己 send 用 self sessionId 更直接) */
    return this.list().find(a => a.agentName === agentName && a.sessionId !== callerSessionId);
  }

  /** 全清 — 主要 test 用 */
  clear(): void {
    this.agents.clear();
  }

  /** 统计 — 诊断用 */
  size(): number {
    return this.agents.size;
  }
}

/* 全局单例 — process 级别共享. Neox 是单进程 (主 + sub-agent host 都在同进程), OK. */
export const agentRegistry = new AgentRegistryImpl();

/** 测试时构造独立 registry (避免污染全局). 生产代码用 agentRegistry 单例. */
export function createAgentRegistry(): AgentRegistryImpl {
  return new AgentRegistryImpl();
}

export type AgentRegistry = AgentRegistryImpl;
