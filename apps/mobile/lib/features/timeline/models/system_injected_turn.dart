/// system_injected_turn.dart — 识别并解析"系统注入的 user turn".
///
/// ## 背景
///
/// 桌面 runtime 会把一些**系统事件**当作下一轮 user message 注入回对话, 用 XML 包裹:
///   · `<agent-completion>`            子 agent 跑完, 结果回灌给主 agent
///   · `<background-task-notification>` 后台任务完成
///   · `<scheduled-wakeup>`             定时唤醒
///
/// 这是给**模型**看的协议载荷, 不是用户说的话。桌面 UI 有三道处理:
///   `aggregateTurnChanges.ts` 判定 → `systemMessageParsers.ts` 解析 → 渲染成
///   BackgroundTaskCell, **不走 user 气泡**。
///
/// 手机端此前**一道都没有**, 于是这些 XML 被当普通 user 消息原样渲染 —— 真机上
/// 能看到整段子 agent 报告正文, 末尾还露出
///   `… (truncated, use SendMessage/query to fetch full result)</summary></agent-completion>`
/// 这种内部标签。桌面同一会话里没有这一段, 两端观感完全不同。
///
/// 这个文件只负责**识别 + 解析**, 渲染交给上层。
library;

/// 系统注入 turn 的类型.
enum SystemTurnKind { agentCompletion, backgroundTask, scheduledWakeup }

/// 解析结果 —— 结构化字段 + 去掉 XML 后的残余正文.
class SystemInjectedTurn {
  const SystemInjectedTurn({
    required this.kind,
    this.agentId,
    this.name,
    this.status,
    this.elapsedSeconds,
    this.toolUseCount,
    this.summary,
    this.residual = '',
  });

  final SystemTurnKind kind;
  final String? agentId;
  final String? name;

  /// 'completed' | 'failed' | … (缺省按 completed 处理, 与桌面一致)
  final String? status;
  final int? elapsedSeconds;
  final int? toolUseCount;

  /// 子 agent 的结果摘要 —— 折叠展示, 不直接铺在主 timeline 上.
  final String? summary;

  /// XML 之外用户真正写的内容 (通常为空).
  final String residual;

  bool get isFailed => (status ?? 'completed') == 'failed';
}

/// 这段 user 文本是不是系统注入的 —— 与桌面 `aggregateTurnChanges.ts` 同一判定.
bool isSystemInjectedTurn(String text) =>
    _kSystemTurnHead.hasMatch(text.trimLeft());

final RegExp _kSystemTurnHead = RegExp(
  r'^<(background-task-notification|agent-completion|scheduled-wakeup)\b',
  caseSensitive: false,
);

/// 解析系统注入 turn; 不是系统注入则返回 null.
SystemInjectedTurn? parseSystemInjectedTurn(String text) {
  final src = text.trim();
  if (!isSystemInjectedTurn(src)) return null;

  final body = _between(src, 'agent-completion');
  if (body != null) {
    return SystemInjectedTurn(
      kind: SystemTurnKind.agentCompletion,
      agentId: _tag(body, 'agent-id'),
      name: _tag(body, 'name'),
      status: _tag(body, 'status') ?? 'completed',
      elapsedSeconds: _int(_tag(body, 'elapsed-seconds')),
      toolUseCount: _int(_tag(body, 'tool-use-count')),
      summary: _tag(body, 'summary'),
      residual: _stripBlock(src, 'agent-completion'),
    );
  }

  final wake = _between(src, 'scheduled-wakeup');
  if (wake != null) {
    return SystemInjectedTurn(
      kind: SystemTurnKind.scheduledWakeup,
      name: _tag(wake, 'reason'),
      elapsedSeconds: _int(_tag(wake, 'elapsed-seconds')),
      residual: _stripBlock(src, 'scheduled-wakeup'),
    );
  }

  final bg = _between(src, 'background-task-notification');
  if (bg != null) {
    return SystemInjectedTurn(
      kind: SystemTurnKind.backgroundTask,
      name: _tag(bg, 'name') ?? _tag(bg, 'task'),
      status: _tag(bg, 'status') ?? 'completed',
      summary: _tag(bg, 'summary') ?? _tag(bg, 'result'),
      residual: _stripBlock(src, 'background-task-notification'),
    );
  }
  return null;
}

/* 按 tag 缓存的正则 —— 2026-09-22.
 *
 * 这几个正则**必须**按 tag 动态构造 (tag 是参数), 但它们由
 * [parseSystemInjectedTurn] 在**每条 user 消息的 build 里**调用 (见 message_row),
 * 而 Dart 不会缓存动态 RegExp: 每次都是重新编译 + 对整个消息做一遍全串扫描。
 * 用户粘一段长文本进对话, 每次列表重建都会重扫一遍 —— 长消息越明显。
 * tag 只有几个固定值 (user_message / background-task-notification / current-time …),
 * 按 tag 缓存住就够了。 */
final _reCache = <String, RegExp>{};

RegExp _betweenRe(String tag) => _reCache.putIfAbsent(
  'between:$tag',
  () => RegExp('<$tag>([\\s\\S]*?)</$tag>', caseSensitive: false),
);

RegExp _stripRe(String tag) => _reCache.putIfAbsent(
  'strip:$tag',
  () => RegExp('<$tag>[\\s\\S]*?</$tag>', caseSensitive: false),
);

String? _between(String src, String tag) => _betweenRe(tag).firstMatch(src)?.group(1);

String _stripBlock(String src, String tag) =>
    src.replaceAll(_stripRe(tag), '').trim();

String? _tag(String body, String tag) {
  final v = _betweenRe(tag).firstMatch(body)?.group(1)?.trim();
  return (v == null || v.isEmpty) ? null : _unescapeXml(v);
}

int? _int(String? s) => s == null ? null : int.tryParse(s.trim());

String _unescapeXml(String s) => s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
