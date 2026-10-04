/**
 * Connector 契约 —— 插件清单里 `connector` 字段的类型与能力表
 *
 *   这一层是**纯类型 + 常量**, 没有任何运行时依赖, 所以 platform / desktop /
 *   未来的 server 都能引。真正的执行器、闸门、凭据存放在
 *   `neox-desktop/src/plugins/connector/`。
 *
 *   为什么是「动词 × 资源」而不是「每个平台一套 API」
 *   ------------------------------------------------
 *   如果 Agent 要学 Notion 的 200 个接口 + Figma 的 80 个 + Slack 的 150 个,
 *   每接一个平台就是一次从头再来, 「连接万物」不可能规模化。
 *
 *   收敛成 9 个动词 × 10 类资源之后:
 *     · Agent 只学这张表 —— 「把产物存到 X」里的 X 无论是 Notion (云 REST)、
 *       Drive (受限 REST) 还是本地文件, 对上层都是同一个 `document.create`
 *     · 新接一个平台是**填映射表**, 不是写新逻辑
 *     · 权限可以按 (资源, 动词) 精确授予, 而不是「全都给」
 *
 *   命名形态
 *   --------
 *     manifest 内声明:  `document.read` —— 相对, 不带插件前缀
 *     Agent 工具表:     `notion_document_read` —— 由宿主拼上插件命名空间
 *
 *   插件永远拿不到原始凭据: 它声明 (capability, path, query, body) 的形状,
 *   token 由宿主在闸门放行之后才注入。这是整个模型的基石 —— 否则「装一个
 *   插件」等于「交出所有账号」。
 */

// ============================================================================
// 能力契约
// ============================================================================

/** 动词 —— 描述「做什么」 */
export const CAPABILITY_VERBS = [
  'read',      // 按 id 精确取
  'search',    // 按条件找
  'create',    // 新建
  'update',    // 改已有
  'delete',    // 删除
  'notify',    // 发出通知 (消息/提醒), 与 create 区分是因为它通常不可撤回
  'subscribe', // 订阅事件流 —— 触发器的基础
  'render',    // 生成产物 (渲染图/视频/PDF), 通常耗算力
  'export',    // 导出既有内容为另一种格式
] as const;

/** 资源 —— 描述「对什么」 */
export const CAPABILITY_RESOURCES = [
  'document',  // 文档/页面 — Notion page, Confluence page, Google Doc
  'message',   // 消息 — Slack message, 邮件, 设计稿评论
  'channel',   // 频道/会话容器
  'file',      // 二进制文件/附件
  'task',      // 工单 — Linear issue, Jira ticket
  'design',    // 设计稿 — Figma file/frame/component
  'scene',     // 3D 场景 — Blender scene
  'event',     // 日程/事件
  'record',    // 结构化记录 — Airtable row, 数据库行
  'post',      // 对外发布的内容 — 推文、博客
] as const;

export type CapabilityVerb = (typeof CAPABILITY_VERBS)[number];
export type CapabilityResource = (typeof CAPABILITY_RESOURCES)[number];

/** 相对能力 id, 形如 `document.read` */
export type CapabilityId = `${CapabilityResource}.${CapabilityVerb}`;

/**
 * 副作用等级 —— 决定闸门行为, 不是给人看的标签。
 *
 *   分四档而不是简单的「读/写」二分, 是因为 destructive 和 costly 的失败代价
 *   跟普通写入完全不是一回事:
 *     · 一次误删的 Notion 页面找不回来
 *     · 一条带 URL 的 X 推文要 $0.20, Agent 循环一次就是真实账单
 *   把它们和 writes 混在一起, 要么全都拦 (体验崩), 要么全都放 (出事)。
 */
export const SIDE_EFFECTS = ['readonly', 'writes', 'destructive', 'costly'] as const;
export type SideEffect = (typeof SIDE_EFFECTS)[number];

/** 各等级的默认闸门策略。用户可以放宽 writes, 但 destructive/costly 不允许免确认。 */
export const SIDE_EFFECT_POLICY: Record<SideEffect, {
  /** 是否需要用户确认 */
  confirm: 'never' | 'first-time' | 'always';
  /** 用户能否选择「不再询问」 */
  rememberable: boolean;
  /** 是否要走预算检查 */
  budgeted: boolean;
}> = {
  readonly:    { confirm: 'never',      rememberable: true,  budgeted: false },
  writes:      { confirm: 'first-time', rememberable: true,  budgeted: false },
  destructive: { confirm: 'always',     rememberable: false, budgeted: false },
  costly:      { confirm: 'always',     rememberable: false, budgeted: true  },
};

const VERB_SET = new Set<string>(CAPABILITY_VERBS);
const RESOURCE_SET = new Set<string>(CAPABILITY_RESOURCES);

/** 拆 `document.read` → { resource, verb }。非法返回 null, 不抛。 */
export function parseCapabilityId(
  id: string,
): { resource: CapabilityResource; verb: CapabilityVerb } | null {
  const parts = id.split('.');
  if (parts.length !== 2) return null;
  const [resource, verb] = parts;
  if (!RESOURCE_SET.has(resource) || !VERB_SET.has(verb)) return null;
  return { resource: resource as CapabilityResource, verb: verb as CapabilityVerb };
}

export function isCapabilityId(id: string): id is CapabilityId {
  return parseCapabilityId(id) !== null;
}

/**
 * 推断某个能力的**最低**副作用等级。
 *
 *   用途: 校验清单时防止插件低报 —— 声明 `document.delete` 却标 readonly
 *   的必须被拒。反过来插件可以**上报** (把 document.create 标成 costly, 因为
 *   它背后要跑一次渲染), 那是允许的。
 */
export function minimumSideEffect(verb: CapabilityVerb): SideEffect {
  switch (verb) {
    case 'read':
    case 'search':
    case 'subscribe':
    case 'export':
      return 'readonly';
    case 'delete':
      return 'destructive';
    case 'render':
      /* 渲染一定吃算力 —— 出一帧是 GPU 分钟, 图像生成是 API 账单 */
      return 'costly';
    case 'create':
    case 'update':
    case 'notify':
    default:
      return 'writes';
  }
}

const SIDE_EFFECT_RANK: Record<SideEffect, number> = {
  readonly: 0, writes: 1, destructive: 2, costly: 3,
};

/** declared 是否达到了 verb 要求的最低等级 */
export function satisfiesMinimum(verb: CapabilityVerb, declared: SideEffect): boolean {
  return SIDE_EFFECT_RANK[declared] >= SIDE_EFFECT_RANK[minimumSideEffect(verb)];
}

export function sideEffectRank(effect: SideEffect): number {
  return SIDE_EFFECT_RANK[effect];
}

// ============================================================================
// 清单里的 connector 声明
// ============================================================================

/** 面向用户的文案双语。zh 缺省时回退 en。 */
export type LocalizedText = { en: string; zh?: string };

export function localized(text: LocalizedText | string | undefined, lang: 'zh' | 'en' = 'zh'): string {
  if (!text) return '';
  if (typeof text === 'string') return text;
  return (lang === 'zh' ? text.zh ?? text.en : text.en) ?? '';
}

/** costly 能力必须给出成本口径, 否则预算闸门无从判断 */
export type CostHint = {
  /** 计价单位: 每次调用 / 每条 / 每分钟算力 */
  unit: 'call' | 'item' | 'compute-minute';
  /** 供应商侧单价 (USD)。仅用于预算提示与拦截阈值。 */
  approxUsd: number;
  note?: LocalizedText;
};

export type ConnectorPermission = {
  capability: CapabilityId;
  effect: SideEffect;
  /**
   * 给用户看的**人话**理由, 必填。
   *
   *   安装页展示的是这句, 不是 scope 字符串。「读取你的 Figma 设计稿以生成
   *   实现文档」远比 `files:read` 有意义 —— 用户看不懂的授权等于没有授权。
   */
  reason: LocalizedText;
  /** effect === 'costly' 时必填 */
  cost?: CostHint;
};

/** OAuth2 授权码模式。凭据由宿主托管, 插件看不到。 */
export type ConnectorOAuth2Auth = {
  kind: 'oauth2';
  authorizeUrl: string;
  tokenUrl: string;
  refreshUrl?: string;
  scopes: string[];
  /** 平台 scope 与本清单能力的对应, 供安装页展示「这个 scope 用来干什么」 */
  scopeReasons?: Record<string, LocalizedText>;
  /** 客户端 id 可写在清单里 (公开信息); secret 永远由用户或宿主侧提供 */
  clientId?: string;
  /**
   * 登记在平台控制台的公开回调 (必须 https)。
   * Slack 公开分发不认 http://localhost，授权和换票用这一条；
   * 官网页面再把 code 跳回本机 loopbackPort。
   */
  redirectUri?: string;
  /** 本机接 bounce 的固定端口。有 redirectUri 时默认 58721 */
  loopbackPort?: number;
  /**
   * Slack 桌面/用户授权：scopes 写入 user_scope，不申请 bot scope。
   * 不设时看 authorizeUrl 是不是 Slack。
   */
  userScopes?: boolean;
};

/** 用户自带 token 的平台 (PAT)。仍由宿主加密托管。 */
export type ConnectorTokenAuth = {
  kind: 'token';
  /**
   * 放进请求头的字段名, 如 `X-Figma-Token`。
   * Telegram Bot API 把 token 放在路径里, 这时可以省略, 并打开 `pathInject`。
   */
  header?: string;
  /** 值模板, 缺省即裸 token。Notion/GitHub 这类要 `Bearer {{token}}` */
  valueTemplate?: string;
  /** 写入 header 前把 token 做 base64 (Atlassian 的 `email:api_token`) */
  tokenEncoding?: 'plain' | 'base64';
  /**
   * 闸门放行后, 宿主把路径里的 `{{token}}` 换成凭据。
   * 清单不能把 token 写进 connection —— 那张表会在设置页明文显示。
   */
  pathInject?: boolean;
  /**
   * Trello 这类 API 把 token 放在 query, 不走 Authorization。
   * 闸门放行且 origin 核对之后, 宿主才把这个参数写上去。
   */
  queryParam?: string;
  /** 引导用户去哪拿 token */
  instructions: LocalizedText;
};

export type ConnectorAuth = ConnectorOAuth2Auth | ConnectorTokenAuth | { kind: 'none' };

/** 一条声明式 HTTP 映射 —— T0 的载体, 也是绝大多数 connector 的形态 */
export type ConnectorOperation = {
  capability: CapabilityId;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** 相对 baseUrl 的路径, 支持 `{{input.fileKey}}` 插值 */
  path: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  /** 从响应里取哪一段作为结果, 点路径, 如 `data.results` */
  resultPath?: string;
};

/** 暴露给 Agent 的一个工具 */
export type ConnectorTool = {
  /** 不含命名空间的裸名, 如 `get_file`。宿主会加插件前缀。 */
  name: string;
  capability: CapabilityId;
  description: LocalizedText;
  /** JSON Schema, 描述入参 */
  input?: {
    type: 'object';
    properties?: Record<string, any>;
    required?: string[];
    additionalProperties?: boolean;
  };
};

/**
 * plugin.json 里的 `connector` 字段。
 *
 *    headers 不允许出现 Authorization / Cookie —— 凭据一律由宿主在闸门后
 *   注入, 清单里写死鉴权头就绕过了整个闸门, 是校验期就要拒的。
 *
 *   常量头放这里而不是每条 operation 重复一遍: 例如 Notion 的
 *   `Notion-Version` 是必填的 API 版本锚点, 漏了直接 400。
 */
export type PluginConnectorDefinition = {
  /** 运行时命名空间, 小写字母数字下划线。工具名前缀取它。 */
  namespace: string;
  displayName?: LocalizedText;
  baseUrl: string;
  /**
   * Zendesk / Shopify 这类 API 的主机是「用户的子域 + 平台后缀」。
   *
   *   默认禁止 host 里出现 `{{}}`: 连接表被写脏就会把 token 打到别的源。
   *   声明了本字段之后, host 只允许一种形态:
   *     `https://{{connection.subdomain}}.zendesk.com`
   *   运行时插值完的主机必须是**单个 DNS 标签** + 这个字面量后缀,
   *   否则拒发。后缀写在清单里, 用户填的值改不了「请求打给哪一家」。
   */
  allowedHostSuffix?: string;
  auth: ConnectorAuth;
  /**
   * 常量头, 或 `{{connection.accountId}}` / `{{input.x}}` 插值。
   * 禁止 `{{token}}` 和 Authorization / Cookie —— 凭据仍由宿主在闸门后注入。
   */
  headers?: Record<string, string>;
  permissions: ConnectorPermission[];
  operations: ConnectorOperation[];
  tools: ConnectorTool[];
  /**
   * 安装期需要用户填的连接变量 (如 Confluence 的 cloudId)。
   * 值会进入 `{{connection.*}}` 插值作用域。
   */
  connectionFields?: Array<{
    key: string;
    label: LocalizedText;
    required?: boolean;
    placeholder?: string;
  }>;
};

export const CONNECTOR_NAMESPACE_PATTERN = /^[a-z][a-z0-9_]{1,30}$/;
