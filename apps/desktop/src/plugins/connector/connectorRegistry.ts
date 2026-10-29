/**
 * Connector 运行时注册表 —— Agent 面对的那一层
 *
 *   Agent 不认识清单、不认识 operation、更不碰凭据。它看到的只是一张工具表:
 *
 *     figma_get_file        读一个 Figma 文件
 *     figma_reply_comment   在设计稿上留言
 *     notion_create_page    新建 Notion 页面
 *
 *   命名空间前缀是必须的 —— 两个插件都叫 `search` 的概率接近 1, 不加前缀
 *   工具表第一天就会撞名。分隔符用下划线而不是点: 供应商侧的工具名规则
 *   (Anthropic `^[a-zA-Z0-9_-]{1,64}$`) 不接受点。
 *
 *   工具描述里带副作用
 *   ------------------
 *   Agent 需要知道哪些调用是不可逆的。把副作用等级直接摊进工具描述, 模型在
 *   决策时就能看见「这个操作会真的发出去」, 而不是等闸门拦下来才发现。
 *   闸门仍然是权威 —— 这只是让模型少撞墙。
 *
 *   确认交互归谁管
 *   --------------
 *   宿主已经有一整套审批 UI (PermissionManager: 模式、记忆、风险评估)。
 *   再让闸门弹一次框就是两套交互打架。所以分工是:
 *
 *     宿主审批层   → 「要不要问用户」, 通过 tool.permission 元数据接管
 *     capability 闸门 → 「声明过吗 / 授予过吗 / 预算够吗」, 不可绕过
 *
 *   工具真正执行到 function 体内时, 宿主审批已经放行, 所以这里传
 *   `confirmed: true`。闸门的确认分支留给非 Agent 的直调路径 (设置页测试
 *   连接、命令行) 使用。
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import {
  ToolCategory,
  ToolPermission,
} from '@neoxlabs/kernel/types/permissions.js';
import {
  localized,
  type CapabilityId,
  type ConnectorTool,
  type PluginConnectorDefinition,
  type SideEffect,
} from '@neoxlabs/platform/shared/plugin-connector.js';
import { executeCapability, type ExecuteResult } from './executor.js';
import { budgetStore, grantStore } from './grantStore.js';
import { getConnection, loadCredential } from './credentialStore.js';
import { loadFreshCredential } from './oauthTokens.js';
import type { GateContext } from './gate.js';
import type { ConnectorOAuth2Auth } from '@neoxlabs/platform/shared/plugin-connector.js';

export type RegisteredConnector = {
  pluginName: string;
  connector: PluginConnectorDefinition;
  /** 桌面端一机一用户, 直接用插件名; 云端多用户时换成 `${userId}:${pluginName}` */
  installationId: string;
  tools: Tool[];
};

function setupProblem(
  pluginName: string,
  connector: PluginConnectorDefinition,
  credential: unknown,
  connection: Record<string, unknown>,
): string | undefined {
  const name = localized(connector.displayName) || pluginName;
  const where = `Neox 左侧「插件」→ 打开「${pluginName}」→ 连接`;
  if (!credential) {
    if (connector.auth.kind === 'oauth2') {
      return `「${name}」还没连接账号。请用户在 ${where}，点连接完成授权。`;
    }
    if (connector.auth.kind === 'token') {
      const how = localized(connector.auth.instructions);
      return `「${name}」还没配置 API Key / 令牌。请用户：\n1. 获取令牌：${how}\n2. 在 ${where}，把令牌粘贴进去保存。`;
    }
    return undefined;
  }
  const lacking = (connector.connectionFields ?? []).filter((f) => f.required && !String(connection[f.key] ?? '').trim());
  if (lacking.length) {
    return `「${name}」已有令牌，但还缺必填项：${lacking.map((f) => localized(f.label)).join('、')}。请用户在 ${where} 里补上。`;
  }
  return undefined;
}

const EFFECT_LABEL: Record<SideEffect, string> = {
  readonly: '只读',
  writes: '会写入对方平台',
  destructive: '不可逆 · 会删除数据',
  costly: '会产生真实费用',
};

class ConnectorRegistry {
  private readonly byPlugin = new Map<string, RegisteredConnector>();
  /** 工具全名 → 归属插件, 用于撞名检测与反查 */
  private readonly toolOwner = new Map<string, string>();

  register(pluginName: string, connector: PluginConnectorDefinition): Tool[] {
    this.unregister(pluginName);

    const ns = connector.namespace;
    const effectOf = new Map<string, SideEffect>(
      connector.permissions.map(p => [p.capability, p.effect]),
    );

    const tools: Tool[] = [];
    for (const contribution of connector.tools) {
      const effect = effectOf.get(contribution.capability);
      /* 理论上不可达 —— 校验器已挡住未声明能力的贡献点 */
      if (!effect) continue;

      const fullName = `${ns}_${contribution.name}`;
      const owner = this.toolOwner.get(fullName);
      if (owner && owner !== pluginName) {
        throw new Error(`connector tool name collision: ${fullName} (already provided by ${owner})`);
      }

      tools.push(this.buildTool(pluginName, connector, contribution, effect, fullName));
      this.toolOwner.set(fullName, pluginName);
    }

    this.byPlugin.set(pluginName, {
      pluginName,
      connector,
      installationId: pluginName,
      tools,
    });
    return tools;
  }

  unregister(pluginName: string): number {
    const entry = this.byPlugin.get(pluginName);
    if (!entry) return 0;
    for (const t of entry.tools) this.toolOwner.delete(t.name);
    this.byPlugin.delete(pluginName);
    return entry.tools.length;
  }

  get(pluginName: string): RegisteredConnector | undefined {
    return this.byPlugin.get(pluginName);
  }

  list(): RegisteredConnector[] {
    return [...this.byPlugin.values()];
  }

  /** 反查某个工具属于哪个 connector —— 设置页要显示「这个工具来自哪」 */
  ownerOf(toolName: string): string | undefined {
    return this.toolOwner.get(toolName);
  }

  // ==========================================================================
  // 直调路径 (设置页测试连接 / CLI) —— 走完整闸门, 会返回 confirmation_required
  // ==========================================================================

  async invoke(
    pluginName: string,
    capability: CapabilityId,
    input: Record<string, unknown>,
    gateOverrides?: Partial<Omit<GateContext, 'installationId' | 'grants' | 'budgets'>>,
  ): Promise<ExecuteResult> {
    const entry = this.byPlugin.get(pluginName);
    if (!entry) {
      return { ok: false, code: 'connector_not_found', message: `no connector registered for plugin "${pluginName}"` };
    }
    const connection = await getConnection(pluginName);
    const credential = entry.connector.auth.kind === 'oauth2'
      ? await loadFreshCredential(pluginName, entry.connector.auth as ConnectorOAuth2Auth, connection)
      : await loadCredential(pluginName);
    const missing = setupProblem(pluginName, entry.connector, credential, connection);
    if (missing || !credential) {
      return { ok: false, code: 'not_connected', message: missing ?? `插件「${pluginName}」没有可用的凭据。` };
    }
    return executeCapability({
      connector: entry.connector,
      pluginName,
      capability,
      input,
      connection,
      credential,
      gate: {
        installationId: entry.installationId,
        grants: grantStore,
        budgets: budgetStore,
        ...gateOverrides,
      },
    });
  }

  // ==========================================================================
  // Internal
  // ==========================================================================

  private buildTool(
    pluginName: string,
    connector: PluginConnectorDefinition,
    contribution: ConnectorTool,
    effect: SideEffect,
    fullName: string,
  ): Tool {
    const permission = connector.permissions.find(p => p.capability === contribution.capability);
    const costNote = permission?.cost
      ? ` 约 $${permission.cost.approxUsd}/${permission.cost.unit}。`
      : '';
    const description =
      `${localized(contribution.description)} ` +
      `[${localized(connector.displayName) || pluginName} · ${EFFECT_LABEL[effect]}]${costNote}`;

    const isReadOnly = effect === 'readonly';

    return {
      name: fullName,
      description,
      parameters: {
        type: 'object',
        properties: contribution.input?.properties ?? {},
        required: contribution.input?.required ?? [],
        additionalProperties: false,
      },
      isReadOnly,
      group: isReadOnly ? 'read' : 'write',
      parallelSafety: isReadOnly ? 'safe' : 'unsafe',
      resultType: isReadOnly ? 'contextual' : 'summarized',
      permission: {
        category: ToolCategory.NETWORK,
        /* 副作用等级映射到宿主审批层 —— 真正的确认 UI 在那边 */
        defaultPermission: isReadOnly ? ToolPermission.ALLOW : ToolPermission.ASK,
        permissionReason: localized(permission?.reason),
        allowInAskMode: isReadOnly,
      },
      function: async (args: Record<string, unknown>) => {
        const entry = this.byPlugin.get(pluginName);
        if (!entry) return `连接器「${pluginName}」已被卸载或禁用。`;

        const connection = await getConnection(pluginName);
        const credential = entry.connector.auth.kind === 'oauth2'
          ? await loadFreshCredential(pluginName, entry.connector.auth as ConnectorOAuth2Auth, connection)
          : await loadCredential(pluginName);
        /* 没配置不是错误, 是用户还没做的一步: 工具照常给模型, 调用时把「去哪拿、填在哪」原样告诉它, 让它转述给用户 */
        const missing = setupProblem(pluginName, entry.connector, credential, connection);
        if (missing || !credential) {
          return `${missing ?? `插件「${pluginName}」没有可用的凭据。`}\n(未调用 ${fullName}。不要换别的办法绕过, 把上面的步骤告诉用户, 等用户配置好再试。)`;
        }

        const result = await executeCapability({
          connector: entry.connector,
          pluginName,
          capability: contribution.capability,
          input: args ?? {},
          connection,
          credential,
          gate: {
            installationId: entry.installationId,
            grants: grantStore,
            budgets: budgetStore,
            /* 见文件头「确认交互归谁管」: 走到这里宿主审批层已放行 */
            confirmed: true,
          },
        });

        if (result.ok) {
          return typeof result.data === 'string'
            ? result.data
            : JSON.stringify(result.data ?? null, null, 2);
        }

        /* 闸门与上游的失败都要说人话, 并指出用户能做什么 —— 否则模型只会重试 */
        switch (result.code) {
          case 'capability_not_granted':
            return (
              `${result.message}\n` +
              `请让用户在 设置 → 插件 → ${pluginName} 中勾选并授予「${contribution.capability}」。`
            );
          case 'budget_exceeded':
            return `${result.message}\n请让用户在插件设置里提高预算上限, 或改用不产生费用的方式。`;
          case 'confirmation_required':
            return `此操作需要用户确认: ${result.message}`;
          default:
            return `调用 ${fullName} 失败 [${result.code}${result.status ? ` ${result.status}` : ''}]: ${result.message}`;
        }
      },
    };
  }
}

/** 全局单例 */
export const connectorRegistry = new ConnectorRegistry();
