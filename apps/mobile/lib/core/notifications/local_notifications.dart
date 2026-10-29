/// local_notifications.dart — flutter_local_notifications 薄封装.
///
/// 消费者:
///   1. 桌面 reminder fired → 'life.reminder_fired' → showReminder
///   2. agent 事件 (审批/追问/跑完/中断) → agent_notifier → showAgentEvent
///
/// app 在前台/后台且 WS 连接中才收得到; app 被杀需要 APNS/FCM
/// (能力保留见 agent_notifier.RemotePushRegistrar).
///
/// **定时提醒是例外** (scheduleReminder): 它交给系统闹钟 (Android AlarmManager /
/// iOS UNCalendarNotificationTrigger), app 被杀掉照样按时响, 不依赖任何推送通道
/// 也不依赖桌面在线。"提前 3 天提醒"这类承诺靠的就是这条。
///
/// 通知点击: payload 带 sessionId, [onSessionTap] 由 app 层注入 —
/// 点通知回 app 直接落到对应会话.
library;

import 'dart:convert';

import 'package:flutter/foundation.dart' show debugPrint;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_timezone/flutter_timezone.dart';
import 'package:timezone/data/latest_all.dart' as tzdata;
import 'package:timezone/timezone.dart' as tz;
import 'package:neox_app/core/i18n/tr.dart';

import 'inbox.dart';
import 'notify_prefs.dart';

class LocalNotifications {
  LocalNotifications._();

  static final FlutterLocalNotificationsPlugin _plugin =
      FlutterLocalNotificationsPlugin();
  static bool _ready = false;

  /// 点通知 → 打开对应会话. app.dart 启动时注入 (set currentSession).
  static void Function(String sessionId)? onSessionTap;

  /// 点 `pilot:*` 通知 (每晚问一句) → app.dart 注入, 打开 Pilot
  static void Function(String payload)? onPayloadTap;

  /// 幂等初始化 —— **不要权限**, 只装插件和点击回调.
  ///
  /// 2026-08-08 拆分: 原来 init() 一次做两件事 (装插件 + 要权限), 而 main() 在
  /// runApp 之后立刻调它 —— 于是 iOS 冷启动第一帧就弹通知权限框, Android 13
  /// 同理。用户还没看懂这是个什么 app 就被要权限, 通过率极低, 而且**拒绝之后
  /// 不可逆**, 之后只能去系统设置里手工开。
  ///
  /// 而通知恰恰是这个产品的核心价值 (在手机上盯着电脑跑的长任务), 这一下等于
  /// 把最重要的能力在用户理解它之前就赌掉了。
  ///
  /// 现在: 装插件放启动 (无副作用), 要权限走 [ensurePermission], 由调用方在
  /// 用户真正表达了使用意图之后再触发。
  static Future<void> init() async {
    if (_ready) return;
    const android = AndroidInitializationSettings('@mipmap/ic_launcher');
    /* 三个 request* 全部 false —— initialize() 不再触发系统权限框 */
    const darwin = DarwinInitializationSettings(
      requestAlertPermission: false,
      requestBadgePermission: false,
      requestSoundPermission: false,
    );
    try {
      await _plugin.initialize(
        const InitializationSettings(android: android, iOS: darwin, macOS: darwin),
        onDidReceiveNotificationResponse: (resp) {
          final payload = resp.payload;
          if (payload != null &&
              payload.startsWith('session:') &&
              onSessionTap != null) {
            onSessionTap!(payload.substring(8));
          } else if (payload != null && (payload.startsWith('pilot:') || payload.startsWith('route:'))) {
            onPayloadTap?.call(payload);
          }
        },
      );
      _ready = true;
    } catch (e) {
      debugPrint('[notifications] init failed: $e');
    }
  }

  /// 申请通知权限 —— 由调用方在**合适的时机**调, 不在启动时.
  ///
  /// 合适的时机 = 用户刚派出第一个任务的那一刻: 他此时正等着结果, "任务跑完
  /// 通知你"是一句他真的想听的话, 而不是一个开屏就跳出来的莫名其妙的框。
  ///
  /// 进程内只尝试一次 —— 系统层面拒绝过就不会再弹, 反复调只是浪费。
  static bool _permissionAsked = false;

  static Future<void> ensurePermission() async {
    if (_permissionAsked) return;
    _permissionAsked = true;
    await init();
    try {
      /* Android 13+ POST_NOTIFICATIONS 运行时权限 (Manifest 已声明) */
      await _plugin
          .resolvePlatformSpecificImplementation<
              AndroidFlutterLocalNotificationsPlugin>()
          ?.requestNotificationsPermission();
      /* iOS / macOS */
      await _plugin
          .resolvePlatformSpecificImplementation<
              IOSFlutterLocalNotificationsPlugin>()
          ?.requestPermissions(alert: true, badge: true, sound: true);
    } catch (e) {
      debugPrint('[notifications] permission request failed: $e');
    }
  }

  /// agent 事件通知 (审批/追问/完成/中断) — 独立 channel, 点击带 sessionId payload.
  static Future<void> showAgentEvent({
    required String title,
    String? body,
    required String sessionId,
    String inboxKind = 'agent',
  }) async {
    try {
      await init();
      final details = NotificationDetails(
        android: AndroidNotificationDetails(
          'agent_events',
          tr('Agent 任务'),
          channelDescription: tr('审批请求、任务完成等 Agent 状态'),
          importance: Importance.high,
          priority: Priority.high,
        ),
        iOS: DarwinNotificationDetails(
          presentAlert: true,
          presentBanner: true,
          presentSound: true,
        ),
      );
      final id = DateTime.now().millisecondsSinceEpoch ~/ 1000 % 0x7fffffff;
      await _plugin.show(
        id,
        title,
        body,
        details,
        payload: 'session:$sessionId',
      );
      /* 消息页留一份: 通知栏划掉也找得回来 */
      await InboxStore.instance.add(kind: inboxKind, title: title, body: body, sessionId: sessionId);
    } catch (e) {
      debugPrint('[notifications] showAgentEvent failed: $e');
    }
  }

  /// 有新版: 每个版本只说一次, 点开是更新页 (设置 → 通知 →「更新」关了就不说)
  static Future<void> showUpdate(String version) async {
    if (!NotifyPrefs.allows(NotifyKind.update)) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      if (prefs.getString('notify_update_said') == version) return;
      await init();
      final details = NotificationDetails(
        android: AndroidNotificationDetails(
          'app_updates',
          tr('更新'),
          channelDescription: tr('Neox 有新版时说一声'),
          importance: Importance.defaultImportance,
          priority: Priority.defaultPriority,
        ),
        iOS: const DarwinNotificationDetails(presentAlert: true, presentBanner: true),
      );
      await _plugin.show(0x5550_4454, tr('Neox $version 可以更新了'), tr('点开看看这一版有什么'), details, payload: 'route:/update');
      await prefs.setString('notify_update_said', version);
    } catch (e) {
      debugPrint('[notifications] showUpdate failed: $e');
    }
  }

  /// 弹一条提醒通知 (即时, 非 scheduled — 触发时机由桌面 JobRunner 决定).
  /// [alarm]: 按闹钟响 (同 scheduleReminder) —— 电脑不在时手机上的 Pilot 判断「急」的事
  static Future<void> showReminder({required String title, String? body, bool alarm = false}) async {
    try {
      await init();
      final details = NotificationDetails(
        android: alarm
            ? AndroidNotificationDetails(
                'pilot_alarms',
                tr('Pilot 叫你'),
                channelDescription: tr('Pilot 到点叫你 (电脑不在时由手机响)'),
                importance: Importance.max,
                priority: Priority.max,
                category: AndroidNotificationCategory.alarm,
                audioAttributesUsage: AudioAttributesUsage.alarm,
              )
            : AndroidNotificationDetails(
                'life_reminders',
                tr('提醒'), /* 频道 id 不改: 改了用户在系统里给它的设置就丢了 */
                channelDescription: tr('桌面 Neox 定时提醒同步到手机'),
                importance: Importance.high,
                priority: Priority.high,
              ),
        iOS: DarwinNotificationDetails(
          presentAlert: true,
          presentBanner: true,
          presentSound: true,
        ),
      );
      final id = DateTime.now().millisecondsSinceEpoch ~/ 1000 % 0x7fffffff;
      /* 设置 → 通知 →「Pilot 找你」关了 / 安静时段: 不弹 (闹钟级的照样响 —— 那是它判断「急」的事);
       * 消息页照样留一份 */
      if (alarm || NotifyPrefs.allows(NotifyKind.pilot)) await _plugin.show(id, title, body, details);
      await InboxStore.instance.add(kind: 'reminder', title: title, body: body);
    } catch (e) {
      debugPrint('[notifications] showReminder failed: $e');
    }
  }

  static bool _tzReady = false;

  /// tz.local 是否已经指向设备真实时区 (setLocalLocation 成功).
  /// false 时 TZDateTime(tz.local, y,m,d,...) 那种"按墙上时间构造"是错的。
  static bool _tzLocalIsDeviceZone = false;

  /// 时区库幂等初始化 —— zonedSchedule 需要 TZDateTime.
  ///
  /// **必须显式 setLocalLocation**: timezone 包的 `tz.local` 默认是 UTC, 不是
  /// 设备时区。2026-08-11 模拟器实测 (设备 America/Los_Angeles, UTC-7):
  /// 「3 分钟后提醒我喝水」被算成 7 小时之前 → 过期判断拦掉 → 提醒排不上。
  /// 而且当时的报错还写成"通知权限没开", 把用户支去开一个不相干的权限。
  static Future<void> _ensureTz() async {
    if (_tzReady) return;
    tzdata.initializeTimeZones();
    try {
      final name = await FlutterTimezone.getLocalTimezone();
      tz.setLocalLocation(tz.getLocation(name));
      _tzLocalIsDeviceZone = true;
    } catch (e) {
      /* 查不到就退回按**绝对时刻**排 (见 scheduleReminder 里的 fallback):
       * 精度一样, 只是跨 DST 切换时会差一小时。总比整个功能哑掉强。 */
      debugPrint('[notifications] 设备时区取不到, 退回绝对时刻排程: $e');
    }
    _tzReady = true;
  }

  /// 排一条**定时**提醒. 返回系统通知 id (取消用).
  ///
  /// 失败**抛异常并带上真实原因**, 不再吞成 null —— 之前吞掉的后果是调用方只能
  /// 猜一个原因说给用户听, 实测猜成了"通知权限没开", 而真因是时区没设,
  /// 结果模型带着用户去开一个完全不相干的"通知使用权"。
  ///
  /// 用 inexactAllowWhileIdle 而不是精确闹钟: 精确闹钟在 Android 12+ 要
  /// SCHEDULE_EXACT_ALARM 特殊权限, 会给用户弹一个吓人的系统页面; 而生活提醒
  /// 差几分钟无所谓。allowWhileIdle 保证在 Doze 模式下也会被唤醒 —— 否则手机
  /// 放桌上一晚上, 早上的提醒可能被系统攒到你解锁才弹, 那就没用了。
  ///
  /// [alarm]: 按闹钟响 (单独的频道, 闹钟音量 + 闹钟类别)。Pilot 的提醒在电脑上是打电话叫你,
  /// 电脑不在时手机替它叫, 必须一样响 —— 普通通知会被 Android 15+ 的通知冷却 (同一个 App 短时间内
  /// 连发) 静音 (模拟器实测 flags=SILENT), 闹钟类别不受这个限制。
  static Future<int> scheduleReminder({
    required String title,
    String? body,
    required DateTime at,
    bool alarm = false,
  }) async {
    try {
      await init();
      await ensurePermission();
      await _ensureTz();
      /* tz.local 没设成设备时区时 (getLocalTimezone 失败), 按墙上时间构造会
       * 得到一个偏了几小时的时刻 —— 退回用绝对时刻, 至少准。 */
      final when = _tzLocalIsDeviceZone
          ? tz.TZDateTime(
              tz.local,
              at.year,
              at.month,
              at.day,
              at.hour,
              at.minute,
              at.second,
            )
          : tz.TZDateTime.from(at, tz.local);
      /* 已经过去的时间点直接拒绝 —— 系统会立刻弹, 用户会以为是 bug */
      if (!when.isAfter(tz.TZDateTime.now(tz.local))) {
        throw StateError(tr('目标时间已经过去 ($at)'));
      }

      final details = NotificationDetails(
        android: alarm
            ? AndroidNotificationDetails(
                'pilot_alarms',
                tr('Pilot 叫你'),
                channelDescription: tr('Pilot 到点叫你 (电脑不在时由手机响)'),
                importance: Importance.max,
                priority: Priority.max,
                category: AndroidNotificationCategory.alarm,
                audioAttributesUsage: AudioAttributesUsage.alarm,
              )
            : AndroidNotificationDetails(
                'life_reminders',
                tr('提醒'), /* 频道 id 不改: 改了用户在系统里给它的设置就丢了 */
                channelDescription: tr('你让 Neox 定的提醒'),
                importance: Importance.high,
                priority: Priority.high,
              ),
        iOS: DarwinNotificationDetails(
          presentAlert: true,
          presentBanner: true,
          presentSound: true,
        ),
      );
      final id = _nextReminderId();
      final mode = await canScheduleExact()
          ? AndroidScheduleMode.exactAllowWhileIdle
          : AndroidScheduleMode.inexactAllowWhileIdle;
      await _plugin.zonedSchedule(id, title, body, when, details, androidScheduleMode: mode);
      if (alarm) {
        /* 闹钟级的叫你, 跟电脑那边的阶梯一样: 没理会 5 分钟后再响一次。你打开 App (ackAlarms) 就算知道了, 第二遍撤掉 */
        final again = _nextReminderId();
        await _plugin.zonedSchedule(again, title, tr('再叫你一次'), when.add(_kAlarmAgain), details, androidScheduleMode: mode);
        final list = await _followups();
        list.add({'primary': id, 'again': again, 'at': when.millisecondsSinceEpoch});
        await _saveFollowups(list);
      }
      return id;
    } catch (e) {
      debugPrint('[notifications] scheduleReminder failed: $e');
      rethrow;
    }
  }

  /// 这台设备现在能不能排**精确**闹钟.
  ///
  /// 没有精确权限时只能用 inexact, 系统在 Doze 下会把它攒到十几分钟后才弹
  /// (2026-08-11 模拟器实测: 排在 07:52 的提醒, 07:52:47 还挂在 pending 里没响)。
  /// 对"提前 3 天提醒"无所谓, 对"20 分钟后提醒我关火"就是失败。
  ///
  /// 调用方据此决定要不要跟用户说"可能会晚几分钟" —— 不许假装准时。
  static Future<bool> canScheduleExact() async {
    try {
      await init();
      final android = _plugin.resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin>();
      /* iOS 没有这个概念, UNCalendarTrigger 本来就是精确的 */
      if (android == null) return true;
      return (await android.canScheduleExactNotifications()) ?? false;
    } catch (_) {
      return false;
    }
  }

  /// 打开系统「闹钟和提醒」授权页 (Android 14 起新装的 App 默认没有精确闹钟)。iOS 无此概念
  static Future<void> requestExact() async {
    try {
      await init();
      await _plugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()?.requestExactAlarmsPermission();
    } catch (e) {
      debugPrint('[notifications] requestExact failed: $e');
    }
  }

  static const _kAlarmAgain = Duration(minutes: 5);
  static const _kFollowups = 'alarm_followups_v1';

  static Future<List<Map<String, dynamic>>> _followups() async {
    final raw = (await SharedPreferences.getInstance()).getString(_kFollowups);
    if (raw == null) return [];
    return [for (final x in jsonDecode(raw) as List) Map<String, dynamic>.from(x as Map)];
  }

  static Future<void> _saveFollowups(List<Map<String, dynamic>> list) async {
    await (await SharedPreferences.getInstance()).setString(_kFollowups, jsonEncode(list));
  }

  /// 你回到 App 了 = 已经响过的闹钟级提醒你知道了: 撤掉还没响的「再叫你一次」
  static Future<void> ackAlarms() async {
    final list = await _followups();
    if (list.isEmpty) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    final keep = <Map<String, dynamic>>[];
    for (final f in list) {
      if ((f['at'] as num) <= now) {
        await cancelReminder((f['again'] as num).toInt());
      } else {
        keep.add(f);
      }
    }
    await _saveFollowups(keep);
  }

  /// 撤掉一条已排的提醒 (连它的「再叫你一次」).
  static Future<void> cancelReminder(int id) async {
    try {
      await init();
      final list = await _followups();
      final f = list.where((x) => x['primary'] == id).firstOrNull;
      if (f != null) {
        await _plugin.cancel((f['again'] as num).toInt());
        list.remove(f);
        await _saveFollowups(list);
      }
      await _plugin.cancel(id);
    } catch (e) {
      debugPrint('[notifications] cancelReminder failed: $e');
    }
  }

  /// 每天固定钟点一条 (同 [id] 重排即覆盖)。点开带 [payload] 交给 [onPayloadTap]。
  static Future<void> scheduleDaily({
    required int id,
    required int hour,
    required int minute,
    required String title,
    String? body,
    String? payload,
  }) async {
    try {
      await init();
      await ensurePermission();
      await _ensureTz();
      final now = tz.TZDateTime.now(tz.local);
      var when = tz.TZDateTime(tz.local, now.year, now.month, now.day, hour, minute);
      if (!when.isAfter(now)) when = when.add(const Duration(days: 1));
      const details = NotificationDetails(
        android: AndroidNotificationDetails(
          'pilot_checkin',
          'Pilot 每晚问一句',
          channelDescription: '每晚问你今天花了多少、过得怎样',
          importance: Importance.defaultImportance,
        ),
        iOS: DarwinNotificationDetails(presentAlert: true, presentBanner: true),
      );
      await _plugin.zonedSchedule(id, title, body, when, details,
          androidScheduleMode: AndroidScheduleMode.inexactAllowWhileIdle,
          matchDateTimeComponents: DateTimeComponents.time,
          payload: payload);
    } catch (e) {
      debugPrint('[notifications] scheduleDaily failed: $e');
    }
  }

  /// 通知 id 分配 —— 秒级时间戳会撞 (同一轮里连排"提前3天"和"当天"两条),
  /// 所以带一个进程内自增尾数。
  static int _idSeq = 0;
  static int _nextReminderId() {
    _idSeq = (_idSeq + 1) % 1000;
    final base = DateTime.now().millisecondsSinceEpoch ~/ 1000 % 0x1fffff;
    return (base * 1000 + _idSeq) % 0x7fffffff;
  }
}
