/**
 * NeoxError catalogue — gateway 错误码 → 客户端友好 UI.
 *
 *   网关返 envelope:
 *     {
 *       error: { code, severity, retryable, message, details, nextAction, requestId },
 *       type:  string  // OpenAI compat, 老 SDK 用
 *     }
 *
 *   客户端按 error.code 查这张表拿稳定的 (title, message, icon, action). 不依赖 message
 *   文案 (那只是兜底, gateway 改文案不会影响客户端). gateway 加新 code 时, 客户端如果还没
 *   更新表, fallback 到 code 自身 + envelope.message, 不至于裸崩.
 *
 *   设计原则:
 *     · title  短, 一行, 用户视角的"发生了什么"
 *     · message 一两句, 解释原因 + 引导
 *     · icon   语义化 (warning/error/info/refresh/lock/cloud_off/sparkle/topup)
 *     · action 可选 CTA, 客户端按钮渲染
 *     · autoTrigger=true 的 action 客户端静默执行不展示给用户
 */

export type NeoxErrorSeverity = 'info' | 'warning' | 'error' | 'critical';

export type NeoxNextActionKind =
  | 'none'
  | 'retry'
  | 'login'
  | 'register'
  | 'topup'
  | 'rotate_anonymous'
  | 'contact_admin'
  | 'wait'
  | 'switch_model'
  | 'open_providers';

export interface NeoxNextAction {
  kind: NeoxNextActionKind;
  label?: string;
  url?: string;
  autoTrigger?: boolean;
}

export interface NeoxErrorEnvelope {
  code: string;
  severity: NeoxErrorSeverity;
  retryable: boolean;
  message: string;
  /** "下一步能做什么" —— 网关按请求语言出好的补充说明 (新网关才有) */
  hint?: string;
  details?: Record<string, unknown>;
  nextAction?: NeoxNextAction;
  requestId?: string;
  fromGateway?: boolean;
}

/** 从任意错误对象 / response body 提取标准 envelope. 失败返 null (调用方 fallback). */
export function parseNeoxErrorEnvelope(input: unknown): NeoxErrorEnvelope | null {
  if (!input || typeof input !== 'object') return null;
  const root = input as Record<string, unknown>;
  /* 网关响应 root 是 { error: {...}, type: '...' }; 也兼容直接传 error 对象. */
  const nested = !!(root.error && typeof root.error === 'object');
  const errObj = nested ? root.error as Record<string, unknown> : root;
  const code = errObj.code;
  if (typeof code !== 'string' || !code) return null;
  /* 网关来源的三个正面信号 —— 本地 new 出来的 NeoxError 一个都不会有:
   *   · `{ error: {...} }` 的嵌套形状 (网关响应体的固定外壳)
   *   · requestId / hint —— 都是网关侧才生成的字段 */
  const fromGateway = nested
    || typeof errObj.requestId === 'string'
    || (typeof errObj.hint === 'string' && !!errObj.hint.trim());
  return {
    code,
    severity: (typeof errObj.severity === 'string' ? errObj.severity : 'error') as NeoxErrorSeverity,
    retryable: errObj.retryable === true,
    message: typeof errObj.message === 'string' ? errObj.message : code,
    hint: typeof errObj.hint === 'string' && errObj.hint.trim() ? errObj.hint : undefined,
    details: (errObj.details && typeof errObj.details === 'object')
      ? errObj.details as Record<string, unknown>
      : undefined,
    nextAction: (errObj.nextAction && typeof errObj.nextAction === 'object')
      ? errObj.nextAction as NeoxNextAction
      : undefined,
    requestId: typeof errObj.requestId === 'string' ? errObj.requestId : undefined,
    ...(fromGateway ? { fromGateway: true } : null),
  };
}

export type NeoxErrorIcon =
  | 'warning' | 'error' | 'info' | 'refresh' | 'lock' | 'cloud_off'
  | 'sparkle' | 'topup' | 'block' | 'time' | 'unavailable';

export interface NeoxErrorPresentation {
  title: string;
  message: string;
  /**
   * 当 message 含 {占位} 但 details 缺对应 key 时, 用这条降级文案.
   *   不写 = message 没有占位 / 占位缺也能展示 (例如 "套餐 \"{planId}\"" 缺 planId 视觉勉强可读).
   *   写了 = message 必须依赖 details, 缺就用 fallback 兜底, 别曝 "{xxx}" 给用户.
   */
  messageFallback?: string;
  icon: NeoxErrorIcon;
  severity: NeoxErrorSeverity;
  /** 网关给的"下一步能做什么" (小一号灰字). 只有 envelope 带 hint 时才有 —— 文案由网关
   *  按请求语言出好, 客户端只渲染 (见 presentNeoxError 里的说明)。 */
  hint?: string;
  action?: { kind: NeoxNextActionKind; label: string; autoTrigger?: boolean };
  /** 是否在 timeline 显示成红色失败块. false 表示用 toast / banner / 静默 retry. */
  showInTimeline: boolean;
}

/** code → presentation. 客户端唯一 source of truth, 改文案就改这里. */
const CATALOGUE: Record<string, NeoxErrorPresentation> = {
  /* ---- auth ---- */
  'auth.required': {
    title: '请先登录',
    message: '此功能需要登录后使用',
    icon: 'lock', severity: 'error', showInTimeline: true,
    action: { kind: 'login', label: '去登录' },
  },
  'auth.login_required': {
    title: '需要配置 BYOK',
    message: '请先在 API 服务商里添加自己的 API Key 和模型。Neox Cloud 模型登录后可用。',
    icon: 'lock', severity: 'error', showInTimeline: true,
    /* 文案让用户"去 API 服务商", 就必须给得去的入口 —— 否则新用户要自己翻设置.
     * 跟 auth.invalid_key / auth.anonymous.* 保持一致. */
    action: { kind: 'open_providers', label: '打开服务商设置' },
  },
  'auth.invalid_key': {
    title: 'API 密钥无效',
    message: 'API 密钥无效或已被吊销, 请在 服务商设置 里检查/更新 Key',
    icon: 'lock', severity: 'error', showInTimeline: true,
    action: { kind: 'open_providers', label: '打开服务商设置' },
  },
  'auth.anonymous.invalid_key': {
    title: '需要配置 BYOK',
    message: '当前没有可用的本地 BYOK 模型。请先在 API 服务商里添加自己的 API Key 和模型；Neox Cloud 模型登录后可用。',
    icon: 'lock', severity: 'error', showInTimeline: true,
  },
  'auth.anonymous.banned': {
    title: '需要配置 BYOK',
    message: '当前没有可用的本地 BYOK 模型。请改用自己的 API Key；Neox Cloud 模型登录后可用。',
    icon: 'block', severity: 'error', showInTimeline: true,
  },
  'auth.signature_invalid': {
    title: '请求被网关拒绝',
    message: '设备校验没通过。先退出重新登录; 仍不行就检查本机时间是否准确, 或升级到最新版本',
    icon: 'error', severity: 'error', showInTimeline: true,
  },
  'auth.signature_missing': {
    title: '客户端版本过旧',
    message: '请升级到最新版本客户端后再使用',
    icon: 'error', severity: 'error', showInTimeline: true,
  },
  'auth.device_mismatch': {
    title: '登录设备已变更',
    message: '检测到设备指纹变化, 请重新登录',
    icon: 'lock', severity: 'error', showInTimeline: true,
    action: { kind: 'login', label: '重新登录' },
  },

  /* ---- quota ---- */
  'quota.points.insufficient': {
    title: '平台余额不足',
    message: '本次调用所需费用超过当前平台余额, 充值或升级套餐后继续',
    icon: 'topup', severity: 'warning', showInTimeline: true,
    action: { kind: 'topup', label: '去充值' },
  },
  'quota.anonymous.daily_exhausted': {
    title: '需要配置 BYOK',
    message: '当前没有可用的本地 BYOK 模型。请在 API 服务商里添加自己的 API Key 和模型后继续使用。',
    icon: 'time', severity: 'warning', showInTimeline: true,
  },
  'quota.anonymous.ip_exhausted': {
    title: '需要配置 BYOK',
    message: '当前没有可用的本地 BYOK 模型。请在 API 服务商里添加自己的 API Key 和模型后继续使用。',
    icon: 'time', severity: 'warning', showInTimeline: true,
  },
  'quota.rate_limit': {
    title: '请求过于频繁',
    message: '请稍候片刻再试, 系统正在限流保护',
    icon: 'time', severity: 'info', showInTimeline: false,
    action: { kind: 'wait', label: '稍候自动重试' },
  },
  'quota.exhausted': {
    title: '额度已用尽',
    message: '当前套餐的额度已用完。可以升级套餐 / 用平台余额 (需开启额外用量) 立刻继续, 也可以改用自己的 API Key。',
    icon: 'error', severity: 'error', showInTimeline: true,
    action: { kind: 'topup', label: '查看套餐' },
  },
  'quota.daily_cap': {
    title: '已达用量上限',
    message: '这个周期的用量已经到顶, 等窗口重置后自动恢复; 想立刻继续可以升级套餐或用自己的 API Key。',
    icon: 'time', severity: 'error', showInTimeline: true,
    action: { kind: 'topup', label: '查看套餐' },
  },
  /* 短窗口单独一条 —— 它"等一下就好", 给这类用户弹升级是敲竹杠 (跟 quotaEvents 里
   * window5h/windowWeekly 必须分开是同一个道理)。 */
  'quota.window_exhausted': {
    title: '本时段额度已用尽',
    message: '这是滚动窗口, 到点自动恢复。等不及的话可以改用自己的 API Key 继续。',
    icon: 'time', severity: 'error', showInTimeline: true,
    action: { kind: 'wait', label: '等待重置' },
  },

  /* ---- model ---- */
  'model.unavailable': {
    title: '该模型暂不可用',
    message: '管理员尚未为此模型配置上游通道, 请稍后再试或选择其他模型',
    icon: 'unavailable', severity: 'error', showInTimeline: true,
    action: { kind: 'contact_admin', label: '联系管理员' },
  },
  /* 网关把上游的 MODEL_NOT_FOUND 也映射到这个码 (server.go), 所以"模型名敲错了"和
   * "模型确实下线了"共用这一条 —— 文案不能只说"已停用", 否则用户拿着一个根本不存在的
   * 模型名去猜是不是自己套餐过期了。 */
  'model.disabled': {
    title: '该模型不可用',
    message: '模型不存在或已停用, 请检查模型名, 或换一个模型继续',
    icon: 'unavailable', severity: 'error', showInTimeline: true,
  },
  'model.not_allowed': {
    /* details.modelId / details.planId 由 gateway 透传 (server.go: parseModelDeniedReason).
     * 任一缺失则用 messageFallback, 别让用户看到 "{modelId}". */
    title: '当前套餐不支持此模型',
    message: '模型 "{modelId}" 不在套餐 "{planId}" 内, 升级后可解锁',
    messageFallback: '当前套餐不支持此模型, 升级后可解锁更多模型',
    icon: 'lock', severity: 'warning', showInTimeline: true,
    action: { kind: 'topup', label: '升级套餐' },
  },
  'model.anonymous_only_auto': {
    title: '需要配置 BYOK',
    message: '当前未配置 BYOK 模型。请在 API 服务商里添加自己的模型后再发送。',
    icon: 'info', severity: 'info', showInTimeline: true,
  },
  'model.auto_pool_empty': {
    title: 'Auto 模型池暂未配置',
    message: '管理员正在配置, 请稍后再试',
    icon: 'unavailable', severity: 'error', showInTimeline: true,
    action: { kind: 'contact_admin', label: '联系管理员' },
  },
  'model.deprecated_sunset': {
    title: '该模型已下线',
    message: '请切换到推荐的替代模型',
    icon: 'block', severity: 'warning', showInTimeline: true,
  },
  'model.modality_mismatch': {
    /* 客户端打错端点 — 比如把 image 模型打到 /v1/chat/completions. 这是客户端 bug,
     * 应该走对应 modality 的端点. message 里 server 已经给了 expectedEndpoint. */
    title: '请求端点不匹配',
    message: '该模型不能从当前端点调用, 请切换到对应的端点',
    icon: 'unavailable', severity: 'error', showInTimeline: true,
    action: { kind: 'contact_admin', label: '联系管理员' },
  },
  'model.protocol_unsupported': {
    title: '协议尚未启用',
    message: '该 channel 配置的 api 协议网关暂未实装, 请联系管理员或更换 provider 配置',
    icon: 'unavailable', severity: 'error', showInTimeline: true,
    action: { kind: 'contact_admin', label: '联系管理员' },
  },

  /* ---- upstream ---- */
  'upstream.unavailable': {
    title: '上游服务暂时不可用',
    message: '正在切换备用通道, 请稍候',
    icon: 'cloud_off', severity: 'warning', showInTimeline: false,
    action: { kind: 'retry', label: '正在重试', autoTrigger: true },
  },
  'upstream.timeout': {
    title: '上游响应超时',
    message: '正在自动重试, 请稍候',
    icon: 'time', severity: 'warning', showInTimeline: false,
    action: { kind: 'retry', label: '正在重试', autoTrigger: true },
  },
  'upstream.network': {
    title: '网络连接异常',
    message: '正在自动重试, 请检查网络连接',
    icon: 'cloud_off', severity: 'warning', showInTimeline: false,
    action: { kind: 'retry', label: '正在重试', autoTrigger: true },
  },
  'upstream.bad_response': {
    title: '上游服务返回异常',
    message: '上游服务返了具体错误响应 (常见原因: 模型名在上游不存在 / API key 无效 / 参数不被支持). 请联系管理员检查模型与通道配置.',
    icon: 'cloud_off', severity: 'error', showInTimeline: true,
    action: { kind: 'contact_admin', label: '联系管理员' },
  },
  /* 高负载 —— 措辞刻意不带责备也不引导充值: 用户没做错任何事, 充值也不解决排队.
   * 跟"额度用完"必须区分开, 那是两种完全不同的处境和动作. 跟 i18n/errors.ts 同一套口径. */
  'system.busy': {
    title: '当前使用人数较多',
    message: '正在自动重试, 稍等一下就好。换一个模型通常能立刻继续。',
    icon: 'time', severity: 'warning', showInTimeline: true,
    action: { kind: 'switch_model', label: '换个模型' },
  },
  'upstream.circuit_open': {
    title: '该模型的线路暂时不可用',
    message: '正在自动切换到备用线路; 若持续出现, 换个模型可以立刻继续。',
    icon: 'cloud_off', severity: 'warning', showInTimeline: true,
    action: { kind: 'switch_model', label: '换个模型' },
  },
  'upstream.rate_limited': {
    title: '上游服务限流中',
    message: '请稍候片刻再试',
    icon: 'time', severity: 'info', showInTimeline: false,
    action: { kind: 'wait', label: '稍候自动重试' },
  },

  /* ---- request ---- */
  'request.invalid_body': {
    title: '请求格式异常',
    message: '请刷新或重启客户端再试. 如果反复出现请反馈支持',
    icon: 'error', severity: 'error', showInTimeline: true,
  },
  'request.missing_field': {
    title: '请求字段缺失',
    message: '客户端发送的请求缺少必要字段',
    icon: 'error', severity: 'error', showInTimeline: true,
  },
  'context.exceeded': {
    title: '上下文超出模型窗口',
    message: '这轮对话已经自动压缩过, 仍然超出当前模型的上下文窗口. 可以开一个新会话继续, 或换一个窗口更大的模型.',
    icon: 'warning', severity: 'error', showInTimeline: true,
    action: { kind: 'switch_model', label: '换个模型' },
  },
  'request.cancelled': {
    title: '请求已取消',
    message: '本轮对话被中断',
    icon: 'info', severity: 'info', showInTimeline: false,
  },

  /* ---- system ---- */
  'system.control_plane_unavailable': {
    title: '服务暂时不可用',
    message: '后端服务异常, 请稍候再试',
    icon: 'cloud_off', severity: 'warning', showInTimeline: true,
    action: { kind: 'retry', label: '稍后重试' },
  },
  'system.internal_error': {
    title: '系统内部异常',
    message: '请稍候再试或联系支持团队',
    icon: 'error', severity: 'error', showInTimeline: true,
    action: { kind: 'contact_admin', label: '联系支持' },
  },
};

/**
 * 按 envelope 拼出客户端展示需要的字段.
 *
 *   未知 code → fallback: title=envelope.message 第一行, icon=error, severity=error.
 *   找到 code → 用 catalogue, 但 envelope.message 可作为 detail 补充展示 (e.g. requestId).
 *
 *   {limit} {modelId} 等 details 占位会被替换进 message — admin 改 model id 不需要前端发版.
 */
const LEGACY_CODE_ALIASES: Record<string, string> = {
  INSUFFICIENT_BALANCE: 'quota.exhausted',
  QUOTA_EXCEEDED: 'quota.exhausted',
  USAGE_LIMIT_REACHED: 'quota.daily_cap',
  HTTP_429: 'quota.rate_limit',
  UNAUTHORIZED: 'auth.invalid_key',
  CONNECT_TIMEOUT: 'upstream.network',
  TIMEOUT: 'upstream.timeout',
  STREAM_TIMEOUT: 'upstream.timeout',
  STREAM_IDLE_TIMEOUT: 'upstream.timeout',
  PROXY_UPSTREAM_FAILED: 'upstream.unavailable',
  INVALID_REQUEST: 'request.invalid_body',
  ECONNREFUSED: 'upstream.network',
  ENOTFOUND: 'upstream.network',
  ECONNRESET: 'upstream.network',
  EPIPE: 'upstream.network',
  CANCELED: 'request.cancelled',
  ERR_CANCELED: 'request.cancelled',
  FORBIDDEN: 'auth.invalid_key',
  CONTEXT_WINDOW_EXCEEDED: 'context.exceeded',
};


const CATALOGUE_EN: Record<string, { title: string; message: string; messageFallback?: string; label?: string }> = {
  /* ---- auth ---- */
  'auth.required': { title: 'Sign in required', message: 'This feature needs you to sign in first.', label: 'Sign in' },
  'auth.login_required': { title: 'Set up BYOK', message: 'Add your own API key and models under API providers. Neox Cloud models become available once you sign in.', label: 'Open provider settings' },
  'auth.invalid_key': { title: 'API key rejected', message: 'The API key is invalid or has been revoked. Check or update it under provider settings.', label: 'Open provider settings' },
  'auth.anonymous.invalid_key': { title: 'Set up BYOK', message: 'No local BYOK model is available. Add your own API key and models under API providers; Neox Cloud models become available once you sign in.' },
  'auth.anonymous.banned': { title: 'Set up BYOK', message: 'No local BYOK model is available. Use your own API key instead; Neox Cloud models become available once you sign in.' },
  'auth.signature_invalid': { title: 'Rejected by the gateway', message: 'Device verification failed. Sign out and back in; if it persists, check your system clock or update to the latest version.' },
  'auth.signature_missing': { title: 'Client is out of date', message: 'Update to the latest client version to continue.' },
  'auth.device_mismatch': { title: 'Signed-in device changed', message: 'The device fingerprint changed. Please sign in again.', label: 'Sign in again' },

  /* ---- quota ---- */
  'quota.points.insufficient': { title: 'Not enough platform balance', message: 'This call costs more than your platform balance. Top up or upgrade your plan to continue.', label: 'Top up' },
  'quota.anonymous.daily_exhausted': { title: 'Set up BYOK', message: 'No local BYOK model is available. Add your own API key and models under API providers to continue.' },
  'quota.anonymous.ip_exhausted': { title: 'Set up BYOK', message: 'No local BYOK model is available. Add your own API key and models under API providers to continue.' },
  'quota.rate_limit': { title: 'Too many requests', message: 'Rate limiting is protecting the service — try again shortly.', label: 'Retrying shortly' },
  'quota.exhausted': { title: 'Usage limit reached', message: 'The allowance on your plan is used up. Upgrade, or continue on your platform balance (with Extra usage on), or switch to your own API key.', label: 'See plans' },
  'quota.daily_cap': { title: 'Usage cap reached', message: 'You have hit the cap for this period. It resets automatically; to continue now, upgrade your plan or use your own API key.', label: 'See plans' },
  'quota.window_exhausted': { title: 'This window is used up', message: 'This is a rolling window and recovers on its own. If you cannot wait, switch to your own API key.', label: 'Wait for reset' },

  /* ---- model ---- */
  'model.unavailable': { title: 'Model unavailable', message: 'No upstream channel is configured for this model yet. Try again later or pick another model.', label: 'Contact admin' },
  'model.disabled': { title: 'Model unavailable', message: 'The model does not exist or has been disabled. Check the model name, or switch to another one.' },
  'model.not_allowed': { title: 'Not included in your plan', message: 'Model "{modelId}" is not part of the "{planId}" plan. Upgrade to unlock it.', messageFallback: 'This model is not included in your plan. Upgrading unlocks more models.', label: 'Upgrade plan' },
  'model.anonymous_only_auto': { title: 'Set up BYOK', message: 'No BYOK model is configured. Add your own model under API providers before sending.' },
  'model.auto_pool_empty': { title: 'Auto model pool not configured', message: 'An admin is still setting this up — please try again later.', label: 'Contact admin' },
  'model.deprecated_sunset': { title: 'Model retired', message: 'Switch to one of the recommended replacements.' },
  'model.modality_mismatch': { title: 'Wrong endpoint for this model', message: 'This model cannot be called from the current endpoint. Switch to the matching one.', label: 'Contact admin' },
  'model.protocol_unsupported': { title: 'Protocol not enabled', message: 'The gateway does not implement the API protocol this channel is configured for. Contact an admin or change the provider configuration.', label: 'Contact admin' },

  /* ---- upstream ---- */
  'upstream.unavailable': { title: 'Upstream temporarily unavailable', message: 'Switching to a backup channel — hang tight.', label: 'Retrying' },
  'upstream.timeout': { title: 'Upstream timed out', message: 'Retrying automatically — hang tight.', label: 'Retrying' },
  'upstream.network': { title: 'Network problem', message: 'Retrying automatically — check your network connection.', label: 'Retrying' },
  'upstream.bad_response': { title: 'Upstream returned an error', message: 'The upstream service returned a specific error (commonly: the model name does not exist upstream, an invalid API key, or unsupported parameters). Ask an admin to check the model and channel configuration.', label: 'Contact admin' },
  'system.busy': { title: 'Busy right now', message: 'Retrying automatically — this usually clears in a moment. Switching models normally lets you continue right away.', label: 'Switch model' },
  'upstream.circuit_open': { title: 'This model route is down', message: 'Switching to a backup route. If it keeps happening, another model will let you continue immediately.', label: 'Switch model' },
  'upstream.rate_limited': { title: 'Upstream is rate limiting', message: 'Please try again in a moment.', label: 'Retrying shortly' },

  /* ---- request / context / system ---- */
  'request.invalid_body': { title: 'Malformed request', message: 'Refresh or restart the client and try again. If it keeps happening, please report it.' },
  'request.missing_field': { title: 'Missing request field', message: 'The client sent a request without a required field.' },
  'context.exceeded': { title: 'Context window exceeded', message: 'This conversation was already compacted and still exceeds the context window of the current model. Start a new session, or switch to a model with a larger window.', label: 'Switch model' },
  'request.cancelled': { title: 'Request cancelled', message: 'This turn was interrupted.' },
  'system.control_plane_unavailable': { title: 'Service temporarily unavailable', message: 'The backend is having trouble — please try again shortly.', label: 'Retry later' },
  'system.internal_error': { title: 'Something went wrong', message: 'Please try again shortly, or contact support.', label: 'Contact support' },
};

export type NeoxErrorLanguage = 'zh' | 'en';

/**
 * 当前展示语言。默认 'zh' —— 改动前的行为, 没有调用方设置时一切照旧。
 * 由 UI 层在语言切换时调用 setNeoxErrorLanguage(); platform 层不去猜 UI 的语言。
 */
let currentLanguage: NeoxErrorLanguage = 'zh';

export function setNeoxErrorLanguage(lang: NeoxErrorLanguage): void {
  currentLanguage = lang === 'en' ? 'en' : 'zh';
}

export function getNeoxErrorLanguage(): NeoxErrorLanguage {
  return currentLanguage;
}

export function presentNeoxError(
  envelope: NeoxErrorEnvelope,
  lang: NeoxErrorLanguage = currentLanguage,
): NeoxErrorPresentation {
  const preset = CATALOGUE[envelope.code] ?? CATALOGUE[LEGACY_CODE_ALIASES[envelope.code] ?? ''];
  if (!preset) {
    /* 未知 code 兜底 — 用 envelope.message + 默认 error 视觉. */
    return {
      title: envelope.message?.split('\n')[0]?.slice(0, 80) || envelope.code,
      message: envelope.message || envelope.code,
      icon: 'error',
      severity: envelope.severity ?? 'error',
      showInTimeline: true,
      /* 本地表没有这条码 (网关新增/客户端还没发版) —— 网关的 hint 就更是唯一的提示语了 */
      ...(envelope.hint?.trim() ? { hint: envelope.hint.trim() } : null),
    };
  }
  /* 简单字符串模板替换: {key} → details[key]. 不引模板引擎, 几个字段够用.
   * 替换后若仍含 {xxx} 占位 (= details 缺 key), 走 messageFallback 兜底, 否则曝原始模板. */
  /* 英文界面: 用 EN 表覆盖 title/message/messageFallback/action.label。
   * EN 表缺这条时静默回落中文 —— 少一条英文, 好过整块错误卡渲染不出来。
   * (两表不许漂移由 errorCatalogueBilingual.test.ts 兜着, 缺一条就红。) */
  const localized = lang === 'en' ? CATALOGUE_EN[envelope.code] ?? CATALOGUE_EN[LEGACY_CODE_ALIASES[envelope.code] ?? ''] : undefined;
  const base = localized
    ? { ...preset, title: localized.title, message: localized.message, messageFallback: localized.messageFallback,
        action: preset.action && localized.label ? { ...preset.action, label: localized.label } : preset.action }
    : preset;

  let message = interpolate(base.message, envelope.details);
  if (base.messageFallback && /\{[\w.]+\}/.test(message)) {
    message = base.messageFallback;
  }
  /* envelope 自己声明的 nextAction 可以覆盖 catalogue 默认 (e.g. 同 code 不同 context) */
  const action = envelope.nextAction
    ? {
        kind: envelope.nextAction.kind,
        label: envelope.nextAction.label || base.action?.label || '',
        autoTrigger: envelope.nextAction.autoTrigger ?? base.action?.autoTrigger,
      }
    : base.action;

  /* 只有**真·网关 envelope** 的 message 才优先。
   *
   *   老码 (ECONNREFUSED / CONTEXT_WINDOW_EXCEEDED / FORBIDDEN …) 走的是
   *   LEGACY_CODE_ALIASES: 那些 message 根本不是网关写的, 是 kernel 里写死的英文
   *   ("Context window exceeded. Please start a new conversation...")。它们要是也
   *   "以 envelope 为准", 就等于把那句英文摊回给中文界面 —— legacyCodeAliases.test.ts
   *   那条闸就是为这个立的。网关的码一律是带点的命名空间形式 (auth.invalid_key)。 */
  const isGatewayCode = envelope.fromGateway === true && !!CATALOGUE[envelope.code];
  const gatewayMessage = isGatewayCode ? (envelope.message ?? '').trim() : '';
  const gatewayHint = (envelope.hint ?? '').trim();
  const usedTemplate = /\{[\w.]+\}/.test(base.message);
  return {
    ...base,
    message: gatewayMessage && !usedTemplate ? gatewayMessage : message,
    /* hint 只有网关给才有 —— 本地表没有这个字段, 不存在覆盖问题 */
    ...(gatewayHint ? { hint: gatewayHint } : null),
    action,
  };
}

function interpolate(tpl: string, details?: Record<string, unknown>): string {
  if (!details) return tpl;
  return tpl.replace(/\{([\w.]+)\}/g, (_, key) => {
    const v = details[key];
    return v === undefined || v === null ? `{${key}}` : String(v);
  });
}

/**
 * 从 unknown 错误对象一把抽出 envelope (走过 fetch / axios / Error.message 的 JSON 串).
 *
 *   优先级:
 *     1. err.body / err.responseBody / err.data — fetch wrappers 通常会把 body 挂上来
 *     2. err.message 解 JSON — axios / openai-sdk 会把 body 序列化进 message
 *     3. err 本身就是 envelope shape
 *     4. null — 调用方走 fallback (legacy keyword 分类)
 */
export function extractNeoxEnvelopeFromError(err: unknown): NeoxErrorEnvelope | null {
  if (!err) return null;
  /* err 自身是 plain object 且看着像 envelope */
  const direct = parseNeoxErrorEnvelope(err);
  if (direct) return direct;
  if (typeof err !== 'object') return null;
  const e = err as Record<string, unknown>;
  /* 1. body / responseBody / data 字段 */
  for (const key of ['body', 'responseBody', 'data', 'response']) {
    const v = e[key];
    if (v) {
      const env = parseNeoxErrorEnvelope(v);
      if (env) return env;
      /* response.data 这种嵌套一层, 再展一次 */
      if (typeof v === 'object') {
        const inner = (v as Record<string, unknown>).data;
        if (inner) {
          const env2 = parseNeoxErrorEnvelope(inner);
          if (env2) return env2;
        }
      }
    }
  }
  /* 2. message 里塞 JSON. OpenAI SDK / axios 经常这样: "500 {"error":...}" */
  if (typeof e.message === 'string') {
    /* 抓第一段 {...} JSON */
    const match = e.message.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        const env = parseNeoxErrorEnvelope(parsed);
        if (env) return env;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}
