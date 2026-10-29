/** 宠物要替用户留意的事: 等批准 / 等回答 / 出错 / 长任务跑完。 */
import { useEffect, useRef, useState } from 'react';

export type MascotSignalKind = 'approval' | 'ask' | 'error' | 'done';

export interface MascotSignal {
  kind: MascotSignalKind;
  text: string;
  /** 同一件事的 key 不变; 换了 key 才重新提醒一次。 */
  key: string;
}

/** 跑满这么久才在结束时报一声; 短回合用户一直盯着, 不用报。 */
export const DONE_NOTICE_AFTER_MS = 20_000;
/** 完成提示停留多久。 */
export const DONE_NOTICE_MS = 8_000;

export function formatRunDuration(ms: number, zh: boolean): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return zh ? `${s} 秒` : `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (zh) return r ? `${m} 分 ${r} 秒` : `${m} 分钟`;
  return r ? `${m}m ${r}s` : `${m}m`;
}

/** 按错误类型说人话; 认不出来的一律「出错了」。 */
export function errorSignalText(error: { code?: string; message?: string } | null | undefined, zh: boolean): string {
  const s = `${error?.code ?? ''} ${error?.message ?? ''}`;
  if (/\b402\b|quota|insufficient|balance|billing|credit|额度|余额|欠费/i.test(s)) {
    return zh ? '额度不够了' : 'Out of credit';
  }
  if (/\b429\b|rate.?limit|too many requests|频繁|限流/i.test(s)) {
    return zh ? '请求太频繁, 等一下再试' : 'Rate limited, try again shortly';
  }
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|invalid.{0,12}(api.?)?key|api.?key|鉴权|密钥|认证/i.test(s)) {
    return zh ? 'Key 不对或过期了' : 'API key rejected';
  }
  if (/context.{0,20}(length|window|limit)|too long|maximum.{0,20}tokens|上下文|太长/i.test(s)) {
    return zh ? '对话太长了' : 'Conversation too long';
  }
  if (/ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket|network|fetch failed|timed? ?out|超时|网络|断开/i.test(s)) {
    return zh ? '网络好像断了' : 'Network problem';
  }
  if (/\b5\d\d\b|overload|unavailable|服务繁忙|过载/i.test(s)) {
    return zh ? '模型那边出问题了' : 'The model service failed';
  }
  return zh ? '出错了, 看下面' : 'Something went wrong';
}

type EntryLike = { id?: string; pending?: boolean; title?: string; type?: string; success?: boolean; toolName?: string };

/**
 * 宠物的姿态: 等用户 > 出错 > (在跑时) 想 / 调工具 / 写回复 > 闲着。
 * 在跑时看最后一条还挂着的条目: 思考中 → thinking, 工具在跑 → working, 其它 → writing。
 */
export function deriveMascotMood(input: {
  streaming: boolean;
  waiting: boolean;
  error: boolean;
  events: ReadonlyArray<EntryLike>;
}): 'idle' | 'thinking' | 'working' | 'writing' | 'waiting' | 'error' {
  if (input.waiting) return 'waiting';
  if (input.error && !input.streaming) return 'error';
  if (!input.streaming) return 'idle';
  for (let i = input.events.length - 1; i >= 0; i--) {
    const e = input.events[i];
    if (!e?.pending) continue;
    if (e.type === 'thinking') return 'thinking';
    if (e.type === 'assistant_message' || e.type === 'assistant_prefix') return 'writing';
    return 'working';
  }
  const last = input.events[input.events.length - 1];
  return last?.type === 'thinking' ? 'thinking' : 'writing';
}

/** 最后一个失败的工具的 id (tool_error 或 success=false 的结果), 没有就 null。 */
export function lastToolFailureId(events: ReadonlyArray<EntryLike>): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === 'user_message') return null;
    if (e?.type === 'tool_error' || ((e?.type === 'tool_result' || e?.type === 'tool_call') && e.success === false)) {
      return e.id ?? `${i}`;
    }
  }
  return null;
}

export interface MascotSignalInput {
  streaming: boolean;
  approvalId?: string | null;
  askId?: string | null;
  errorKey?: string | null;
  /** 出错时气泡里的话 (errorSignalText), 不给就用通用那句。 */
  errorText?: string;
  done?: { at: number; ranMs: number } | null;
  zh: boolean;
}

/** 按优先级挑一件: 等用户动手的 > 出错 > 跑完。 */
export function pickMascotSignal(input: MascotSignalInput): MascotSignal | null {
  const { zh } = input;
  if (input.approvalId) {
    return { kind: 'approval', key: `approval:${input.approvalId}`, text: zh ? '等你批准' : 'Needs your approval' };
  }
  if (input.askId) {
    return { kind: 'ask', key: `ask:${input.askId}`, text: zh ? '有个问题等你回答' : 'Has a question for you' };
  }
  if (input.errorKey && !input.streaming) {
    return {
      kind: 'error',
      key: `error:${input.errorKey}`,
      text: input.errorText ?? (zh ? '出错了, 看下面' : 'Something went wrong'),
    };
  }
  if (input.done && !input.streaming) {
    return {
      kind: 'done',
      key: `done:${input.done.at}`,
      text: zh ? `好了 · ${formatRunDuration(input.done.ranMs, true)}` : `Done · ${formatRunDuration(input.done.ranMs, false)}`,
    };
  }
  return null;
}

/**
 * 记下「刚跑完一个长回合」, DONE_NOTICE_MS 后自己消失; 再次开跑立刻清掉。
 * turnStartedAt 缺失时从 streaming 翻起来的那一刻算。
 */
export function useRunDoneNotice(streaming: boolean, turnStartedAt?: number | null, sessionKey?: string | null) {
  const [done, setDone] = useState<{ at: number; ranMs: number } | null>(null);
  const startedRef = useRef<number | null>(streaming ? (turnStartedAt ?? Date.now()) : null);
  /* 切会话时 streaming 也会从 true 翻成 false (新会话没在跑), 那不是「跑完」 */
  const sessionRef = useRef(sessionKey);
  if (sessionRef.current !== sessionKey) {
    sessionRef.current = sessionKey;
    startedRef.current = streaming ? (turnStartedAt ?? Date.now()) : null;
  }
  useEffect(() => { setDone(null); }, [sessionKey]);
  /* 只跟着 streaming 翻转跑: turnStartedAt 在结束后被清空时重跑, 会把计时器清掉让提示永远不走 */
  const turnStartedRef = useRef(turnStartedAt);
  turnStartedRef.current = turnStartedAt;
  useEffect(() => {
    if (streaming) {
      startedRef.current = turnStartedRef.current ?? startedRef.current ?? Date.now();
      setDone(null);
      return;
    }
    const started = startedRef.current;
    startedRef.current = null;
    if (started == null) return;
    const ranMs = Date.now() - started;
    if (ranMs < DONE_NOTICE_AFTER_MS) return;
    const at = Date.now();
    setDone({ at, ranMs });
    const t = window.setTimeout(() => setDone((d) => (d?.at === at ? null : d)), DONE_NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [streaming]);
  return [done, () => setDone(null)] as const;
}

/** 当前正在做的那一步 (最后一条还挂着的工具), 给「点一下看进度」用。 */
export function currentActivity(events: ReadonlyArray<{ pending?: boolean; title?: string; type?: string }>): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.pending && e.title && e.type !== 'thinking') return e.title;
  }
  return null;
}
