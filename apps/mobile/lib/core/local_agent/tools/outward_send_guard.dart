/// outward_send_guard.dart — 以用户名义发出去的消息, 同收件人 + 同文本 2 分钟内只发一次 (S-07).
///
/// 手抖 / 模型重试会把同一句发两遍, 收件人那边看到重复。判定放在「真的发出去」这一步,
/// 不依赖模型自觉: 本机 agent 和电脑借手机办事 (phone.exec) 共用同一份记账。
/// 发送失败不记账, 还能重试。
library;

/// 判重窗口
const Duration outwardSendWindow = Duration(minutes: 2);

class OutwardSendGuard {
  OutwardSendGuard({this.window = outwardSendWindow, DateTime Function()? clock})
      : _clock = clock ?? DateTime.now;

  final Duration window;
  final DateTime Function() _clock;
  final Map<String, DateTime> _lastSent = {};

  /// 2 分钟内发过同样的内容 (同收件人 + 同文本) → true: 拦下, 不再发
  bool isDuplicate({required String recipient, required String text}) {
    final at = _lastSent[_key(recipient, text)];
    if (at == null) return false;
    /* 时钟回拨 (at 落在未来) 也算刚发过 —— 宁可拦下, 不要重复 */
    return _clock().difference(at) < window;
  }

  /// 真发出去了才记 (失败不记, 允许重试)
  void remember({required String recipient, required String text}) {
    _prune();
    _lastSent[_key(recipient, text)] = _clock();
  }

  void clear() => _lastSent.clear();

  void _prune() {
    final now = _clock();
    _lastSent.removeWhere((_, at) => now.difference(at) >= window);
  }
}

/// 号码里的空格 / 横线 / 括号不影响判重; 邮箱不分大小写; 文本去掉首尾空白和 CRLF 差异
String _key(String recipient, String text) {
  final who = recipient.toLowerCase().replaceAll(RegExp(r'[\s\-()]'), '');
  final what = text.replaceAll('\r\n', '\n').trim();
  return '$who\u0000$what';
}

/// 进程内共用一份 —— 本机 agent 与电脑借手机办事发出去都算数
final OutwardSendGuard outwardSendGuard = OutwardSendGuard();
