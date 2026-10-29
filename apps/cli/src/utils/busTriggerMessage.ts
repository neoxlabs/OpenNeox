/**
 * 不是这个终端敲的那一轮 —— 会话收件箱代用户起的 (别的会话发来的消息 / 后台任务结束 / 定时到点 / 监控命中)。
 * 起因就是 user_message 里那段 XML; 不画出来, 时间线上就只剩 agent 突然开口。
 * 自己敲的话本地已经画过, 这里只认总线 XML, 不重画。UserMessage.tsx 把 XML 画成一行步骤。
 */
const BUS_TRIGGER_XML = /^\s*<(session-message|background-task-notification|agent-completion|scheduled-wakeup|scheduled-task-fired|monitor-event)>/;

export function busTriggerText(event: unknown): string | null {
  const text = String((event as { text?: unknown } | null)?.text ?? '');
  return BUS_TRIGGER_XML.test(text) ? text : null;
}
