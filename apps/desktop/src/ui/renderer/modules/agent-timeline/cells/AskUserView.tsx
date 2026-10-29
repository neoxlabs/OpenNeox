import React, { useCallback, useEffect, useState } from 'react';
import { useAskDockShown } from '../askDockPresence';
import type { AskUserQuestion } from '../types';
import { useNeoxRuntimeOptional } from '../../../app/NeoxRuntimeContext';
import { useI18n } from '../../../hooks/useI18n';
import { useAgentModeVariant } from '../../../hooks/useAgentModeVariant';

function formatRemain(sec: number, isZh: boolean): string {
  if (isZh) {
    if (sec <= 0) return '0 秒';
    if (sec < 60) return `${sec} 秒`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s === 0 ? `${m} 分` : `${m} 分 ${s} 秒`;
  }
  if (sec <= 0) return '0s';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

export function deferToAgentAnswer(isZh: boolean): string {
  return isZh
    ? '这些选项我都不选，请你根据当前上下文自行判断。'
    : 'None of these options — please decide based on the current context.';
}

export function clampModelText(v: unknown, max: number): string {
  const one = String(v ?? '')
    /* eslint-disable-next-line no-control-regex */
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

export const AskUserView: React.FC<{
  requestId?: string;
  status: 'waiting' | 'answered' | 'timeout' | 'interrupted';
  questions: AskUserQuestion[];
  error?: string;
  attemptedAnswers?: Record<string, string>;
  createdAt?: number;
  timeoutSec?: number;
}> = ({ requestId, status, questions, error, attemptedAnswers, createdAt, timeoutSec }) => {
  const runtime = useNeoxRuntimeOptional();
  const { isZh } = useI18n();
  const { isCode } = useAgentModeVariant();

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status !== 'waiting' || !createdAt || !timeoutSec) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status, createdAt, timeoutSec]);

  const remainingSec: number | null = (() => {
    if (status !== 'waiting' || !createdAt || !timeoutSec) return null;
    return Math.max(0, Math.ceil((createdAt + timeoutSec * 1000 - now) / 1000));
  })();
  const isUrgent = remainingSec !== null && remainingSec <= 30;
  const [local, setLocal] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const q of questions) if (q.answer) init[q.question] = q.answer;
    if (attemptedAnswers) {
      for (const [k, v] of Object.entries(attemptedAnswers)) init[k] = v;
    }
    return init;
  });
  const [submitting, setSubmitting] = useState(false);
  const [orphanHidden, setOrphanHidden] = useState(false);
  /* 这个 ask 是不是正被输入框上方那颗药丸接管 —— 接管了就让位收成一行 */
  const dockOwns = useAskDockShown(requestId);

  const allAnswered = questions.every((q) => !!local[q.question]);
  const buildRejectedAnswers = useCallback((): Record<string, string> => {
    const next: Record<string, string> = {};
    for (const q of questions) {
      next[q.question] = local[q.question] || deferToAgentAnswer(isZh);
    }
    return next;
  }, [local, questions, isZh]);
  const handlePick = (q: string, label: string) => {
    if (status !== 'waiting') return;
    setLocal((prev) => ({ ...prev, [q]: label }));
  };
  const handleSubmit = async () => {
    if (!requestId || !runtime) return;
    setSubmitting(true);
    try {
      await runtime.answerAskUser(requestId, local);
    } finally {
      setSubmitting(false);
    }
  };
  const handleReject = async () => {
    if (!runtime) return;
    const answers = buildRejectedAnswers();
    setLocal(answers);
    setSubmitting(true);
    try {
      if (requestId && !error) {
        await runtime.answerAskUser(requestId, answers);
      } else {
        /* ask_user 已经 orphan/pending entry not found 时，再走 reply 通道只会重复失败；
         * 拒绝/跳过应直接转成普通消息，让 agent 能继续推进。 */
        const text = questions.map((q) => `Q: ${q.question}\nA: ${answers[q.question]}`).join('\n\n');
        if (text) await runtime.sendPrompt(text);
      }
    } finally {
      setSubmitting(false);
    }
  };
  const handleDismiss = async () => {
    if (!requestId || !runtime) return;
    setSubmitting(true);
    try {
      await runtime.answerAskUser(requestId, { __dismiss__: '1' } as any);
    } finally {
      setSubmitting(false);
    }
  };
  /* orphan 场景: 把答案当一条普通 user message 发. agent 看到自然语言后会续接,
   * 跟"正常 ask_user 答复"语义一样, 只是绕过死掉的 toolCallId Promise. */
  const handleResendAsMessage = async () => {
    if (!runtime) return;
    const parts: string[] = [];
    for (const q of questions) {
      const ans = local[q.question];
      if (ans) parts.push(`Q: ${q.question}\nA: ${ans}`);
    }
    const text = parts.join('\n\n');
    if (!text) return;
    setSubmitting(true);
    try {
      await runtime.sendPrompt(text);
    } finally {
      setSubmitting(false);
    }
  };

  if (status !== 'waiting' && !error) {
    const label = status === 'answered' ? (isZh ? '已回答' : 'Answered')
      : status === 'timeout' ? (isZh ? '已超时' : 'Timed out')
        : (isZh ? '已中断' : 'Interrupted');
    const questionInHead = questions.length === 1;
    if (isCode) {
      return (
        <div className={`nx-ask-done is-${status}`}>
          {questions.map((q, qi) => (
            <div key={qi} className="nx-ask-done__item">
              <div className="nx-ask-done__q">{q.question}</div>
              {q.answer ? (
                <div className="nx-ask-done__a">
                  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m3.5 8.5 3 3 6-7" /></svg>
                  <span>{q.answer}</span>
                </div>
              ) : (
                <div className="nx-ask-done__a is-none">{label}</div>
              )}
            </div>
          ))}
        </div>
      );
    }
    return (
      <div className={`atl-ask atl-ask--settled is-${status}`}>
        {questions.map((q, qi) => (
          <div key={qi} className="atl-ask__settled-row">
            <span className="atl-ask__settled-tag">{label}</span>
            {!questionInHead && (
              <span className="atl-ask__settled-q" title={q.question}>{q.question}</span>
            )}
            {q.answer
              ? <span
                  className={`atl-ask__settled-a${questionInHead ? ' is-sole' : ''}`}
                  title={q.answer}
                >{q.answer}</span>
              /* 没答案(超时/中断)且问题又不显示时, 这一行就只剩一个状态标 —— 太空。
                 这种情况下把问题补回来, 让它至少说清"哪个问题超时了"。 */
              : questionInHead && (
                  <span className="atl-ask__settled-q" title={q.question}>{q.question}</span>
                )}
          </div>
        ))}
      </div>
    );
  }

  if (dockOwns) {
    return (
      <div className="atl-ask atl-ask--settled is-waiting">
        <div className="atl-ask__settled-row">
          <span className="atl-ask__settled-tag">{isZh ? '等你选择' : 'Your choice'}</span>
          <span className="atl-ask__settled-q" title={questions[0]?.question}>
            {isZh ? '在下方输入框上作答' : 'Answer above the composer'}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={`atl-ask is-${status}${error ? ' is-orphan' : ''}`}>
      <div className="atl-ask__origin">
        {isZh ? 'Agent 想问你' : 'The agent is asking'}
      </div>
      {questions.map((q, qi) => {
        const picked = local[q.question];
        return (
          <div key={qi} className="atl-ask__q">
            <div className="atl-ask__q-text">{clampModelText(q.question, 400)}</div>
            {q.options.length > 0 && (
              <div className="atl-ask__opts">
                {q.options.map((opt, oi) => {
                  const isPicked = picked === opt.label;
                  return (
                    <button
                      key={oi}
                      type="button"
                      className={`atl-ask__opt${isPicked ? ' is-picked' : ''}`}
                      disabled={status !== 'waiting' || submitting}
                      onClick={() => handlePick(q.question, opt.label)}
                      title={opt.description}
                    >
                      <span className="atl-ask__opt-label">{clampModelText(opt.label, 80)}</span>
                      {opt.description && (
                        <span className="atl-ask__opt-desc">{clampModelText(opt.description, 200)}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            <input
              type="text"
              className={`atl-ask__free${picked && !q.options.some((o) => o.label === picked) ? ' is-active' : ''}`}
              value={q.options.some((o) => o.label === picked) ? '' : (picked ?? '')}
              disabled={status !== 'waiting' || submitting}
              placeholder={isZh ? '或者直接写你的想法…' : 'Or type your own answer…'}
              onChange={(e) => handlePick(q.question, e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') e.stopPropagation(); }}
            />
          </div>
        );
      })}
      {status === 'waiting' && error && !orphanHidden && (
        <div className="atl-ask__orphan">
          <button
            type="button"
            className="atl-ask__orphan-close"
            onClick={() => setOrphanHidden(true)}
            title={isZh ? '关闭提示' : 'Dismiss notice'}
            aria-label={isZh ? '关闭过期提示' : 'Dismiss expired notice'}
          >×</button>
          <div className="atl-ask__orphan-msg">
            <span aria-hidden="true">⏱</span>
            <span>{isZh
              ? '这个问题已过期，原回答通道已不可用。'
              : 'This question has expired — the original reply channel is no longer available.'}</span>
          </div>
          <div className="atl-ask__orphan-sub">
            {isZh
              ? '你可以把当前选择作为普通消息发送，或直接让 AI 根据上下文继续判断。'
              : 'You can send your current choices as a regular message, or let the AI decide from context.'}
          </div>
          <div className="atl-ask__orphan-actions">
            <button
              type="button"
              className="atl-ask__resend"
              disabled={!allAnswered || submitting || !runtime}
              onClick={handleResendAsMessage}
              title={isZh ? '把当前选择拼成一条普通消息发回 agent' : 'Send your current choices back to the agent as a regular message'}
            >{isZh ? '改用消息发送' : 'Send as message'}</button>
            <button
              type="button"
              className="atl-ask__reject"
              disabled={submitting || !runtime}
              onClick={handleReject}
              title={isZh ? '拒绝这些选项，让 AI 根据当前上下文继续判断' : 'Decline these options and let the AI decide from the current context'}
            >{isZh ? '拒绝/让 AI 判断' : 'Decline — let AI decide'}</button>
          </div>
        </div>
      )}
      {status === 'waiting' && error && orphanHidden && (
        <div className="atl-ask__hint is-warn">{isZh
          ? '该问题已过期，已不再等待回答'
          : 'This question has expired and is no longer awaiting an answer'}</div>
      )}
      {status === 'waiting' && !error && (
        <div className="atl-ask__foot">
          {/* 选满之后原来会把提示换成「点击下方提交答复」—— 而「提交答复」那颗按钮就在
              同一行右边, 且此刻刚刚从灰变亮。已经看得见的东西不需要再用一句话指一遍。
              选满就让这行消失, 底部只剩三个动作, 干净。 */}
          {!allAnswered && (
            <span className="atl-ask__hint">
              {isZh ? '请为每个问题选择一个选项' : 'Pick an option for each question'}
            </span>
          )}
          {remainingSec !== null && (
            <span
              className={`atl-ask__countdown${isUrgent ? ' is-urgent' : ''}`}
              style={{
                marginLeft: 8,
                fontSize: 12,
                color: isUrgent ? 'var(--neox-err, #ef4444)' : 'var(--neox-fg-hint, #9ca3af)',
                fontWeight: isUrgent ? 600 : 400,
                animation: isUrgent ? 'atl-pulse 1s ease-in-out infinite' : undefined,
              }}
              title={isZh
                ? `${timeoutSec} 秒未回答会自动超时, 让 AI 按合理 default 继续推进`
                : `Auto-times out after ${timeoutSec}s so the AI can continue with sensible defaults`}
            >
              {isZh ? `⏱ 剩 ${formatRemain(remainingSec, isZh)}` : `⏱ ${formatRemain(remainingSec, isZh)} left`}
            </span>
          )}
          <div className="atl-ask__actions">
            <button
              type="button"
              className="atl-ask__reject"
              disabled={submitting || !runtime}
              onClick={handleReject}
              title={isZh ? '不选这些选项, 让 AI 按当前上下文自己判断' : 'Decline these options and let the AI decide from the current context'}
            >{isZh ? '让 AI 自己定' : 'Let AI decide'}</button>
            <button
              type="button"
              className="atl-ask__submit"
              disabled={!allAnswered || !requestId || submitting}
              onClick={handleSubmit}
            >
              {submitting ? (isZh ? '提交中…' : 'Submitting…') : (isZh ? '提交答复' : 'Submit answers')}
            </button>
            <button
              type="button"
              className="atl-ask__dismiss"
              disabled={submitting || !requestId || !runtime}
              onClick={handleDismiss}
              title={isZh ? '关掉这张卡 —— 不回答, AI 按默认继续' : 'Close this card — no answer, AI continues with defaults'}
              aria-label={isZh ? '关掉' : 'Close'}
            >
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor"
                strokeWidth="1.6" strokeLinecap="round" aria-hidden>
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        </div>
      )}
      {status === 'answered' && <div className="atl-ask__hint is-done">{isZh ? '✓ 已回答' : '✓ Answered'}</div>}
      {status === 'timeout' && <div className="atl-ask__hint is-warn">{isZh ? '⏱ 已超时' : '⏱ Timed out'}</div>}
      {status === 'interrupted' && <div className="atl-ask__hint is-warn">{isZh ? '已中断，等待已停止' : 'Interrupted — no longer waiting'}</div>}
    </div>
  );
};
