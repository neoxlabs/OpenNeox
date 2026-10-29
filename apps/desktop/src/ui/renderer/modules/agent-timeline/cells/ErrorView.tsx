import React from 'react';
import { useNeoxRuntimeOptional } from '../../../app/NeoxRuntimeContext';
/* 反馈通道 / 升级页走发行版能力钩子 —— 没有反馈通道的构建里错误卡不出「反馈」按钮 */
import { getEditionHook, type TimelineErrorFeedbackPayload } from '../../shell/editionHooks';
import { useI18n } from '../../../hooks/useI18n';
import { translateError, getErrorAction } from '../../../i18n/errors';
import { ERROR_CODES, ERROR_CODE_ALIASES, ErrorCategory } from '@neoxlabs/kernel/types/errors.js';
import type { TimelineErrorActionKind } from '../../../utils/workspaceUtils';
import { BusyCard } from './BusyCard';

/** 上游繁忙 / 不可用一类 (网关已自动换过线路仍失败) —— 用户没做错事, 走「服务正忙」卡而不是报错条 */
const BUSY_UPSTREAM_CODES = new Set(['upstream.unavailable', 'upstream.bad_gateway', 'upstream.circuit_open', 'system.busy', 'quota.rate_limited']);

type FeedbackAppInfo = {
  version?: string;
  environment?: string;
  platform?: string;
  arch?: string;
};

function getFeedbackSubmitErrorMessage(error: unknown, isZh: boolean): string {
  const err = error as { name?: string; code?: string; status?: number; message?: string } | null;
  if (err?.name === 'NeoxAuthError' || err?.code === 'NOT_AUTHENTICATED') {
    return isZh ? '请先登录 NeoxCloud 后再提交反馈' : 'Sign in to NeoxCloud before sending feedback.';
  }
  if (err?.status === 404) {
    return isZh ? 'NeoxCloud 反馈接口暂未部署' : 'NeoxCloud feedback endpoint is not deployed yet.';
  }
  if (err?.status === 401) {
    return isZh ? '登录已过期, 请重新登录后提交' : 'Session expired. Sign in again and retry.';
  }
  return err?.message || (isZh ? '反馈提交失败' : 'Failed to send feedback.');
}

/* ---------- error ----------
 *   action: 来自 NeoxError catalogue, 引导用户做下一步.
 *   - login/register → 派 'neox:login-required' 全局事件 (NeoxShellHost 接住弹 LoginPage)
 *   - topup          → openUpgradeUrl() 打开浏览器
 *   - retry          → 派 'neox:retry-last-prompt' (Composer 监听重发)
 *   - contact_admin  → 弹简单 alert (V1, 后续可换 mailto / IM)
 *   - wait / none    → 不渲染按钮
 *
 *  C3: code 命中 ErrorCodeRegistry 时, 走 translateError() 用当前语言翻译 message + hint + actionLabel.
 *    backend 显式传的 message/suggestion/action 优先 (兼容老调用), 没传才用 i18n 兜底.
 *    backend nextAction (topup/login/retry/...) 自动映射到这里的 action.kind, 不用 props 显式传 action.
 */
export const ErrorView: React.FC<{
  code?: string;
  message: string;
  suggestion?: string;
  action?: {
    kind: TimelineErrorActionKind;
    label: string;
    url?: string;
  };
  /** 同一轮里这个错误已经发生的次数 (>1 才显示) —— 重试再失败是原地更新这张卡, 不堆新卡,
   *  没有这个计数用户会以为"点了重试没反应"。 */
  repeatCount?: number;
  /** 最近一次发生的时刻 (已格式化的 HH:MM) —— 原地更新时 timestamp 保持第一次的值,
   *  卡片位置不动, 所以"又失败了一次"只能靠这个时间体现。跟 repeatCount 一起显示。 */
  lastAt?: string;
  /** 网关 request id (= request_logs.request_id).
   *  只有走 Neox Cloud 网关的错误有; BYOK 直连没有, 那种情况整行不渲染。 */
  requestId?: string;
}> = ({ code, message, suggestion, action, repeatCount, lastAt, requestId }) => {
  const { language } = useI18n();
  const runtime = useNeoxRuntimeOptional();
  const [feedbackOpen, setFeedbackOpen] = React.useState(false);
  const [feedbackNote, setFeedbackNote] = React.useState('');
  const [feedbackSubmitting, setFeedbackSubmitting] = React.useState(false);
  const [feedbackSubmittedId, setFeedbackSubmittedId] = React.useState<string | null>(null);
  const [feedbackError, setFeedbackError] = React.useState<string | null>(null);
  const [appInfo, setAppInfo] = React.useState<FeedbackAppInfo | null>(null);

  React.useEffect(() => {
    let disposed = false;
    void window.neox?.getAppInfo?.()
      .then((info) => {
        if (!disposed) setAppInfo(info);
      })
      .catch(() => {
        if (!disposed) setAppInfo(null);
      });
    return () => { disposed = true; };
  }, []);

  /* C3: 用 code 走 i18n 翻译, 命中就替换 message/suggestion/action.
   *   原 props (message/suggestion/action) 仅作 fallback — 若没 i18n entry 命中, 全部沿用旧行为. */
  const i18n = React.useMemo(() => {
    if (!code) return null;
    const tr = translateError(code, language, message);
    const act = getErrorAction(code) as string | undefined;
    const actionKind = act === 'topup' ? 'topup'
                     : act === 'login' ? 'login'
                     : act === 'retry' ? 'retry'
                     : act === 'open_providers' ? 'open_providers'
                     : act === 'switch_model' ? 'switch_model'
                     : act === 'switch_provider' ? 'open_providers'   /* 换 provider 语义上就是让用户选/加另一个, 直接引到设置 */
                     : undefined;
    return {
      message: tr.message,
      suggestion: tr.hint,
      action: actionKind && tr.actionLabel
        ? { kind: actionKind as any, label: tr.actionLabel, url: undefined as string | undefined }
        : undefined,
    };
  }, [code, language, message]);

  /* 优先用 props (caller 显式传的), 没传 fallback 到 i18n 翻译结果. */
  const rawMessage = (i18n?.message && (!message || message === code)) ? i18n.message : (message || i18n?.message || '');

  const isZhLang = language === 'zh';
  const finalRawMessage = rawMessage || (code
    ? (isZhLang ? `未知错误 · ${code}` : `Unknown error · ${code}`)
    : (isZhLang ? '出错了 · 请查看详情或重试' : 'An error occurred · Check details or retry')
  );

  const htmlError = React.useMemo(() => {
    const original = finalRawMessage.trimStart();
    /* 抓 "upstream Nxx" / "upstream HTTP Nxx" 前缀的状态码 */
    const prefixStatusMatch = original.match(/^upstream(?:\s+HTTP)?\s+(\d{3})[:\s]/i);
    const stripped = prefixStatusMatch ? original.slice(prefixStatusMatch[0].length).trimStart() : original;
    if (!/^<(!DOCTYPE\s+html|html|head|body)\b/i.test(stripped)) return null;
    const titleMatch = stripped.match(/<title[^>]*>([^<]{1,120})<\/title>/i);
    const h1Match = stripped.match(/<h1[^>]*>([^<]{1,120})<\/h1>/i);
    const statusFromCode = (code || '').match(/(\d{3})/);
    const statusFromBody = stripped.match(/\b(404|403|500|502|503|504)\b/);
    const status = prefixStatusMatch?.[1] || statusFromCode?.[1] || statusFromBody?.[1] || undefined;
    const title = titleMatch?.[1]?.trim() || h1Match?.[1]?.trim();
    /* upstream 标志: 用于区分 "客户端到 neox 网关的 4xx" vs "neox 网关到上游 LLM 的 4xx".
     * 前者文案要让用户重试/重登, 后者要建议换模型 (本机 neox 网关是好的). */
    return { status, title, raw: finalRawMessage, isUpstream: !!prefixStatusMatch };
  }, [finalRawMessage, code]);

  const isZh = language === 'zh';
  const effectiveMessage = React.useMemo(() => {
    if (!htmlError) return finalRawMessage;
    const parts: string[] = [];
    if (htmlError.isUpstream) {
      parts.push(isZh ? '上游模型返回错误' : 'Upstream model returned an error');
    } else {
      parts.push(isZh ? '服务返回了错误页' : 'Service returned an error page');
    }
    if (htmlError.status) parts.push(`HTTP ${htmlError.status}`);
    return parts.join(' · ');
  }, [htmlError, finalRawMessage, isZh]);

  const effectiveSuggestion = React.useMemo(() => {
    if (!htmlError) return suggestion ?? i18n?.suggestion;
    const fallback = suggestion ?? i18n?.suggestion;
    /* upstream 4xx → 跟当前选的模型有关 (上游 LLM 那边不接受), 建议换模型
     * 普通 4xx → 跟客户端访问 neox 网关有关, 建议重试/重登 */
    if (htmlError.isUpstream && htmlError.status && /^4\d\d$/.test(htmlError.status)) {
      return isZh ? '该模型暂不可用, 请换一个模型试试' : 'This model is unavailable. Try a different one.';
    }
    if (htmlError.status === '404' || htmlError.status === '503') {
      return isZh ? '服务暂时无法访问, 请稍后重试或换个模型' : 'Service unavailable. Try again or pick another model.';
    }
    if (htmlError.status === '403' || htmlError.status === '401') {
      if (!getEditionHook('hasAccount')) {
        return isZh ? '鉴权失败 — 检查这个服务商的 API Key' : 'Authorization failed — check the API key for this provider.';
      }
      return isZh
        ? '鉴权失败 — 订阅模型请重新登录, 自配服务商请检查 API Key'
        : 'Authorization failed — sign in again for subscription models, or check your API key for your own provider.';
    }
    if (htmlError.status && /^5\d\d$/.test(htmlError.status)) {
      return isZh ? '服务繁忙, 稍后再试' : 'Service is busy. Please retry shortly.';
    }
    return fallback;
  }, [htmlError, suggestion, i18n?.suggestion, isZh]);


  const isAuthCode = code === 'UNAUTHORIZED'
    || code === 'FORBIDDEN'
    || code?.toLowerCase().startsWith('auth.');
  const effectiveAction = (isAuthCode && i18n?.action) ? i18n.action : (action ?? i18n?.action);

  const handleAction = React.useCallback(() => {
    if (!effectiveAction) return;
    switch (effectiveAction.kind) {
      case 'login':
      case 'register':
        window.dispatchEvent(new CustomEvent('neox:login-required', {
          detail: { from: 'error-card', wantRegister: effectiveAction.kind === 'register' },
        }));
        break;
      case 'topup':
        if (effectiveAction.url) {
          try { window.open(effectiveAction.url, '_blank', 'noopener'); } catch { /* ignore */ }
        } else {
          /* 复用现成的 openUpgradeUrl — 走 admin 配置的升级页 */
          try { getEditionHook('openUpgradeUrl')(); } catch { /* ignore */ }
        }
        break;
      case 'retry':
        window.dispatchEvent(new CustomEvent('neox:retry-last-prompt', { detail: { from: 'error-card' } }));
        break;
      case 'open_providers':
        try { localStorage.setItem('neox-settings-initial-tab', 'providers'); } catch { /* ignore */ }
        window.dispatchEvent(new CustomEvent('neox:open-settings', {
          detail: { tab: 'providers', from: 'error-card', code },
        }));
        break;
      case 'contact_admin': {
        /* 商用应避免 "请联系管理员" 这种反面文案 — 走"提交反馈"流程, 用户能找到官方支持入口.
         * 同时把错码 + 消息复制到剪贴板, 方便用户在反馈页粘贴. */
        const errSummary = `Neox error report\nTime: ${new Date().toISOString()}\nCode: ${code ?? 'unknown'}${requestId ? `\nRequest: ${requestId}` : ''}\nMessage: ${effectiveMessage}`;
        try { void navigator.clipboard?.writeText(errSummary); } catch { /* ignore */ }
        void import('../../../components/notifyEvents').then(m => m.dispatchHint(
          isZh ? '错误详情已复制. 正在打开反馈页…' : 'Error details copied. Opening the feedback page…', 'info',
        ));
        void import('../../../utils/productLinks').then((linksMod) => {
          const url = linksMod.productLinks.feedback;
          try {
            const opener = (window as any).neox?.openExternal as ((u: string) => Promise<void>) | undefined;
            if (typeof opener === 'function') void opener(url);
            else window.open(url, '_blank', 'noopener,noreferrer');
          } catch (e) {
            console.warn('[TimelineStep] open feedback failed:', e);
          }
        });
        break;
      }
      case 'switch_model':
        /* 高负载/熔断时唯一真正管用的动作 —— 直接把输入框那颗模型选择器展开,
         * 别让用户自己去找。TimelineComposer 监听这个事件。 */
        window.dispatchEvent(new CustomEvent('neox:open-model-picker', {
          detail: { from: 'error-card', code },
        }));
        break;
      case 'rotate_anonymous':
        import('../../../components/notifyEvents').then(m => m.dispatchOpFailed({
          op: isZh ? '发送消息' : 'Send message',
          message: !getEditionHook('hasAccount')
            ? (isZh ? '还没有可用的模型：去 设置 → 模型服务 添加你自己的 API Key。' : 'No model yet: add your own API key in Settings → Model services.')
            : isZh
              ? '请先在 API 服务商里配置 BYOK 模型后再发送；Neox Cloud 登录/付费能力可按需使用。'
              : 'Configure a BYOK model under API providers before sending; Neox Cloud sign-in/paid features are optional.',
        })).catch(() => { /* ignore */ });
        break;
      case 'wait':
      case 'none':
      default:
        /* 不渲染按钮也不会到这里 */
        break;
    }
  }, [effectiveAction, code, requestId, effectiveMessage, isZh]);

  /* wait / none / 没 label → 不展示按钮 */
  const showButton = !!effectiveAction && effectiveAction.kind !== 'wait' && effectiveAction.kind !== 'none' && !!effectiveAction.label;

  /* 复制错误详情 — 方便用户在反馈群/issue 里粘贴, 不依赖 contact_admin action 才有.
   *   HTML 错误页的话原始 HTML 一起复制 (调试要看完整 dump). */
  const handleCopyDetails = React.useCallback(() => {
    const lines = [
      `Neox · ${new Date().toISOString()}`,
      code ? `Code: ${code}` : null,
      requestId ? `Request: ${requestId}` : null,
      `Message: ${effectiveMessage}`,
      effectiveSuggestion ? `Hint: ${effectiveSuggestion}` : null,
      htmlError ? `\n--- Raw HTML payload ---\n${htmlError.raw}` : null,
    ].filter(Boolean).join('\n');
    try {
      void navigator.clipboard?.writeText(lines);
      void import('../../../components/notifyEvents').then((m) => m.dispatchHint(isZh ? '错误详情已复制' : 'Error details copied', 'success'));
    } catch {
      void import('../../../components/notifyEvents').then((m) => m.dispatchHint(isZh ? '复制失败 — 浏览器拒绝剪贴板访问' : 'Copy failed — clipboard access denied', 'warning'));
    }
  }, [code, requestId, effectiveMessage, effectiveSuggestion, htmlError, isZh]);

  /* id 单独一个复制入口 —— 客服要的就是这一串, 让用户从整段详情里挑出来太苛刻了. */
  const handleCopyRequestId = React.useCallback(() => {
    if (!requestId) return;
    try {
      void navigator.clipboard?.writeText(requestId);
      void import('../../../components/notifyEvents').then((m) => m.dispatchHint(isZh ? '请求 ID 已复制' : 'Request ID copied', 'success'));
    } catch {
      void import('../../../components/notifyEvents').then((m) => m.dispatchHint(isZh ? '复制失败 — 浏览器拒绝剪贴板访问' : 'Copy failed — clipboard access denied', 'warning'));
    }
  }, [requestId, isZh]);

  const feedbackPreviewContext = React.useMemo(() => {
    return [
      code || 'unknown',
      requestId,
      runtime?.selectedModel?.id || runtime?.activeSession?.modelId,
      appInfo?.version,
    ].filter(Boolean).join(' · ');
  }, [appInfo?.version, code, requestId, runtime?.activeSession?.modelId, runtime?.selectedModel?.id]);

  const handleToggleFeedback = React.useCallback(() => {
    setFeedbackOpen((prev) => !prev);
    setFeedbackError(null);
  }, []);

  const handleSubmitFeedback = React.useCallback(async () => {
    if (feedbackSubmitting) return;
    setFeedbackSubmitting(true);
    setFeedbackError(null);
    setFeedbackSubmittedId(null);
    const activeSession = runtime?.activeSession;
    const payload: TimelineErrorFeedbackPayload = {
      schemaVersion: 1,
      source: 'desktop.timeline.error',
      severity: 'error',
      privacyMode: 'minimal',
      userNote: feedbackNote.trim() || undefined,
      error: {
        code,
        message: effectiveMessage,
        suggestion: effectiveSuggestion,
        requestId,
      },
      context: {
        selectedModelId: runtime?.selectedModel?.id || activeSession?.modelId,
        appVersion: appInfo?.version,
        appEnvironment: appInfo?.environment,
        platform: appInfo?.platform,
        arch: appInfo?.arch,
        occurredAt: new Date().toISOString(),
      },
    };
    try {
      const submit = getEditionHook('submitTimelineErrorFeedback');
      if (!submit) return;
      const result = await submit(payload);
      const id = result.feedbackId || result.id || null;
      setFeedbackSubmittedId(id || 'submitted');
      void import('../../../components/notifyEvents').then((m) => m.dispatchHint(
        id
          ? (isZh ? `反馈已提交: ${id}` : `Feedback sent: ${id}`)
          : (isZh ? '反馈已提交' : 'Feedback sent'),
        'success',
      ));
    } catch (error) {
      const nextMessage = getFeedbackSubmitErrorMessage(error, isZh);
      setFeedbackError(nextMessage);
      const err = error as { name?: string; code?: string } | null;
      if (err?.name === 'NeoxAuthError' || err?.code === 'NOT_AUTHENTICATED') {
        window.dispatchEvent(new CustomEvent('neox:login-required', {
          detail: { from: 'timeline-error-feedback' },
        }));
      }
    } finally {
      setFeedbackSubmitting(false);
    }
  }, [
    appInfo,
    code,
    effectiveMessage,
    effectiveSuggestion,
    feedbackNote,
    feedbackSubmitting,
    isZh,
    runtime,
  ]);

  /* 高负载不该长得像致命错误.
   *
   *   用户在高峰期看到一个红色报错, 第一反应是"我的账号出问题了 / 我做错了什么",
   *   而真相是"人多, 等一下就好, 而且我们已经在自动重试". 这两种处境该有的动作完全不同,
   *   却共用同一个红框, 只在文案里区分 —— 而错误卡的文案恰恰是最容易被略过的部分.
   *
   *   判据用 kernel 的 category(经别名解析), 不用码前缀: 网关和 kernel 是两套词表,
   *   按前缀判会漏掉 system.busy 这类. */
  const isHighLoad = React.useMemo(() => {
    if (!code) return false;
    const def = ERROR_CODES[code] ?? (ERROR_CODE_ALIASES[code] ? ERROR_CODES[ERROR_CODE_ALIASES[code]] : undefined);
    return def?.category === ErrorCategory.RETRYABLE_RATE_LIMIT;
  }, [code]);

  const isQuotaLimit = React.useMemo(() => {
    if (!code) return false;
    const def = ERROR_CODES[code] ?? (ERROR_CODE_ALIASES[code] ? ERROR_CODES[ERROR_CODE_ALIASES[code]] : undefined);
    return def?.category === ErrorCategory.FATAL_LIMIT;
  }, [code]);

  /* 「服务正忙」单独一张卡 (BusyCard): 高负载类 + 网关换过线路仍不通的上游 5xx。
   *   点重试 / 换模型 / × 后收起; 同一轮再失败 (repeatCount 变了) 重新出现。 */
  const isBusy = isHighLoad || (!!code && BUSY_UPSTREAM_CODES.has(ERROR_CODE_ALIASES[code] ?? code));
  const [busyDismissedAt, setBusyDismissedAt] = React.useState<number | null>(null);
  if (isBusy) {
    if (busyDismissedAt != null && busyDismissedAt === (repeatCount ?? 1)) return null;
    return (
      <BusyCard
        isZh={isZh}
        modelName={runtime?.selectedModel?.name ?? null}
        repeatCount={repeatCount}
        lastAt={lastAt}
        requestId={requestId}
        onDismiss={() => setBusyDismissedAt(repeatCount ?? 1)}
      />
    );
  }

  return (
    <div className={`atl-error${isHighLoad ? ' atl-error--busy' : ''}${isQuotaLimit ? ' atl-error--limit' : ''}`}>
      <div className="atl-error__head">
        {isHighLoad && (
          <span className="atl-error__busy-icon" aria-hidden>
            <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1.5 8.2h2.6l1.4-3.4 2 6.4 1.5-4.2 1 1.2h2.5" />
            </svg>
          </span>
        )}
        {code && !isHighLoad && !isQuotaLimit && <span className="atl-error__code">{code}</span>}
        <span className="atl-error__msg" title={effectiveMessage}>{effectiveMessage}</span>
        {typeof repeatCount === 'number' && repeatCount > 1 && (
          <span className="atl-error__repeat">
            {isZh ? `失败 ${repeatCount} 次` : `failed ${repeatCount}×`}
            {!!lastAt && (
              /* 重试再次撞同一个错时, 这张卡的 id / 位置 / 时间戳全不变 —— 不带上"最近一次"
               * 的时刻, 界面就是一动不动, 用户分不清"点了没反应"还是"又失败了一次"。 */
              <span className="atl-error__repeat-at">
                {isZh ? ` · 最近 ${lastAt}` : ` · last ${lastAt}`}
              </span>
            )}
          </span>
        )}
        {showButton && (
          <button
            type="button"
            className={`atl-error__cta atl-error__cta--${effectiveAction!.kind}`}
            onClick={handleAction}
          >
            {effectiveAction!.label}
          </button>
        )}
        <button
          type="button"
          className="atl-error__copy"
          onClick={handleCopyDetails}
          title={language === 'zh' ? '复制错误详情' : 'Copy error details'}
          aria-label={language === 'zh' ? '复制错误详情' : 'Copy error details'}
        >
          ⧉
        </button>
        {getEditionHook('submitTimelineErrorFeedback') && (
          <button
            type="button"
            className="atl-error__copy atl-error__feedback-toggle"
            onClick={handleToggleFeedback}
            title={language === 'zh' ? '反馈此错误' : 'Report this error'}
            aria-label={language === 'zh' ? '反馈此错误' : 'Report this error'}
            aria-expanded={feedbackOpen}
          >
            {language === 'zh' ? '反馈' : 'Report'}
          </button>
        )}
      </div>
      {effectiveSuggestion && <div className="atl-error__tip">{effectiveSuggestion}</div>}
      {requestId && (
        <button
          type="button"
          className="atl-error__reqid"
          onClick={handleCopyRequestId}
          title={isZh ? '点击复制. 报障时把它给我们, 能直接定位到这次请求' : 'Click to copy. Give it to support to pinpoint this request.'}
        >
          ID {requestId}
        </button>
      )}
      {htmlError && (
        <details className="atl-error__html-raw">
          <summary>{isZh ? '查看原始 HTML 内容' : 'View raw HTML payload'}</summary>
          <pre>{htmlError.raw.slice(0, 4000)}{htmlError.raw.length > 4000 ? '\n…(truncated)' : ''}</pre>
        </details>
      )}
      {/* atl-error__actions 已移除 —— 按钮上移进了 atl-error__head, 见那里的注释。 */}
      {feedbackOpen && (
        <div className="atl-error__feedback">
          <div className="atl-error__feedback-head">
            <div>
              <div className="atl-error__feedback-title">
                {isZh ? '反馈到 NeoxCloud' : 'Send to NeoxCloud'}
              </div>
              <div className="atl-error__feedback-meta">
                {isZh ? '只提交错误信息和版本环境，不带项目内容' : 'Only sends error and app environment, not project content.'}
              </div>
            </div>
            {feedbackSubmittedId && (
              <span className="atl-error__feedback-ok">
                {feedbackSubmittedId === 'submitted' ? (isZh ? '已提交' : 'Sent') : feedbackSubmittedId}
              </span>
            )}
          </div>
          <div className="atl-error__feedback-preview" title={feedbackPreviewContext}>
            {feedbackPreviewContext}
          </div>
          <textarea
            className="atl-error__feedback-note"
            value={feedbackNote}
            onChange={(event) => setFeedbackNote(event.target.value)}
            placeholder={isZh ? '补充复现步骤（不要填写密钥或个人信息，可选）' : 'Add repro steps. Do not include secrets or personal data (optional).'}
            rows={3}
          />
          {feedbackError && <div className="atl-error__feedback-error">{feedbackError}</div>}
          <div className="atl-error__feedback-actions">
            <button
              type="button"
              className="atl-error__cta atl-error__cta--primary"
              onClick={handleSubmitFeedback}
              disabled={feedbackSubmitting}
            >
              {feedbackSubmitting ? (isZh ? '提交中…' : 'Sending...') : (isZh ? '提交反馈' : 'Send feedback')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
