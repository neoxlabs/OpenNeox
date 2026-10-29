/// inbox.dart — 「消息」页的数据: 手机收到过的每条通知都记一份 (2026-10-10).
///
/// 用户: 「推送后没有消息显示页面, 我就很懵」—— 通知栏一划就没了, 点进 App 也找不到刚才说了什么。
/// 来源三路, 都汇到这里:
///   · 推送 (App 没开 / 被杀时由原生收, 攒在原生队列, 发行版的推送模块取回来 [ingest])
///   · Agent 事件通知 (审批 / 跑完 / 中断) —— LocalNotifications.showAgentEvent
///   · 提醒 —— LocalNotifications.showReminder
/// 只存本机 (SharedPreferences, 最多 300 条)。点通知进 App 时 [requestOpen] 让外壳打开消息页。
library;

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

class InboxItem {
  InboxItem({
    required this.id,
    required this.kind,
    required this.title,
    required this.body,
    required this.ts,
    this.read = false,
    this.sessionId,
  });

  final String id;

  /// alert (推送) / call (来电) / agent (任务事件) / reminder (提醒)
  final String kind;
  final String title;
  final String body;
  final int ts;
  bool read;

  /// Agent 事件: 点开回到这个会话
  final String? sessionId;

  Map<String, Object?> toJson() => {'id': id, 'kind': kind, 'title': title, 'body': body, 'ts': ts, 'read': read, 'sid': sessionId};

  static InboxItem? fromJson(Object? j) {
    if (j is! Map) return null;
    return InboxItem(
      id: '${j['id'] ?? j['ts'] ?? ''}',
      kind: '${j['kind'] ?? 'alert'}',
      title: '${j['title'] ?? ''}',
      body: '${j['body'] ?? ''}',
      ts: (j['ts'] as num?)?.toInt() ?? 0,
      read: j['read'] == true,
      sessionId: j['sid'] as String?,
    );
  }
}

class InboxStore extends ChangeNotifier {
  InboxStore._();

  /// 单例: LocalNotifications 是静态类, 拿不到 ref, 直接记到这里
  static final InboxStore instance = InboxStore._();

  static const _key = 'neox_inbox_v1';
  static const _max = 300;

  final List<InboxItem> _items = [];
  bool _loaded = false;

  /// 点了推送通知进来 → 外壳 (app.dart) 听这个打开消息页
  final ValueNotifier<int> openRequests = ValueNotifier(0);

  List<InboxItem> get items => List.unmodifiable(_items);
  int get unread => _items.where((e) => !e.read).length;

  Future<void> load() async {
    if (_loaded) return;
    _loaded = true;
    try {
      final raw = (await SharedPreferences.getInstance()).getString(_key);
      if (raw != null) {
        _items
          ..clear()
          ..addAll((jsonDecode(raw) as List).map(InboxItem.fromJson).whereType<InboxItem>());
      }
    } catch (e) {
      debugPrint('[inbox] load failed: $e');
    }
    notifyListeners();
  }

  Future<void> _save() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_key, jsonEncode(_items.map((e) => e.toJson()).toList()));
    } catch (e) {
      debugPrint('[inbox] save failed: $e');
    }
  }

  Future<void> add({required String kind, required String title, String? body, String? sessionId, int? ts}) async {
    await load();
    final t = ts ?? DateTime.now().millisecondsSinceEpoch;
    _items.insert(0, InboxItem(id: '$t-${_items.length}', kind: kind, title: title, body: body ?? '', ts: t, sessionId: sessionId));
    if (_items.length > _max) _items.removeRange(_max, _items.length);
    notifyListeners();
    await _save();
  }

  /// 原生队列取回来的推送 (按时间排进去, 同一条不重复记)
  Future<void> ingest(List<Map<String, Object?>> raw) async {
    if (raw.isEmpty) return;
    await load();
    final seen = _items.map((e) => '${e.ts}|${e.title}').toSet();
    for (final r in raw) {
      final ts = (r['ts'] as num?)?.toInt() ?? DateTime.now().millisecondsSinceEpoch;
      final title = '${r['title'] ?? ''}';
      if (!seen.add('$ts|$title')) continue;
      _items.add(InboxItem(id: '$ts-n', kind: '${r['kind'] ?? 'alert'}', title: title, body: '${r['body'] ?? ''}', ts: ts));
    }
    _items.sort((a, b) => b.ts.compareTo(a.ts));
    if (_items.length > _max) _items.removeRange(_max, _items.length);
    notifyListeners();
    await _save();
  }

  Future<void> markAllRead() async {
    if (unread == 0) return;
    for (final e in _items) {
      e.read = true;
    }
    notifyListeners();
    await _save();
  }

  Future<void> remove(String id) async {
    _items.removeWhere((e) => e.id == id);
    notifyListeners();
    await _save();
  }

  Future<void> clear() async {
    _items.clear();
    notifyListeners();
    await _save();
  }

  /// 点的那条通知要去哪: inbox = 消息页 / pilot_today = Pilot「今天」页 (到点提醒、晨间简报)
  String openTarget = 'inbox';

  /// 点的是哪一条 ({title, body, data}) —— 落地页顶上摆它, 一次性: 取走就清 (2026-10-11 用户: 推送点进去啥也没有)
  Map<String, Object?>? _openItem;

  Map<String, Object?>? takeOpenItem() {
    final it = _openItem;
    _openItem = null;
    return it;
  }

  void requestOpen({String target = 'inbox', Map<String, Object?>? item}) {
    openTarget = target;
    _openItem = item;
    openRequests.value++;
  }

  /// 进程级单例, 不跟着 Provider 一起销毁 (2026-10-18)。
  ///
  /// [inboxProvider] 是 ChangeNotifierProvider, 作用域退出时会 dispose 它的 notifier。
  /// 单例被第一个作用域 dispose 之后, 同进程里后建的作用域 (外壳重建、测试之间)
  /// 一读就抛「A InboxStore was used after being disposed」。
  /// Provider 退出时已经先摘掉自己的 listener (riverpod 的 runOnDispose 先 removeListener
  /// 再 dispose), 所以这里跳过 dispose 不会留下悬挂监听; 单例活到进程结束。
  @override
  // ignore: must_call_super
  void dispose() {
    /* 故意不销毁单例: 它不是 Provider 的私有对象, LocalNotifications 等静态入口也直接用它 */
  }
}

final inboxProvider = ChangeNotifierProvider<InboxStore>((ref) {
  final s = InboxStore.instance;
  s.load();
  return s;
});
