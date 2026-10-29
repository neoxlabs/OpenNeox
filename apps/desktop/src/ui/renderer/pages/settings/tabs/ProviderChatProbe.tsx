import React from 'react';
import { CustomSelect } from '../../../components/CustomSelect';
import { httpStatusHint } from '../utils/httpStatusHint.js';

export interface ChatProbeBase {
  providerId?: string; protocol?: string; baseUrl?: string; urlSuffix?: string; apiKey?: string;
  model: string; claudeCodeMode?: 'auto' | 'on' | 'off';
}

type ProbeState =
  | { status: 'idle' }
  | { status: 'sending' }
  | { status: 'done'; ok: boolean; reply?: string; reasoning?: string; latencyMs: number;
      inputTokens?: number; outputTokens?: number; error?: string; httpStatus?: number;
      streaming?: { verdict: 'real' | 'buffered' | 'unknown'; chunks: number; firstTokenMs: number | null; spreadMs: number } };

const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;

export const ProviderTestPopover: React.FC<{
  zh: boolean;
  models: string[];
  model: string;
  onModelChange: (m: string) => void;
  /** 触发父组件的「测试连接」(结果由 connection 渲染) */
  runConnection: (model: string) => void;
  connection: React.ReactNode;
  /** 现在表单里填的这一套; 缺东西时返回一句错误 */
  getBase: (model: string) => ChatProbeBase | { error: string };
  onClose: () => void;
}> = ({ zh, models, model, onModelChange, runConnection, connection, getBase, onClose }) => {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [prompt, setPrompt] = React.useState('hi');
  const [chat, setChat] = React.useState<ProbeState>({ status: 'idle' });
  const [showReasoning, setShowReasoning] = React.useState(false);
  const seq = React.useRef(0);

  const send = React.useCallback(async (text: string, forModel: string) => {
    const base = getBase(forModel);
    if ('error' in base) { setChat({ status: 'done', ok: false, latencyMs: 0, error: base.error }); return; }
    const my = ++seq.current;
    setShowReasoning(false);
    setChat({ status: 'sending' });
    try {
      const r = await (window as any).neox?.providerChatProbe?.({ ...base, prompt: text.trim() || 'hi' });
      if (!r) throw new Error(zh ? '桌面 IPC 未就绪 (重启一下 Neox)' : 'Desktop IPC not ready (restart Neox)');
      if (my === seq.current) setChat({ status: 'done', ...r });
    } catch (e: any) {
      if (my === seq.current) setChat({ status: 'done', ok: false, latencyMs: 0, error: String(e?.message ?? e) });
    }
  }, [getBase, zh]);

  /* 打开时 / 换模型时: 连接 + 对话一起跑 —— 用户点「测试」要的就是"它到底能不能用" */
  React.useEffect(() => {
    if (!model) return;
    runConnection(model);
    void send('hi', model);
    setPrompt('hi');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  /* 点外面 / Esc 关。下拉菜单是 portal 到 body 的, 点它不算"外面" */
  React.useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || ref.current?.contains(t) || t.closest('.custom-select-menu, [role="listbox"]')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [onClose]);

  return (
    <div ref={ref} className="apiv2__popover provider-test" role="dialog" aria-label={zh ? '测试' : 'Test'}>
      <div className="provider-test__head">
        <span className="provider-test__title">{zh ? '测试' : 'Test'}</span>
        {models.length > 1 ? (
          <CustomSelect
            className="apiv2-test-model"
            value={model}
            onChange={(v: string) => onModelChange(v)}
            options={models.map((m) => ({ value: m, label: m }))}
          />
        ) : (
          <span className="provider-test__model">{model || (zh ? '还没有模型' : 'No model yet')}</span>
        )}
      </div>

      <div className="provider-test__row">
        <span className="provider-test__label">{zh ? '连接' : 'Connection'}</span>
        <span className="provider-test__value">{connection}</span>
      </div>

      <div className="provider-test__label provider-test__label--block">{zh ? '对话' : 'Chat'}</div>
      <div className="provider-test__chat">
        {chat.status === 'sending' && (
          <div className="provider-probe__wait neox-text-shimmer">{zh ? `正在等 ${model} 回复…` : `Waiting for ${model}…`}</div>
        )}
        {chat.status === 'done' && !chat.ok && (
          <div className="provider-probe__error">
            {(() => {
              const hint = httpStatusHint(chat.httpStatus, zh);
              return hint && chat.error ? `${hint} · ${chat.error}` : (chat.error || hint || (zh ? '发送失败' : 'Failed'));
            })()}
          </div>
        )}
        {chat.status === 'done' && chat.ok && (
          <>
            <div className={`provider-probe__reply${chat.reply ? '' : ' is-empty'}`}>
              {chat.reply || (zh ? '连上了，但模型没有回复正文（可能只输出了思考，或被截断）。' : 'Connected, but the model returned no text (thinking only, or cut off).')}
            </div>
            <div className="provider-probe__meta">
              <span>{secs(chat.latencyMs)}</span>
              {chat.streaming?.firstTokenMs != null && (
                <span>{zh ? `首字 ${secs(chat.streaming.firstTokenMs)}` : `first token ${secs(chat.streaming.firstTokenMs)}`}</span>
              )}
              {chat.streaming?.verdict === 'buffered' && (
                <span className="provider-probe__warn" title={zh
                  ? `回复在 ${chat.streaming.chunks} 块、${chat.streaming.spreadMs}ms 内全部到齐 —— 中转攒完才发, 聊天时会先转圈再整段出现`
                  : `The reply arrived in ${chat.streaming.chunks} chunk(s) within ${chat.streaming.spreadMs}ms — the relay buffers it, so chats spin first and then show everything at once`}>
                  {zh ? '假流式' : 'Fake streaming'}
                </span>
              )}
              {chat.streaming?.verdict === 'real' && <span>{zh ? '流式正常' : 'Streams normally'}</span>}
              {chat.inputTokens != null && chat.outputTokens != null && (
                <span>{zh ? `输入 ${chat.inputTokens} · 输出 ${chat.outputTokens} token` : `${chat.inputTokens} in · ${chat.outputTokens} out tokens`}</span>
              )}
              {chat.reasoning && (
                <button type="button" className="provider-probe__toggle" onClick={() => setShowReasoning((v) => !v)}>
                  {showReasoning ? (zh ? '收起思考' : 'Hide thinking') : (zh ? '看思考过程' : 'Show thinking')}
                </button>
              )}
            </div>
            {showReasoning && chat.reasoning && <div className="provider-probe__reasoning">{chat.reasoning}</div>}
          </>
        )}
        <div className="provider-test__compose">
          <input
            className="provider-test__input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void send(prompt, model); } }}
            placeholder={zh ? '再问一句…' : 'Ask something else…'}
          />
          <button
            type="button"
            className="provider-test__send"
            onClick={() => void send(prompt, model)}
            disabled={chat.status === 'sending'}
            aria-label={zh ? '发送' : 'Send'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
};
