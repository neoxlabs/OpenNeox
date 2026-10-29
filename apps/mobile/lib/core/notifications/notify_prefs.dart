/// notify_prefs.dart — 设置 → 通知 里的开关 (陶土稿 v5).
///
///   任务做完 / 等你确认 / Pilot 找你 / 更新  —— 各管一类通知
///   安静时段 22:30–07:30                     —— 这段时间只响来电
///   允许 Pilot 打电话给你                    —— 关掉 = 它打来直接按没接
///
/// 安静时段跟桌面 / Pilot 来电 / 触发引擎同一口径 (pilot:P-03)。桌面那侧常量在
/// packages/pilot-data-sdk/src/quietHours.ts, Flutter 这边是镜像, 两边各有测试钉住这两个钟点。
///
/// 发通知的地方 (agent_notifier / local_notifications / pilot_call_controller / app_update)
/// 同步问一句 [NotifyPrefs.allows], 所以这里拿启动时就读好的 SharedPreferences, 不走 provider。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

enum NotifyKind { done, waiting, pilot, update }

class NotifyPrefs {
  NotifyPrefs._();

  static SharedPreferences? _prefs;

  /// bootstrap 里 SharedPreferences 读好以后挂上
  static void attach(SharedPreferences p) => _prefs = p;

  static const quietStart = '22:30';
  static const quietEnd = '07:30';
  static const _quietStartMinutes = 22 * 60 + 30;
  static const _quietEndMinutes = 7 * 60 + 30;

  static String _key(NotifyKind k) => 'notify_${k.name}';

  static bool enabled(NotifyKind k) => _prefs?.getBool(_key(k)) ?? true;
  /// 夜里不打扰是默认行为 (pilot:P-03) —— 用户不用先去设置里找开关
  static bool get quiet => _prefs?.getBool('notify_quiet') ?? true;
  static bool get allowCall => _prefs?.getBool('notify_allow_call') ?? true;

  /// 此刻在不在安静时段 (22:30 起, 07:30 止; 跨零点). 公开给设置页与测试。
  static bool inQuietHoursAt([DateTime? now]) {
    final t = now ?? DateTime.now();
    final minutes = t.hour * 60 + t.minute;
    return minutes >= _quietStartMinutes || minutes < _quietEndMinutes;
  }

  /// 这一类现在该不该弹: 开关开着, 且不在安静时段 (安静时段只响来电)
  static bool allows(NotifyKind k) => enabled(k) && !(quiet && inQuietHoursAt());

  static Future<void> set(NotifyKind k, bool v) async => _prefs?.setBool(_key(k), v);
  static Future<void> setQuiet(bool v) async => _prefs?.setBool('notify_quiet', v);
  static Future<void> setAllowCall(bool v) async => _prefs?.setBool('notify_allow_call', v);
}

/// 设置页用: 改了开关要重画, 用一个版本号 provider 让页面跟着刷新
final notifyPrefsVersionProvider = StateProvider<int>((ref) => 0);
