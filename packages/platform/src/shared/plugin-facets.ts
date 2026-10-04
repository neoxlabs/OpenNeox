/**
 * 插件分面 (facet) —— 市场按「能帮我干什么」分类
 *
 *   之前市场按 `kind` 单值分类 (module / mcp / skill / auth / bundle)。三个问题:
 *
 *     1. **分的是「用什么做的」而不是「能帮我干什么」。** 用户来市场是找「我要接
 *        Notion」「我要它帮我审 PR」, 没有人来找「一个 MCP 类型的东西」。
 *     2. **跟侧栏撞名且语义不同。** 侧栏的 MCP / 技能是「我现在有什么」, 市场里的
 *        MCP / Skill 是「这个包是什么做的」。同名不同义比单纯重复更让人困惑。
 *     3. **单值表达不了组合。** 一个「Notion 工作流」插件天然同时带 connector 和
 *        skills。`bundle` 这个选项的存在本身就承认了这一点 —— 它是在给单值分类打补丁。
 *
 *   所以分面是**多值**的, 由清单的贡献点推导, 不由作者声明:
 *   带了 connector 就出现在「连接平台」, 带了 skills 就也出现在「技能与命令」。
 *   作者没有动机也没有能力去挑一个"最好卖"的分类。
 *
 *   MCP 在这里降级成「工具」的一种实现 —— 用户不需要知道底下是 MCP 还是原生工具,
 *   就像不需要知道一个 App 是 Swift 还是 Flutter 写的。
 */

export const PLUGIN_FACETS = [
  'connect',   // 连接平台 — Figma / Notion / Slack
  'delegate',  // 委派 Agent — Codex / Claude Code
  'skills',    // 技能与命令 — 指令包、斜杠命令、子代理
  'tools',     // 工具 — 原生工具模块 / MCP server
  'auth',      // 登录授权 — 官方订阅 OAuth
  'surface',   // 界面与主题 — UI 面板、皮肤
  'hooks',     // 流程钩子 — 工具调用前后拦截
] as const;

export type PluginFacet = (typeof PLUGIN_FACETS)[number];

export const FACET_LABELS: Record<PluginFacet, { en: string; zh: string }> = {
  connect:  { en: 'Connect',  zh: '连接平台' },
  delegate: { en: 'Delegate', zh: '委派 Agent' },
  skills:   { en: 'Skills',   zh: '技能与命令' },
  tools:    { en: 'Tools',    zh: '工具' },
  auth:     { en: 'Sign-in',  zh: '登录授权' },
  surface:  { en: 'Surfaces', zh: '界面与主题' },
  hooks:    { en: 'Hooks',    zh: '流程钩子' },
};

/**
 * 从清单推导分面。
 *
 *   输入是 PluginManifest 或市场记录里存的 manifest JSON —— 两边形状一样, 所以
 *   服务端入库时和客户端兜底时用的是同一个函数, 不会算出两套结果。
 */
export function deriveFacets(manifest: unknown): PluginFacet[] {
  if (!manifest || typeof manifest !== 'object') return [];
  const m = manifest as Record<string, any>;
  const facets = new Set<PluginFacet>();

  if (m.connector) facets.add('connect');
  if (Array.isArray(m.externalAgents) && m.externalAgents.length > 0) facets.add('delegate');

  if (nonEmpty(m.skills) || nonEmpty(m.commands) || nonEmpty(m.agents)) facets.add('skills');
  if (nonEmpty(m.tools) || (m.mcpServers && Object.keys(m.mcpServers).length > 0)) facets.add('tools');

  if (m.authProvider || m.kind === 'auth') facets.add('auth');
  if (nonEmpty(m.views)) facets.add('surface');
  if (m.hooks) facets.add('hooks');

  return [...facets];
}

function nonEmpty(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0;
}
