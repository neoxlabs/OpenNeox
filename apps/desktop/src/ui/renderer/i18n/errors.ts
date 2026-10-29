/**
 * Error i18n — 错误码 → UI 文案 (zh + en).
 *
 *   设计 (C3):
 *     · 后端 throw NeoxError({ code: 'quota.exhausted', ... }) (code 在 neox-core/types/errors.ts ERROR_CODES 注册)
 *     · 前端拿到 code → translateError(code, language) 出 UI 友好文案 + 可选 hint + nextAction 按钮
 *     · 文案优先级: 本文件 ERROR_MESSAGES[code] > backend NeoxError.message > ERROR_CODES[code].defaultMessage > raw code 字符串
 *
 *   规则:
 *     · 文案要"用户能看懂", 不要写 "HTTP 401" 这种英文术语 (除非 UI 上有 debug 模式)
 *     · 中文用句号 + 标点正常, 别全用感叹号
 *     · hint 是补充说明 (e.g. "你可以在设置里更换 provider"), 跟主消息分开渲染
 *     · 加新 code 顺序: 先在 neox-core 注册 ERROR_CODES, 再在这里加 zh + en 文案
 *
 *   不在这里的 code: fallback 到后端 NeoxError.message, 再 fallback 到 ERROR_CODES[code].defaultMessage,
 *     最差展示 code 本身 (开发模式可见, 用户能截图给我们 reproduce).
 */

import { ERROR_CODE_ALIASES, ERROR_CODES, type ErrorActionKind } from '@neoxlabs/kernel/types/errors.js';
import type { Language } from './index.js';
import { getEditionHook } from '../modules/shell/editionHooks';

export interface ErrorMessage {
  /** 主消息, 一句话能让用户判断怎么处理 */
  message: string;
  /** 可选的补充说明 (UI 上小一号字, 灰色). 用于解释 "为什么会发生" 或 "可以怎么避免" */
  hint?: string;
  /** 可选的 CTA 按钮文字 (跟 backend 的 nextAction 配对) */
  actionLabel?: string;
}

type ErrorMessageMap = Record<string, ErrorMessage>;

const MESSAGES_ZH: ErrorMessageMap = {
	  /* auth */
	  'auth.login_required':     { message: '需要配置 BYOK', hint: '未登录也可以用自己的 API Key:去 设置 → API 服务商 添加服务商和模型。Neox Cloud 模型登录后可用。', actionLabel: '打开服务商设置' },
	  'auth.invalid_key':       { message: 'API 密钥被拒绝', hint: 'BYOK 用户: 去 设置 → API 服务商 检查 Key 是否正确、有额度、模型名对得上。Neox 订阅用户: 通常会自动重签; 若持续出现, 退出重新登录。', actionLabel: '打开服务商设置' },
	  'auth.expired':           { message: '登录已过期', hint: '会话过期了, 重新登录后即可继续', actionLabel: '重新登录' },
  'auth.forbidden':         { message: '没有访问该资源的权限', hint: '请确认账号是否开通了相关功能' },

  /* quota */
  'quota.exhausted':        { message: '本期额度已用尽', hint: '等窗口重置即可恢复; 也可以用平台余额接上 (需开启额外用量), 或换更高的档', actionLabel: '看套餐' },
  'quota.rate_limited':     { message: '请求过于频繁', hint: '正在自动重试, 请稍候; 频繁出现可以考虑升级套餐' },
  /* 高负载 —— 措辞刻意不带责备, 也不引导充值: 用户没做错任何事, 充值也不解决排队.
   * 跟"额度用完"必须区分开, 那是两种完全不同的处境和动作. */
  'system.busy':            { message: '当前使用人数较多', hint: '正在自动重试, 稍等一下就好。换一个消耗更低的模型通常能立刻继续。', actionLabel: '换个模型' },
  'upstream.circuit_open':  { message: '该模型的线路暂时不可用', hint: '正在自动切换到备用线路; 若持续出现, 换个模型可以立刻继续。', actionLabel: '换个模型' },
  'quota.daily_cap':        { message: '今日额度已用完', hint: '免费套餐每天有上限; 升级套餐可解除限制', actionLabel: '升级套餐' },

  /* network */
  'network.timeout':        { message: '网络请求超时', hint: '检查网络是否畅通, 或稍后再试', actionLabel: '重试' },
  'network.unreachable':    { message: '无法连接到服务器', hint: '请检查网络连接或代理设置', actionLabel: '重试' },
  'network.dns':            { message: '域名解析失败', hint: '可能是 DNS 问题或代理未生效' },
  'network.tls':            { message: 'TLS 握手失败', hint: '通常是网络环境/防火墙问题' },
  'network.proxy_unreachable': { message: '代理服务器不可达', hint: '检查 HTTPS_PROXY 设置, 或暂时关闭代理' },

  /* upstream */
  'upstream.server_error':  { message: '上游服务异常', hint: '正在自动重试; 持续失败请尝试切换 provider', actionLabel: '重试' },
  'upstream.bad_gateway':   { message: '上游网关错误', hint: '代理与上游之间出了问题, 短时间内会自动恢复' },
  'upstream.unavailable':   { message: '上游服务暂时不可用', hint: '通常几分钟内恢复, 紧急情况可切换 provider' },

  /* model */
  'model.not_found':        { message: '指定的模型不存在', hint: '检查模型名拼写, 或在设置里换一个 provider', actionLabel: '切换 provider' },
  'MODEL_NOT_SUPPORTED':    { message: '这个模型在当前供应商上用不了', hint: '换一个模型试试 —— 同一家网关里, 不同模型支持的接口格式常常不一样。展开可看上游原话。', actionLabel: '切换模型' },
  'model.unsupported':      { message: '该模型不支持此操作', hint: '换一个支持此功能的模型 (e.g. 工具调用 / 多模态)' },
  'model.input_too_large':  { message: '输入超过模型上下文上限', hint: '精简一下 prompt 或文件长度后重试' },

  /* context */
  'context.exceeded':       { message: '会话上下文已满', hint: '已自动压缩仍超限, 建议开新会话或主动 /compact' },

  /* tool */
  'tool.denied':            { message: '工具调用被拒绝', hint: '当前审批档位拦下了这次调用。可在输入框左侧的审批药丸里换一档' },
  'tool.timeout':           { message: '工具执行超时', hint: '长任务建议拆小或用 background mode', actionLabel: '重试' },
  'tool.invalid_args':      { message: '工具参数无效', hint: 'LLM 生成的参数没法解析, 通常下一轮会自动修正' },
  'tool.execution_failed':  { message: '工具执行失败', hint: '查看 timeline 卡片上的具体报错' },
  'tool.denied_by_skill_scope': { message: '当前 skill 不允许调此工具', hint: '该 skill 是 limited 模式, 只能用它声明的工具; 切非 skill 模式或换 trusted skill' },

  /* stream */
  'stream.disconnected':    { message: '流式响应中断', hint: '正在自动重连' },
  'stream.malformed':       { message: '流式响应格式错误', hint: '上游返回的数据不合规范' },

  /* user */
  'user.canceled':          { message: '操作已取消' },

  /* internal */
  'internal.unknown':       { message: '出了点问题', hint: '查看日志，或把截图发给我们排查', actionLabel: '打开日志' },
  'internal.config_invalid': { message: '配置文件无效', hint: '可能是手动改坏了 ~/.neox/config.json' },
};

const MESSAGES_EN: ErrorMessageMap = {
	  /* auth */
	  'auth.login_required':     { message: 'BYOK configuration required', hint: 'You can use your own API key without signing in: add a provider and model in Settings → Providers. Neox Cloud models are available after sign-in.', actionLabel: 'Open provider settings' },
	  'auth.invalid_key':       { message: 'API key was rejected', hint: 'Using your own key (BYOK)? Check it in Settings → Providers — valid, has credit, model name matches. Using a Neox subscription? Sign in again.', actionLabel: 'Open provider settings' },
  'auth.expired':           { message: 'Session expired', hint: 'Log in again to continue', actionLabel: 'Log in' },
  'auth.forbidden':         { message: 'No permission to access this resource', hint: 'Verify your account has the required entitlement' },

  /* quota */
  'quota.exhausted':        { message: 'Quota used up', hint: 'It refills when your window resets — or continue on your platform balance (with Extra usage on), or move to a higher plan', actionLabel: 'View plans' },
  'quota.rate_limited':     { message: 'Rate limited', hint: 'Auto-retrying; consider upgrading if this happens often' },
  'system.busy':            { message: 'High demand right now', hint: 'Retrying automatically — this usually clears in a moment. Switching to a lighter model works right away.', actionLabel: 'Switch model' },
  'upstream.circuit_open':  { message: 'This model route is temporarily unavailable', hint: 'Switching to a backup route; if it persists, another model will work right away.', actionLabel: 'Switch model' },
  'quota.daily_cap':        { message: 'Daily quota reached', hint: 'Free plan has a daily cap; upgrade to remove it', actionLabel: 'Upgrade' },

  /* network */
  'network.timeout':        { message: 'Network request timed out', hint: 'Check your connection or try again', actionLabel: 'Retry' },
  'network.unreachable':    { message: 'Cannot reach server', hint: 'Check network connection or proxy settings', actionLabel: 'Retry' },
  'network.dns':            { message: 'DNS lookup failed', hint: 'Could be DNS issues or proxy not in effect' },
  'network.tls':            { message: 'TLS handshake failed', hint: 'Usually a network / firewall issue' },
  'network.proxy_unreachable': { message: 'Proxy unreachable', hint: 'Check HTTPS_PROXY setting or disable proxy temporarily' },

  /* upstream */
  'upstream.server_error':  { message: 'Upstream service error', hint: 'Auto-retrying; switch provider if it persists', actionLabel: 'Retry' },
  'upstream.bad_gateway':   { message: 'Upstream bad gateway', hint: 'Proxy-to-upstream issue, usually recovers quickly' },
  'upstream.unavailable':   { message: 'Upstream service unavailable', hint: 'Usually recovers in minutes; switch provider if urgent' },

  /* model */
  'model.not_found':        { message: 'Model not found', hint: 'Check model name spelling or switch provider in settings', actionLabel: 'Switch provider' },
  'MODEL_NOT_SUPPORTED':    { message: 'That model isn’t available on this provider', hint: 'Pick another model — models on the same gateway often support different API formats. Expand for the upstream’s own wording.', actionLabel: 'Switch model' },
  'model.unsupported':      { message: 'Model does not support this operation', hint: 'Try a model that supports this feature (tools / multimodal)' },
  'model.input_too_large':  { message: 'Input exceeds model context limit', hint: 'Shorten the prompt or attached files and retry' },

  /* context */
  'context.exceeded':       { message: 'Conversation context full', hint: 'Auto-compression still exceeded limit; start a new session or /compact' },

  /* tool */
  'tool.denied':            { message: 'Tool call denied', hint: 'Your approval setting blocked this call. Change it in the approval pill left of the input box' },
  'tool.timeout':           { message: 'Tool execution timed out', hint: 'Split long tasks or use background mode', actionLabel: 'Retry' },
  'tool.invalid_args':      { message: 'Tool arguments invalid', hint: 'LLM-generated args could not be parsed; usually self-corrects next turn' },
  'tool.execution_failed':  { message: 'Tool execution failed', hint: 'Check the timeline card for details' },
  'tool.denied_by_skill_scope': { message: 'Active skill does not permit this tool', hint: 'This skill is limited; it can only call tools it declares. Use a trusted skill or non-skill mode.' },

  /* stream */
  'stream.disconnected':    { message: 'Stream disconnected', hint: 'Auto-reconnecting' },
  'stream.malformed':       { message: 'Malformed stream response', hint: 'Upstream returned non-conforming data' },

  /* user */
  'user.canceled':          { message: 'Operation canceled' },

  /* internal */
  'internal.unknown':       { message: 'Something went wrong', hint: 'Check logs or send us a screenshot to reproduce', actionLabel: 'Open logs' },
  'internal.config_invalid': { message: 'Configuration file invalid', hint: '~/.neox/config.json may have been manually edited' },
};

const MAP_BY_LANG: Record<Language, ErrorMessageMap> = {
  zh: MESSAGES_ZH,
  en: MESSAGES_EN,
};

/* 没有账号体系的构建 (开源版) 只有自带 Key: 上面那几条讲订阅 / 套餐 / 重新登录的, 换成指向
 * 用户自己的服务商。商业版不走这张表。 */
const BYOK_ZH: ErrorMessageMap = {
  'auth.login_required': { message: '还没有可用的模型', hint: '去 设置 → 模型服务 添加你自己的 API Key (DeepSeek / Kimi / OpenAI / Anthropic …)', actionLabel: '打开服务商设置' },
  'auth.invalid_key':    { message: 'API 密钥被拒绝', hint: '去 设置 → 模型服务 检查 Key 是否正确、还有余额、模型名对得上', actionLabel: '打开服务商设置' },
  'auth.expired':        { message: 'API 密钥失效', hint: '服务商不再接受这个 Key, 去 设置 → 模型服务 换一个', actionLabel: '打开服务商设置' },
  'auth.forbidden':      { message: '服务商拒绝了这个请求', hint: '这个 Key 可能没开通该模型或功能, 去服务商后台确认, 或换个模型', actionLabel: '打开服务商设置' },
  'quota.exhausted':     { message: '服务商额度用完了', hint: '去服务商后台充值或换个 Key, 也可以先换个模型', actionLabel: '打开服务商设置' },
  'quota.rate_limited':  { message: '触发服务商的限流', hint: '正在自动重试; 经常出现的话换个模型或提高服务商那边的限额' },
  'quota.daily_cap':     { message: '今天的用量到上限了', hint: '这是服务商那边的每日上限, 明天恢复, 或换个 Key / 模型', actionLabel: '打开服务商设置' },
  'internal.unknown':    { message: '出了点问题', hint: '查看日志; 能复现的话欢迎到 GitHub 提 issue', actionLabel: '打开日志' },
};

const BYOK_EN: ErrorMessageMap = {
  'auth.login_required': { message: 'No model set up yet', hint: 'Add your own API key in Settings → Model services (DeepSeek, Kimi, OpenAI, Anthropic, …)', actionLabel: 'Open provider settings' },
  'auth.invalid_key':    { message: 'API key was rejected', hint: 'Check the key in Settings → Model services: valid, has credit, model name matches', actionLabel: 'Open provider settings' },
  'auth.expired':        { message: 'API key no longer valid', hint: 'Your provider stopped accepting this key. Replace it in Settings → Model services', actionLabel: 'Open provider settings' },
  'auth.forbidden':      { message: 'Your provider refused the request', hint: 'This key may not have access to that model or feature. Check with your provider or switch models', actionLabel: 'Open provider settings' },
  'quota.exhausted':     { message: 'Provider credit used up', hint: 'Top up with your provider or use another key — or switch models for now', actionLabel: 'Open provider settings' },
  'quota.rate_limited':  { message: 'Rate limited by your provider', hint: 'Retrying automatically. If it keeps happening, switch models or raise the limit with your provider' },
  'quota.daily_cap':     { message: 'Daily limit reached', hint: 'Your provider’s daily cap — it resets tomorrow, or use another key / model', actionLabel: 'Open provider settings' },
  'internal.unknown':    { message: 'Something went wrong', hint: 'Check the logs. If you can reproduce it, please open a GitHub issue', actionLabel: 'Open logs' },
};

const BYOK_BY_LANG: Record<Language, ErrorMessageMap> = { zh: BYOK_ZH, en: BYOK_EN };

const byokOnly = (): boolean => !getEditionHook('hasAccount');

/** 把 error code 翻译成当前语言的 UI 消息.
 *
 *  Fallback 顺序:
 *    1. 当前语言的 ERROR_MESSAGES[code]      ← 优先, 最贴近 UI
 *    2. 老 UPPERCASE code 别名映射后的 ERROR_MESSAGES
 *    3. backend message (NeoxError.message 透传)
 *    4. ERROR_CODES[code].defaultMessage[language]  ← neox-core 注册表的兜底
 *    5. code 字符串本身 (开发模式可见)
 */
export function translateError(
  code: string | undefined,
  language: Language,
  backendMessage?: string,
): ErrorMessage {
  if (!code) {
    return { message: backendMessage || (language === 'zh' ? '出错了' : 'An error occurred') };
  }

  const map = MAP_BY_LANG[language];
  const aliased = ERROR_CODE_ALIASES[code];

  /* 0. 只有自带 Key 的构建: 订阅类文案换成指向服务商的 */
  if (byokOnly()) {
    const byok = BYOK_BY_LANG[language];
    if (byok[code]) return byok[code];
    if (aliased && byok[aliased]) return byok[aliased];
  }

  /* 1. 直接命中 */
  if (map[code]) return map[code];

  /* 2. 老 code → 新 code 别名 */
  if (aliased && map[aliased]) return map[aliased];

  /* 3 + 4: 优先 backend 写的 message (可能带具体 ctx), 再 fallback core 注册表的默认 */
  if (backendMessage) {
    return { message: backendMessage };
  }
  const spec = ERROR_CODES[code] ?? (aliased ? ERROR_CODES[aliased] : undefined);
  if (spec) return { message: spec.defaultMessage[language] };

  /* 5. 兜底: 用 code 自己 */
  return { message: code };
}

/** 给个 code, 返回它推荐的 UI action (跟 backend ERROR_CODES 注册表里的一致) */
export function getErrorAction(code: string | undefined): ErrorActionKind | undefined {
  if (!code) return undefined;
  const spec = ERROR_CODES[code] ?? (ERROR_CODE_ALIASES[code] ? ERROR_CODES[ERROR_CODE_ALIASES[code]!] : undefined);
  /* 只有自带 Key 的构建没有充值页和登录 —— 这两种出路都换成去服务商设置 */
  if (byokOnly() && (spec?.nextAction === 'topup' || spec?.nextAction === 'login')) return 'open_providers';
  return spec?.nextAction;
}
