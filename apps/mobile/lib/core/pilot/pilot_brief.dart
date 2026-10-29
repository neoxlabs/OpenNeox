/// 早报 (pilot:P-01): 每天 08:00, 最多三件; 8:00 ±5 分钟算准点。
///
/// 服务端挑内容 (composeBrief), 手机上只决定「自动化」页显示的钟点与开关。
/// 桌面那侧同一份常量在 packages/pilot-data-sdk/src/brief.ts。
library;

class PilotBrief {
  PilotBrief._();

  static const defaultTime = '08:00';
  static const onTimeMinutes = 5;
  static const maxItems = 3;

  static final _hhmm = RegExp(r'^(\d{1,2}):(\d{2})$');

  /// 档案 pilot.brief = 'off' 才算关 (没写过 = 开)
  static bool enabled(Map<String, dynamic> facts) => facts['pilot.brief'] != 'off';

  /// 档案 pilot.brief_time 可改钟点; 写坏了退回 08:00
  static String timeOf(Map<String, dynamic> facts) {
    final t = facts['pilot.brief_time'];
    if (t is! String) return defaultTime;
    final m = _hhmm.firstMatch(t.trim());
    if (m == null) return defaultTime;
    final h = int.parse(m.group(1)!);
    final min = int.parse(m.group(2)!);
    if (h > 23 || min > 59) return defaultTime;
    return '${h.toString().padLeft(2, '0')}:${m.group(2)}';
  }

  /// 到达时间算不算准点 (8:00 ±5 分钟)
  static bool onTime(Map<String, dynamic> facts, String sentTime) {
    int? minutesOf(String s) {
      final m = _hhmm.firstMatch(s.trim());
      if (m == null) return null;
      final h = int.parse(m.group(1)!);
      final min = int.parse(m.group(2)!);
      return h > 23 || min > 59 ? null : h * 60 + min;
    }

    final at = minutesOf(timeOf(facts));
    final cur = minutesOf(sentTime);
    if (at == null || cur == null) return false;
    final late = cur - at;
    return late >= -onTimeMinutes && late <= onTimeMinutes;
  }
}
