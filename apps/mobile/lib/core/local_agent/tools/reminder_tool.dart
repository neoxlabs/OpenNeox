/// reminder_tool.dart — 手机本地 agent 的定时提醒工具.
///
/// 为什么必须有它 (2026-08-11 走查发现):
///   Life 场景卡的 prompt 里明写着 `schedule_reminder 提前 3 天和当天各推一次`
///   (life_events_provider.dart:118 / :122), 而手机本地 agent 的工具表里只有
///   http_fetch / clock / calculator / workspace_files —— **这个工具根本不存在**。
///   模型面对不存在的工具只能幻觉一句"已为你设置提醒", 然后什么都不会发生。
///   而 Life 是移动端的默认模式, 面向的恰恰是最不会去核实的那批用户。
///
/// 真正的定时触发原本在桌面 JobRunner 上, 纯手机用户拿不到。这里改成手机自己排:
/// zonedSchedule 交给系统闹钟 (Android AlarmManager / iOS UNCalendarTrigger),
/// **app 被杀掉照样按时响, 不依赖推送通道, 也不依赖电脑在线**。
///
/// 这个工具属于宿主注入 (需要 flutter_local_notifications), 不能放进纯 Dart 的
/// agentsdk 包里。
library;

import 'dart:convert';

import 'package:neox_agent_sdk/neox_agent_sdk.dart' as sdk;
import 'package:shared_preferences/shared_preferences.dart';

import '../../notifications/local_notifications.dart';

/// 一条已排的提醒 — 存 SharedPreferences, 让 list/cancel 有据可依.
class ScheduledReminder {
  const ScheduledReminder({
    required this.id,
    required this.title,
    required this.body,
    required this.atMs,
  });

  final int id;
  final String title;
  final String body;
  final int atMs;

  DateTime get at => DateTime.fromMillisecondsSinceEpoch(atMs);

  Map<String, Object?> toJson() =>
      {'id': id, 'title': title, 'body': body, 'at': atMs};

  static ScheduledReminder? fromJson(Object? j) {
    if (j is! Map) return null;
    final id = j['id'];
    final at = j['at'];
    if (id is! int || at is! int) return null;
    return ScheduledReminder(
      id: id,
      title: (j['title'] as String?) ?? '提醒',
      body: (j['body'] as String?) ?? '',
      atMs: at,
    );
  }
}

/// 提醒的本地台账 — 系统那边只认 id, 要给用户/模型看清单就得自己记.
class ReminderStore {
  static const _kPref = 'neox_scheduled_reminders_v1';

  Future<List<ScheduledReminder>> all() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_kPref);
    if (raw == null || raw.isEmpty) return const [];
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! List) return const [];
      final out = <ScheduledReminder>[];
      for (final item in decoded) {
        final r = ScheduledReminder.fromJson(item);
        if (r != null) out.add(r);
      }
      /* 过期的自动淘汰 —— 系统那条通知早就弹过了, 留在清单里只会误导模型 */
      final now = DateTime.now().millisecondsSinceEpoch;
      final live = out.where((r) => r.atMs > now).toList()
        ..sort((a, b) => a.atMs.compareTo(b.atMs));
      if (live.length != out.length) await _save(prefs, live);
      return live;
    } catch (_) {
      return const [];
    }
  }

  Future<void> add(ScheduledReminder r) async {
    final prefs = await SharedPreferences.getInstance();
    final list = [...await all(), r]..sort((a, b) => a.atMs.compareTo(b.atMs));
    await _save(prefs, list);
  }

  Future<bool> remove(int id) async {
    final prefs = await SharedPreferences.getInstance();
    final list = await all();
    final next = list.where((r) => r.id != id).toList();
    if (next.length == list.length) return false;
    await _save(prefs, next);
    return true;
  }

  Future<void> _save(SharedPreferences prefs, List<ScheduledReminder> list) {
    return prefs.setString(
      _kPref,
      jsonEncode([for (final r in list) r.toJson()]),
    );
  }
}

class ReminderTool implements sdk.AgentTool {
  ReminderTool({ReminderStore? store, DateTime Function()? now, this.alarm = false})
      : _store = store ?? ReminderStore(),
        _now = now ?? DateTime.now;

  final ReminderStore _store;
  final DateTime Function() _now;

  /// 按闹钟响 + 没理会 5 分钟再响一次 (Pilot 的叫你; 普通会话里的提醒还是普通通知)
  final bool alarm;

  @override
  sdk.ToolSpec get spec => const sdk.ToolSpec(
        name: 'schedule_reminder',
        description:
            '在这台手机上设一个定时提醒 (到点弹通知, 关掉 app 也会响)。'
            'op=create 新建提醒, 需要 at (本地时间 "YYYY-MM-DD HH:MM") 和 title; '
            'op=list 列出还没到期的提醒; op=cancel 按 id 取消。'
            '涉及"提前 N 天提醒"就调多次 create。不确定今天是几号先调 clock。',
        parameters: {
          'type': 'object',
          'properties': {
            'op': {
              'type': 'string',
              'enum': ['create', 'list', 'cancel'],
              'description': '操作类型',
            },
            'at': {
              'type': 'string',
              'description':
                  '触发时间, 本地时间, 格式 "YYYY-MM-DD HH:MM" (op=create 必填)',
            },
            'title': {
              'type': 'string',
              'description': '通知标题, 一句话说清提醒什么 (op=create 必填)',
            },
            'body': {'type': 'string', 'description': '通知正文, 可选'},
            'id': {'type': 'integer', 'description': '要取消的提醒 id (op=cancel 必填)'},
          },
          'required': ['op'],
        },
      );

  @override
  Future<sdk.ToolResult> run(
    Map<String, Object?> args,
    sdk.ToolContext ctx,
  ) async {
    final op = (args['op'] as String?)?.trim().toLowerCase() ?? 'create';
    switch (op) {
      case 'create':
        return _create(args);
      case 'list':
        return _list();
      case 'cancel':
        return _cancel(args);
      default:
        return sdk.ToolResult.error('未知 op "$op" (支持 create/list/cancel)');
    }
  }

  Future<sdk.ToolResult> _create(Map<String, Object?> args) async {
    final title = (args['title'] as String?)?.trim() ?? '';
    if (title.isEmpty) return const sdk.ToolResult.error('title 不能为空');
    final atRaw = (args['at'] as String?)?.trim() ?? '';
    final at = parseLocalDateTime(atRaw);
    if (at == null) {
      return sdk.ToolResult.error(
        'at 解析不了: "$atRaw"。要 "YYYY-MM-DD HH:MM" 这种本地时间格式。',
      );
    }
    if (!at.isAfter(_now())) {
      return sdk.ToolResult.error(
        '$atRaw 已经过去了, 设不了提醒。先用 clock 确认今天是几号。',
      );
    }
    final body = (args['body'] as String?)?.trim() ?? '';
    final int id;
    try {
      id = await LocalNotifications.scheduleReminder(
        title: title,
        body: body.isEmpty ? null : body,
        at: at,
        alarm: alarm,
      );
    } catch (e) {
      /* 把真实原因原样交给模型.
       *
       * 之前这里是"失败就一律说通知权限没开" —— 实测真因是时区没设成设备时区,
       * 模型据此把用户支去开「通知使用权」这个完全不相干的系统开关, 连开两次都
       * 没用。猜原因比不给原因更糟: 用户会照着错的指引白折腾。 */
      return sdk.ToolResult.error('排提醒失败: $e');
    }
    await _store.add(
      ScheduledReminder(
        id: id,
        title: title,
        body: body,
        atMs: at.millisecondsSinceEpoch,
      ),
    );
    /* 精度要如实说.
     *
     * 没有精确闹钟权限时系统会把提醒攒到十几分钟后才弹 (模拟器实测过)。
     * 对"提前 3 天"无所谓, 对"20 分钟后关火"就是失败 —— 用户按我们说的"准时"
     * 去安排事情, 结果晚了十分钟, 这跟提醒根本没设上一样糟。 */
    final exact = await LocalNotifications.canScheduleExact();
    final precision = exact
        ? '到点准时响, 关掉 app 也一样。'
        : '关掉 app 也会响, 但系统没给精确闹钟权限, **可能晚几分钟到十几分钟** —— '
            '需要卡点的话让用户去「设置 → 应用 → Neox → 闹钟和提醒」打开。';
    return sdk.ToolResult.ok(
      '已设提醒 (id=$id): ${_fmt(at)} — $title。$precision',
    );
  }

  Future<sdk.ToolResult> _list() async {
    final list = await _store.all();
    if (list.isEmpty) return const sdk.ToolResult.ok('当前没有待触发的提醒。');
    final lines = [
      for (final r in list)
        'id=${r.id}  ${_fmt(r.at)}  ${r.title}${r.body.isEmpty ? '' : ' — ${r.body}'}',
    ];
    return sdk.ToolResult.ok('待触发的提醒 ${list.length} 条:\n${lines.join('\n')}');
  }

  Future<sdk.ToolResult> _cancel(Map<String, Object?> args) async {
    final id = args['id'];
    final intId = id is int ? id : int.tryParse('${id ?? ''}');
    if (intId == null) return const sdk.ToolResult.error('cancel 需要 id');
    final existed = await _store.remove(intId);
    await LocalNotifications.cancelReminder(intId);
    return existed
        ? sdk.ToolResult.ok('已取消提醒 id=$intId')
        : sdk.ToolResult.ok('没有 id=$intId 这条提醒 (可能已经触发或被取消过)');
  }

  static String _fmt(DateTime d) =>
      '${d.year}-${_p(d.month)}-${_p(d.day)} ${_p(d.hour)}:${_p(d.minute)}';

  static String _p(int v) => v.toString().padLeft(2, '0');
}

/// 解析模型给的时间字符串.
///
/// 模型的格式很不稳定 —— 同一个模型这轮给 "2026-08-15 09:00", 下轮给
/// "2026/08/15 9:00", 再下轮给 ISO8601。宽松解析比在 prompt 里反复强调格式管用,
/// 这里的失败代价是"提醒没设上"而用户以为设上了。
DateTime? parseLocalDateTime(String raw) {
  var s = raw.trim();
  if (s.isEmpty) return null;

  /* 先把时区后缀剥掉再解析 (2026-08-11 单测抓到的两个错时提醒):
   *
   * DateTime.tryParse('2026-08-15T09:00:00+08:00') 会**换算成 UTC**, 之后读
   * .hour 拿到的是 1 点不是 9 点 —— 用户说"早上9点"的提醒会在凌晨 1 点响。
   * 用户说的时间永远是墙上时间, 模型自作主张加的偏移不该被当真。 */
  s = s.replaceFirst(RegExp(r'(?:Z|[+-]\d{2}:?\d{2})$'), '').trim();

  /* 只给日期 (没有时分) 要在 tryParse 之前拦下 —— tryParse('2026-08-15') 会
   * 成功并给出 00:00, 于是"提前 3 天提醒"变成半夜零点把人吵醒。 */
  final dateOnly =
      RegExp(r'^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?$').firstMatch(s);
  if (dateOnly != null) {
    return DateTime(
      int.parse(dateOnly.group(1)!),
      int.parse(dateOnly.group(2)!),
      int.parse(dateOnly.group(3)!),
      9,
    );
  }

  final iso = DateTime.tryParse(s);
  if (iso != null) {
    return DateTime(iso.year, iso.month, iso.day, iso.hour, iso.minute);
  }
  final m = RegExp(
    r'^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?[\sT]+(\d{1,2})[:：点时](\d{1,2})',
  ).firstMatch(s);
  if (m != null) {
    return DateTime(
      int.parse(m.group(1)!),
      int.parse(m.group(2)!),
      int.parse(m.group(3)!),
      int.parse(m.group(4)!),
      int.parse(m.group(5)!),
    );
  }
  return null;
}
