/// chat_metric.dart — 一轮 Chat 的首字耗时快照 (chat:C8-11).
///
/// 纯数据, 不依赖 drift —— [ChatTurnTiming] 每轮算完就产出这一份, 由
/// `chat_metrics.dart` 的 [ChatMetricsStore] 落库。单独放一个文件是为了让
/// 打点计算 (chat_send_prep.dart) 的测试不用拉起数据库。
library;

/// 一轮的三段耗时, 口径跟桌面 `token_usage.first_token_ms` 对齐到「用户感知延迟」:
///   [sendToRequestMs]  点发送 → 请求真正发出 (发送前的准备)
///   [requestToFirstMs] 请求发出 → 首个可见正文 (模型 / 网络)
///   [firstTokenMs]     点发送 → 首个可见正文 (两者之和; -1 = 这一轮没等到字)
/// 思考过程不算「首字」—— 用户看的还是正文。
class ChatTurnMetric {
  const ChatTurnMetric({
    required this.sessionId,
    required this.modelId,
    required this.lightChat,
    required this.sendToRequestMs,
    required this.requestToFirstMs,
    required this.firstTokenMs,
    required this.gotFirstToken,
    required this.at,
  });

  final String sessionId;
  final String modelId;

  /// 这一轮走的是不是轻聊天档 (只有搜索 + 画图) —— 分组看延迟时要区分。
  final bool lightChat;

  final int sendToRequestMs;
  final int requestToFirstMs;
  final int firstTokenMs;

  /// false = 报错 / 空回复 / 被取消, 没等到第一个字。
  final bool gotFirstToken;

  /// 用户点发送的时刻。
  final DateTime at;
}
