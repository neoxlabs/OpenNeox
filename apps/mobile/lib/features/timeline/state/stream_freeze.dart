/// stream_freeze.dart — 点停止后立即冻结打字机 (chat:C9-08).
///
/// 手机端有两层会让画面"还在自己长字":
///
///   1. **状态层**: 用户点停止后, 桌面/网关的 cancel 要一个 RTT 才生效, 这期间
///      残留的 `agent_text_delta` / `agent_thinking_delta` 仍会进时间线, 正文继续
///      变长 (见 `TimelineStateController.markCancelRequested` 原来的注释)。
///   2. **呈现层**: 正文由 `StreamingTypewriter` 逐帧吐出, 即使文本不再变长,
///      已经缓冲在 `text` 里的字还会继续打出来一小截。
///
/// 这里只放"哪些流式事件算正文打字机"这一条判定, 两层共用: 状态层据此丢增量,
/// 呈现层据此停帧。判定是纯函数, 好测。
library;

/// 会驱动正文打字机的流式事件 —— 用户停止后这些增量不再上屏。
///
/// 只含**正文/思考**: 工具进度 (`tool_progress`) 不是打字机; 它有自己的
/// 收口语义, 不在本条目里改。
const Set<String> kTypewriterStreamKinds = {
  'agent_text_delta',
  'agent_thinking_delta',
};

/// 这条流式事件是否属于正文打字机 (停止后应当被丢弃)。
bool isTypewriterStreamKind(String kind) =>
    kTypewriterStreamKinds.contains(kind);
