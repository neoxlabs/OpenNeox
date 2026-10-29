
import React from 'react';
import type { TimelineMessage } from '../types';
import { detectSystemMessages } from './systemMessageParsers';
import { BackgroundShellCell, AgentCompletionCell } from './BackgroundTaskCell';
import { SystemNoticeCell } from './SystemNoticeCell';
import { UserCell } from './UserCell';
import { AssistantTextCell } from './AssistantTextCell';

export interface MessageRouterContext {
  /** 整条会话被用户暂停 — assistant 占位 placeholder 改成 "已暂停" */
  paused?: boolean;
  /** 本轮结论 (该轮最后一条 assistant) 显 footer — 多轮时每轮结论都有 */
  isLastAssistant?: boolean;
  /** 本轮 agent 还在跑 (还会有工具/后续消息) — footer 要等本轮真结束再出 */
  turnRunning?: boolean;
  /** 重新生成只对整会话最后一轮有意义 */
  allowRegenerate?: boolean;
}

export const MessageCell: React.FC<{ message: TimelineMessage } & MessageRouterContext> = React.memo(({
  message,
  paused = false,
  isLastAssistant = false,
  turnRunning = false,
  allowRegenerate = false,
}) => {
  const isUser = message.role === 'user';

  // user_message 路径里的 XML 注入 — 一条消息可能拼了好几件事 (同一空闲窗口里到的), 每件一行
  const systemHits = isUser ? collapseRepeats(detectSystemMessages(message.text)) : [];
  if (systemHits.length) {
    return <>{systemHits.map(({ hit, repeat }, i) => <React.Fragment key={i}>{renderSystemHit(hit, message.timestamp, repeat)}</React.Fragment>)}</>;
  }

  if (isUser) {
    return <UserCell message={message} />;
  }
  return (
    <AssistantTextCell
      message={message}
      paused={paused}
      isLast={isLastAssistant}
      turnRunning={turnRunning}
      allowRegenerate={allowRegenerate}
    />
  );
}, (prev, next) => (
  prev.message === next.message
  && !!prev.paused === !!next.paused
  && !!prev.isLastAssistant === !!next.isLastAssistant
  && !!prev.turnRunning === !!next.turnRunning
  && !!prev.allowRegenerate === !!next.allowRegenerate
));

type SystemHit = ReturnType<typeof detectSystemMessages>[number];

/** 忙的时候同一个定时任务会攒下好几次触发, 拼进同一条消息 —— 一模一样的几张卡叠着是噪音, 并成一张记次数 */
function collapseRepeats(hits: SystemHit[]): Array<{ hit: SystemHit; repeat: number }> {
  const out: Array<{ hit: SystemHit; repeat: number; key: string }> = [];
  for (const hit of hits) {
    const key = JSON.stringify(hit);
    const last = out[out.length - 1];
    if (last && last.key === key) last.repeat += 1;
    else out.push({ hit, repeat: 1, key });
  }
  return out;
}

function renderSystemHit(systemHit: SystemHit, timestamp: string | undefined, repeat = 1): React.ReactNode {
  if (systemHit.kind === 'background_shell') {
    return <BackgroundShellCell notification={systemHit.data} timestamp={timestamp} />;
  }
  if (systemHit.kind === 'agent_completion') {
    return null;
  }
  if (systemHit.kind === 'scheduled_wakeup') {
    return <SystemNoticeCell subtype="wakeup" wakeup={systemHit.data} timestamp={timestamp} repeat={repeat} />;
  }
  if (systemHit.kind === 'monitor_event') {
    return <SystemNoticeCell subtype="monitor" monitor={systemHit.data} timestamp={timestamp} repeat={repeat} />;
  }
  if (systemHit.kind === 'scheduled_task') {
    return <SystemNoticeCell subtype="scheduled_task" task={systemHit.data} timestamp={timestamp} repeat={repeat} />;
  }
  if (systemHit.kind === 'reminder') {
    return <SystemNoticeCell subtype="reminder" reminder={systemHit.data} timestamp={timestamp} repeat={repeat} />;
  }
  if (systemHit.kind === 'session_message') {
    return <SystemNoticeCell subtype="session_message" message={systemHit.data} timestamp={timestamp} repeat={repeat} />;
  }
  return null;
}
