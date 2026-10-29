/// pilot_records_page.dart — 我的世界: 八个房间 (2026-10-11, 设计见 docs/NEOX_PILOT_ASSISTANT_DESIGN_2026_10_11.md §1 §2)。
///
/// 用户: 「只有表格、只有横向文字太老套 …… 当游戏画面做」; 「人的方方面面 …… 家庭、住宅、资产、水电费 …… 归成几个类, 做好页面」。
///
///   顶    返回 · 当前房间 (点开是八个房间的地图) · 它发现的 · 流水
///   中    八个房间横滑, 每个房间一块陶土场景 + 一个大数 + 一条任务提示 + 最多三四个泡泡:
///           身体 (分身) · 钱 (今天花销 / 净资产) · 家 (账单 / 车) · 人 (生日 / 多久没联系) ·
///           工作学习 (交给它做) · 足迹 · 心 (今天的脸) · 我 (关于你 / 知识库 / 关注点)
///   底    截图记 · 说一句 (长按打字) · 自动记账
///
/// 数在服务端算好 (/overview = 洞察 + summarizeRooms), 这里只画; 断网也能记 (先存手机, 联网补传)。
/// 房间画面在 pilot_rooms.dart (part)。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:neox_app/core/i18n/tr.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../core/notifications/local_notifications.dart';
import '../../core/pilot/payment_parser.dart';
import '../../core/pilot/pilot_cloud.dart';
import '../../core/pilot/pilot_records.dart';
import '../../shared/theme/neox_tokens.dart';
import '../voice/inline_voice.dart';
import 'auto_ledger.dart';
import 'context_sense.dart';
import 'pilot_ears.dart';
import 'pilot_link.dart';
import 'pilot_talk.dart';

part 'pilot_rooms.dart';
part 'pilot_scenes.dart';

/// 类型 → 陶土图 / 中文名 / 怎么显示值
class _Kind {
  const _Kind(this.clay, this.label, {this.format});
  final String clay;
  final String label;
  final String Function(PilotRecord r)? format;
}

String _num(double v) => v == v.roundToDouble() ? v.toStringAsFixed(0) : v.toStringAsFixed(1);
/// ¥35 / $5 / 120 HKD —— 常见币种用符号, 其余写代码
String _money(double v, String? currency) {
  const sym = {'CNY': '¥', 'RMB': '¥', 'USD': r'$', 'EUR': '€', 'GBP': '£', 'JPY': '¥'};
  final c = (currency ?? 'CNY').toUpperCase();
  final s = sym[c];
  if (s == null) return '${_num(v)} $c';
  /* 千元以上加千分位 (+¥15,000), 零头照留 */
  return v.abs() >= 1000 ? _yuan(v).replaceFirst('¥', s) : '$s${_num(v)}';
}

/// 场景里的大数: 百元以上取整加千分位 (¥9,868), 小钱留一位 (¥35.5)
String _yuan(double v) {
  if (v.abs() < 100) return '¥${_num(v)}';
  final s = v.round().toString();
  final b = StringBuffer();
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 == 0) b.write(',');
    b.write(s[i]);
  }
  return '¥$b';
}

/// 泡泡里的大钱: 一万以上写「万」(¥207万), 不然一个泡泡装不下
String _yuanShort(double v) {
  if (v.abs() < 10000) return _yuan(v);
  final w = v / 10000;
  return '${v < 0 ? '−' : ''}¥${_num(w.abs() >= 100 ? w.abs().roundToDouble() : (w.abs() * 10).round() / 10)}万';
}

String _hm(DateTime t) => '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

final Map<String, _Kind> _kinds = {
  'health.weight': _Kind('i-pulse', '体重', format: (r) => '${_num(r.value ?? 0)} kg'),
  'health.steps': _Kind('i-route', '步数', format: (r) => '${_num(r.value ?? 0)} 步'),
  'health.heart_rate': _Kind('i-pulse', '心率', format: (r) => '${_num(r.value ?? 0)} 次/分'),
  'health.sleep': _Kind('i-moon', '睡眠', format: (r) => _hours((r.value ?? 0).round())),
  'mood': _Kind('i-sun', '心情', format: (r) => _moodFace((r.value ?? 3).round())),
  'finance.expense': _Kind('i-receipt', '支出', format: (r) => _money(r.value ?? 0, r.unit)),
  'finance.income': _Kind('i-receipt', '收入', format: (r) => '+${_money(r.value ?? 0, r.unit)}'),
  'habit.check': const _Kind('i-badge', '打卡'),
  'place.visit': const _Kind('i-route', '到访'),
  'social.interaction': const _Kind('i-person', '来往'),
  'event.calendar': const _Kind('i-calendar', '日程'),
  'work.focus': const _Kind('i-laptop', '专注'),
  'task': const _Kind('i-list', '待办'),
  'media.photo': const _Kind('i-app', '照片'),
  'fact.assert': const _Kind('i-info', '关于你'),
  'note': const _Kind('i-chat', '随手记'),
};

String _hours(int m) => '${m ~/ 60} 小时${m % 60 == 0 ? '' : ' ${m % 60} 分'}';

const _faces = ['😣', '😕', '🙂', '😊', '😄'];
String _moodFace(int score) => _faces[(score.clamp(1, 5)) - 1];

/// 分身: 青年 / 中年 / 老年 × 男女 (assets/twin, gpt-image 出的陶土人, 绿幕抠图)
const _looks = ['young-m', 'young-f', 'mid-m', 'mid-f', 'old-m', 'old-f'];
const _kLook = 'pilot_twin_look_v1';
/// 长按分身弹的那张里「改关注点」的回传值
const _kFocusEntry = '__focus';
String _twinArt(String look) => 'assets/twin/twin-$look.webp';
String _worldArt(String name) => 'assets/twin/world-$name.webp';

/// 四个场景: 名字只在选中时露出来
/// 八个房间 (顺序 = 服务端 ROOMS): (id, 陶土图标, 名字, 场景图)
const _rooms = [
  ('body', 'i-pulse', '身体', 'body'),
  ('money', 'i-coins', '钱', 'money'),
  ('home', 'i-house', '家', 'life'),
  ('people', 'i-person', '人', 'people'),
  ('work', 'i-laptop', '工作学习', 'work'),
  ('place', 'i-route', '足迹', 'trips'),
  ('mind', 'i-heart', '心', 'mood'),
  ('me', 'i-book', '我', 'me'),
];
final _worlds = [for (final r in _rooms) (r.$2, r.$3)];
int _roomIndex(String id) => _rooms.indexWhere((r) => r.$1 == id);

/// 衣食住行的泡泡: 维度 → (字, 记一笔时预填的分类)
const _dimLabels = {
  LifeDim.food: ('食', '吃饭'),
  LifeDim.travel: ('行', '交通'),
  LifeDim.home: ('住', '居家'),
  LifeDim.clothes: ('衣', '衣着'),
  LifeDim.other: ('其它', '购物'),
};

class PilotRecordsPage extends ConsumerStatefulWidget {
  const PilotRecordsPage({super.key, this.pilot, this.focusInsight});
  /// 说一句交给谁 (从 Pilot 页进来时带着); 没有就不显示说话钮
  final PilotContact? pilot;
  /// 从 Pilot 页「今日要事」点进来: 加载完直接翻到这张卡
  final String? focusInsight;

  @override
  ConsumerState<PilotRecordsPage> createState() => _PilotRecordsPageState();
}

class _PilotRecordsPageState extends ConsumerState<PilotRecordsPage> with TickerProviderStateMixin {
  DateTime _day = DateTime.now();
  /// 正在看的那一天 (花销 / 流水)
  List<PilotRecord>? _items;
  /// 今天 (身体 / 心情两页用, 不跟着翻日子)
  List<PilotRecord> _todayItems = const [];
  String? _error;
  List<PilotMetricPoint> _weight = const [];
  List<PilotMetricPoint> _mood7 = const [];
  double? _spent7;
  List<PilotRecord> _places = const [];
  PilotRecord? _sleep;
  /// 它从这一年的记录里看出来的事 (服务端算, 按要紧排好)
  List<PilotInsight> _insights = const [];
  /// 八个房间的数 (服务端 summarizeRooms)
  Map<String, dynamic> _roomData = const {};
  Map<String, dynamic> _room(String id) => _roomData[id] is Map ? Map<String, dynamic>.from(_roomData[id] as Map) : const {};
  bool _focusShown = false;
  /// 第一次进来的挑形象 + 关注点 (完了才弹别的底板)
  Future<void>? _onboarding;
  /// 近 60 天的打卡 (算连续天数)
  List<PilotRecord> _habitRecs = const [];
  String _look = _looks.first;
  int _world = 0;
  bool _pickingMood = false;

  final _pager = PageController();
  /* 全场共用一个慢节拍: 泡泡错相浮动、人物呼吸 */
  late final AnimationController _float = AnimationController(vsync: this, duration: const Duration(seconds: 4))..repeat();
  late final AnimationController _jump = AnimationController(vsync: this, duration: const Duration(milliseconds: 560));
  late final AnimationController _coins = AnimationController(vsync: this, duration: const Duration(milliseconds: 1200));

  String? _bubble;
  Timer? _bubbleTimer;

  /* 说一句 */
  InlineVoiceController? _voice;
  bool _listening = false;
  bool _thinking = false;
  String _heard = '';
  DateTime _lastHeard = DateTime.now();
  double _level = 0;
  Timer? _levelTick;
  Timer? _endTimer;

  PilotRecordsApi? get _api => ref.read(pilotCloudProvider)?.records;

  bool get _isToday {
    final n = DateTime.now();
    return _day.year == n.year && _day.month == n.month && _day.day == n.day;
  }

  @override
  void initState() {
    super.initState();
    unawaited(_load());
    unawaited(_loadWorld());
    unawaited(_loadLook());
  }

  @override
  void dispose() {
    _float.dispose();
    _jump.dispose();
    _coins.dispose();
    _pager.dispose();
    _bubbleTimer?.cancel();
    _levelTick?.cancel();
    _endTimer?.cancel();
    _voice?.dispose();
    super.dispose();
  }

  // ───────── 数据 ─────────

  Future<void> _loadLook() async {
    final saved = (await SharedPreferences.getInstance()).getString(_kLook);
    if (!mounted) return;
    if (saved != null && _looks.contains(saved)) {
      setState(() => _look = saved);
    } else {
      /* 第一次进来先挑个像自己的, 再说最想让它盯什么 */
      final done = Completer<void>();
      _onboarding = done.future;
      WidgetsBinding.instance.addPostFrameCallback((_) async {
        try {
          if (!mounted) return;
          await _pickLook();
          if (mounted) await _pickFocus();
        } finally {
          done.complete();
        }
      });
    }
  }

  /// 「先帮你盯什么」: 存进档案 (fact pilot.focus), 洞察按它排先后, Pilot 每轮的档案里也看得到
  Future<void> _pickFocus() async {
    final picked = await showModalBottomSheet<List<String>>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (c) => const _FocusPicker(),
    );
    if (picked == null || picked.isEmpty) return;
    await _api?.log([{'type': 'fact.assert', 'data': {'key': 'pilot.focus', 'value': picked}}]);
    _say(tr('记住了，我先帮你盯着这几样'));
    unawaited(_loadWorld());
  }

  Future<void> _load() async {
    final api = _api;
    if (api == null) return;
    try {
      final viewing = _isToday;
      final list = await api.day(_day);
      /* 身体 / 心情两页永远看今天; 花销和流水翻到别的日子时, 今天那份另拉一次 */
      final today = viewing ? list : await _safe(api.day(DateTime.now()), _todayItems);
      if (!mounted) return;
      setState(() { _items = list; _todayItems = today; _error = null; });
    } catch (e) {
      if (!mounted) return;
      setState(() { _items ??= const []; _error = '$e'.replaceFirst('Bad state: ', ''); });
    }
  }

  Future<T> _safe<T>(Future<T> f, T fallback) => f.catchError((Object _) => fallback);

  Future<void> _loadWorld() async {
    final api = _api;
    if (api == null) return;
    final now = DateTime.now();
    final r = await Future.wait([
      _safe(api.metric('health.weight', from: now.subtract(const Duration(days: 30)), to: now), const <PilotMetricPoint>[]),
      _safe(api.metric('finance.expense:CNY', from: now.subtract(const Duration(days: 6)), to: now), const <PilotMetricPoint>[]),
      _safe(api.metric('mood', from: now.subtract(const Duration(days: 6)), to: now), const <PilotMetricPoint>[]),
    ]);
    final q = await Future.wait([
      _safe(api.query(types: ['health.sleep'], from: now.subtract(const Duration(days: 3)), limit: 5), const <PilotRecord>[]),
      _safe(api.query(types: ['place.visit'], from: now.subtract(const Duration(days: 90)), limit: 30), const <PilotRecord>[]),
      _safe(api.query(types: ['habit.check'], from: now.subtract(const Duration(days: 60)), limit: 200), const <PilotRecord>[]),
    ]);
    _habitRecs = q[2];
    /* 洞察 + 八个房间的数一次拿齐 (拿不到就退回只要洞察) */
    final ov = await _safe<PilotOverview?>(api.overview(), null);
    final List<PilotInsight> insights = ov?.insights ?? await _safe(api.insights(), const <PilotInsight>[]);
    _roomData = ov?.rooms ?? _roomData;
    final top = insights.where((i) => i.tone == 'watch').firstOrNull;
    unawaited(ref.read(autoLedgerProvider.notifier).refreshCheckin(top?.title));
    if (!mounted) return;
    final focus = widget.focusInsight;
    if (focus != null && !_focusShown && insights.any((i) => i.id == focus)) {
      _focusShown = true;
      /* 背后的房间也跳到这张卡所属的那间 (关掉卡组看到的就是它说的那件事) */
      final room = _worldOf(insights.firstWhere((i) => i.id == focus));
      WidgetsBinding.instance.addPostFrameCallback((_) async {
        /* 第一次进来先挑形象 / 关注点, 挑完再出卡 (2026-10-11 实测: 两张底板叠在一起) */
        await _onboarding;
        if (!mounted) return;
        if (room != _world) _pager.jumpToPage(room);
        unawaited(_openInsights(focus: focus));
      });
    }
    setState(() {
      _insights = insights;
      _weight = r[0];
      _spent7 = r[1].isEmpty ? null : r[1].map((p) => p.value).reduce((a, b) => a + b);
      _mood7 = r[2];
      _sleep = q[0].isEmpty ? null : q[0].reduce((a, b) => a.at.isAfter(b.at) ? a : b);
      _places = [...q[1]]..sort((a, b) => b.at.compareTo(a.at));
    });
  }

  Future<void> _reload() async {
    await Future.wait([_load(), _loadWorld()]);
  }

  void _backToToday() {
    HapticFeedback.selectionClick();
    setState(() { _day = DateTime.now(); _items = null; });
    unawaited(_load());
  }

  void _shift(int days) {
    final next = DateTime(_day.year, _day.month, _day.day + days);
    if (next.isAfter(DateTime.now())) return;
    HapticFeedback.selectionClick();
    setState(() { _day = next; _items = null; });
    unawaited(_load());
  }

  Future<void> _log(Map<String, Object?> record) async {
    final api = _api;
    if (api == null) return;
    /* 花销翻到别的日子时记到那一天的这个钟点 (补记昨天的午饭); 身体 / 心情那几页只看今天, 一律记现在 */
    final now = DateTime.now();
    final backfill = !_isToday && record['type'] == 'finance.expense';
    final at = backfill ? DateTime(_day.year, _day.month, _day.day, now.hour, now.minute) : now;
    await api.log([{...record, 'occurred_at': record['occurred_at'] ?? at.millisecondsSinceEpoch}]);
    if (record['type'] == 'finance.expense') _dropCoins();
    await _reload();
  }

  Future<bool> _delete(PilotRecord r) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text(tr('删掉这条记录?')),
        content: Text(r.title.isEmpty ? (_kinds[r.type]?.label ?? r.type) : r.title),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: Text(tr('取消'))),
          TextButton(onPressed: () => Navigator.pop(c, true), child: Text(tr('删除'))),
        ],
      ),
    );
    if (ok != true) return false;
    try {
      await _api?.delete(r.id);
      unawaited(_reload());
      return true;
    } catch (e) {
      _toast(tr('没删掉: $e'));
      return false;
    }
  }

  void _toast(String s) {
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(s)));
  }

  // ───────── 小动作 ─────────

  void _say(String s, {Duration hold = const Duration(seconds: 5)}) {
    _bubbleTimer?.cancel();
    setState(() => _bubble = s);
    _bubbleTimer = Timer(hold, () { if (mounted) setState(() => _bubble = null); });
  }

  void _dropCoins() {
    HapticFeedback.lightImpact();
    unawaited(_coins.forward(from: 0));
  }

  void _tapTwin() {
    HapticFeedback.lightImpact();
    unawaited(_jump.forward(from: 0));
    _say(_twinLine());
  }

  // ───────── 打卡 ─────────

  /// 每个习惯: 连续天数 (今天没打不算断, 从昨天往回数) + 今天打了没; 最近打过的排前面
  List<({String name, int streak, bool doneToday})> get _habitStreaks {
    DateTime d0(DateTime t) => DateTime(t.year, t.month, t.day);
    final today = d0(DateTime.now());
    final days = <String, Set<DateTime>>{};
    final last = <String, DateTime>{};
    for (final r in _habitRecs) {
      if (r.data['done'] == false) continue;
      final h = '${r.data['habit'] ?? ''}'.trim();
      if (h.isEmpty) continue;
      (days[h] ??= {}).add(d0(r.at));
      if (last[h] == null || r.at.isAfter(last[h]!)) last[h] = r.at;
    }
    final out = [
      for (final e in days.entries)
        () {
          final done = e.value.contains(today);
          var cur = done ? today : today.subtract(const Duration(days: 1));
          var n = 0;
          while (e.value.contains(cur)) { n++; cur = cur.subtract(const Duration(days: 1)); }
          return (name: e.key, streak: n, doneToday: done);
        }(),
    ];
    out.sort((a, b) => last[b.name]!.compareTo(last[a.name]!));
    return out;
  }

  Future<void> _checkIn(String? habit, {bool already = false, int streak = 0}) async {
    if (already) {
      _say(tr('$habit 今天打过了，连续 $streak 天'));
      return;
    }
    final name = habit ?? (await _sheet<String>((c) => const _NoteSheet(title: '打卡什么', hint: '跑步 / 背单词 / 早睡…')))?.trim();
    if (name == null || name.isEmpty) return;
    HapticFeedback.mediumImpact();
    final now = DateTime.now();
    await _api?.log([{'type': 'habit.check', 'occurred_at': now.millisecondsSinceEpoch, 'data': {'habit': name, 'done': true}}]);
    setState(() => _habitRecs = [
          ..._habitRecs,
          PilotRecord(id: pilotUlid(now), type: 'habit.check', domain: 'life', at: now, title: '打卡 $name', data: {'habit': name, 'done': true}, pending: true),
        ]);
    unawaited(_jump.forward(from: 0));
    _say(tr('$name 打卡 ✓ 连续 ${streak + 1} 天'));
    unawaited(_load());
  }

  // ───────── 发现 (洞察) ─────────

  /// 洞察归哪个房间 (跟服务端 roomOf 同一张表)
  static int _worldOf(PilotInsight i) => _roomIndex(switch (i.domain) {
        'money' => 'money',
        'home' => 'home',
        'social' || 'day' => 'people',
        'work' => 'work',
        'place' => 'place',
        'mood' => 'mind',
        'me' => 'me',
        'cross' => i.id.contains('spend') ? 'money' : 'body',
        _ => 'body',
      });

  PilotInsight? _questFor(int world) => _insights.where((i) => _worldOf(i) == world).firstOrNull;

  int _twinSaid = 0;

  Future<void> _openInsights({String? focus}) async {
    if (_insights.isEmpty) {
      _say(tr('多记几天，我就能看出点门道'));
      return;
    }
    final start = focus == null ? 0 : math.max(0, _insights.indexWhere((i) => i.id == focus));
    final picked = await showModalBottomSheet<(PilotInsight, bool)>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (c) => _InsightDeck(items: _insights, start: start, canTalk: widget.pilot != null),
    );
    if (picked == null) return;
    final (it, act) = picked;
    if (act && it.action != null) {
      await _runAction(it.action!);
    } else {
      await _askPilot(tr('关于「${it.title}」：${it.detail} 你怎么看？给我一个今天就能做的办法，说短一点。'), shown: it.title);
    }
  }

  /// 洞察的一键动作: 提醒在手机上排好 (到点就响, 不靠网); 打卡直接记; 其它交给 Pilot 用它的工具去办
  Future<void> _runAction(Map<String, dynamic> a) async {
    switch (a['kind']) {
      case 'remind':
        final m = RegExp(r'^(\d{1,2}):(\d{2})$').firstMatch('${a['at']}');
        if (m == null) return;
        final now = DateTime.now();
        var at = DateTime(now.year, now.month, now.day, int.parse(m[1]!), int.parse(m[2]!));
        if (!at.isAfter(now)) at = at.add(const Duration(days: 1));
        try {
          await LocalNotifications.scheduleReminder(title: '${a['title']}', at: at);
          HapticFeedback.mediumImpact();
          final dayWord = at.day == now.day ? tr('今天') : tr('明天');
          final timeText = a['at'];
          final remindTitle = a['title'];
          _say(tr('好，$dayWord $timeText 提醒你：$remindTitle'));
        } catch (e) {
          _say(tr('提醒没排上：$e'));
        }
      case 'checkin':
        final h = '${a['habit']}';
        final s = _habitStreaks.where((x) => x.name == h).firstOrNull;
        await _checkIn(h, already: s?.doneToday ?? false, streak: s?.streak ?? 0);
      case 'ask':
        await _askPilot('${a['prompt']}', shown: '${a['label']}');
    }
  }

  /// 点分身时它说的那句: 先说身体这边看出来的事 (每点一下换一条), 没有就拿手上的数说人话
  String _twinLine() {
    final mine = _insights.where((i) => _worldOf(i) == 0).toList();
    if (mine.isNotEmpty) {
      final i = mine[_twinSaid++ % mine.length];
      return i.suggestion == null ? i.title : '${i.title}。${i.suggestion}';
    }
    final parts = <String>[];
    final s = _sleep;
    if (s != null && DateTime.now().difference(s.at).inHours < 30) {
      final m = (s.value ?? 0).round();
      parts.add(m < 360 ? tr('昨晚只睡了 ${_hours(m)}，今天别太累') : tr('昨晚睡了 ${_hours(m)}'));
    }
    if (_weight.length >= 2) {
      final d = _weight.last.value - _weight.first.value;
      final dir = d > 0 ? tr('重了') : tr('轻了');
      parts.add(d.abs() < 0.05 ? tr('体重一个月没变') : tr('一个月$dir ${_num(d.abs())} kg'));
    }
    final today = _todayMood;
    if (today != null && today >= 4) parts.add(tr('心情不错'));
    if (parts.isEmpty) return tr('点我身边的泡泡，记下今天的我');
    return parts.take(2).join('，');
  }

  int? get _todayMood {
    final m = _todayItems.where((r) => r.type == 'mood').toList();
    return m.isEmpty ? null : (m.last.value ?? 3).round();
  }

  Future<void> _pickLook() async {
    final picked = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (c) => _LookPicker(current: _look),
    );
    if (picked == _kFocusEntry) {
      await _pickFocus();
      return;
    }
    final look = picked ?? _look;
    await (await SharedPreferences.getInstance()).setString(_kLook, look);
    if (!mounted) return;
    setState(() => _look = look);
    if (picked != null) _tapTwin();
  }

  // ───────── 快记 (点泡泡) ─────────

  Future<void> _quick(String type, {String? category}) async {
    final rec = switch (type) {
      'health.weight' => await _askNumber(tr('体重'), 'kg', (v) => {'type': type, 'value': v}),
      'finance.expense' => await _askExpense(category),
      'mood' => await _askMood(),
      'health.sleep' => await _askSleep(),
      _ => await _askNote(),
    };
    if (rec != null) await _log(rec);
  }

  Future<Map<String, Object?>?> _askNumber(String title, String unit, Map<String, Object?> Function(double) build) async {
    final v = await _sheet<double>((c) => _NumberSheet(title: title, unit: unit));
    return v == null ? null : build(v);
  }

  Future<Map<String, Object?>?> _askExpense(String? category) async {
    final r = await _sheet<({double amount, String what})>((c) => _ExpenseSheet(initial: category ?? ''));
    if (r == null) return null;
    return {
      'type': 'finance.expense',
      'value': r.amount,
      'data': {'currency': 'CNY', if (r.what.isNotEmpty) 'category': r.what},
    };
  }

  Future<Map<String, Object?>?> _askMood() async {
    final s = await _sheet<int>((c) => const _MoodSheet());
    return s == null ? null : {'type': 'mood', 'data': {'score': s}};
  }

  Future<Map<String, Object?>?> _askSleep() async {
    final r = await _sheet<({DateTime start, DateTime end})>((c) => _SleepSheet(day: _day));
    if (r == null) return null;
    return {'type': 'health.sleep', 'occurred_at': r.start.millisecondsSinceEpoch, 'ended_at': r.end.millisecondsSinceEpoch, 'data': <String, Object?>{}};
  }

  Future<Map<String, Object?>?> _askNote() async {
    final t = await _sheet<String>((c) => const _NoteSheet());
    return t == null || t.trim().isEmpty ? null : {'type': 'note', 'data': {'text': t.trim()}};
  }

  Future<T?> _sheet<T>(WidgetBuilder b) => showModalBottomSheet<T>(
        context: context,
        isScrollControlled: true,
        showDragHandle: true,
        builder: (c) => Padding(padding: EdgeInsets.only(bottom: MediaQuery.of(c).viewInsets.bottom), child: b(c)),
      );

  Future<void> _logMood(int score) async {
    HapticFeedback.selectionClick();
    setState(() => _pickingMood = false);
    await _log({'type': 'mood', 'data': {'score': score}});
  }

  // ───────── 说一句 / 截图 / 自动 ─────────

  Future<void> _onMic() async {
    if (_thinking) return;
    if (widget.pilot == null) {
      _toast(tr('从 Pilot 页进来就能跟它说'));
      return;
    }
    if (_listening) {
      await _finishListening();
      return;
    }
    HapticFeedback.mediumImpact();
    _heard = '';
    setState(() => _listening = true);
    _voice?.dispose();
    try {
      _voice = await startPilotEars(
        ref,
        onText: (t) {
          if (t.trim() == _heard.trim()) return;
          _heard = t;
          _lastHeard = DateTime.now();
          if (mounted) setState(() {});
        },
        onError: (msg) {
          _toast(msg);
          if (mounted) setState(() => _listening = false);
        },
      );
    } catch (_) {
      if (mounted) setState(() => _listening = false);
      return;
    }
    _levelTick?.cancel();
    _levelTick = Timer.periodic(const Duration(milliseconds: 80), (_) {
      final lv = _voice?.levels.isNotEmpty == true ? _voice!.levels.last : 0.0;
      if (mounted && (lv - _level).abs() > 0.02) setState(() => _level = lv);
    });
    _endTimer?.cancel();
    _endTimer = Timer.periodic(const Duration(milliseconds: 200), (t) {
      if (!_listening || _heard.trim().isEmpty) return;
      if (DateTime.now().difference(_lastHeard) < const Duration(milliseconds: 1400)) return;
      t.cancel();
      unawaited(_finishListening());
    });
  }

  Future<void> _finishListening() async {
    _endTimer?.cancel();
    _levelTick?.cancel();
    await _voice?.stop();
    if (!mounted) return;
    setState(() { _listening = false; _level = 0; });
    final text = _heard.trim();
    if (text.isNotEmpty) await _askPilot(text);
  }

  Future<void> _typeIt() async {
    if (widget.pilot == null) return;
    final t = await _sheet<String>((c) => const _NoteSheet(title: '跟它说', hint: '午饭 35，打车 20…'));
    if (t != null && t.trim().isNotEmpty) await _askPilot(t.trim());
  }

  /// [shown]: 气泡里显示的 (发出去的话很长时只显示一个短的)
  Future<void> _askPilot(String text, {String? shown}) async {
    final pilot = widget.pilot;
    if (pilot == null) return;
    setState(() => _thinking = true);
    _say('「${shown ?? text}」', hold: const Duration(minutes: 2));
    final answer = await ref.read(pilotTalkProvider).ask(pilot, text);
    if (!mounted) return;
    setState(() => _thinking = false);
    /* 停留按字数算 (一秒读 6 个字左右, 至少 5 秒); 点气泡就收起 */
    final said = answer.trim().isEmpty ? tr('记好了') : answer.trim();
    _say(said, hold: Duration(milliseconds: 5000 + said.length * 160));
    await _reload();
  }

  Future<void> _screenshot() async {
    final x = await ImagePicker().pickImage(source: ImageSource.gallery, maxWidth: 1600, imageQuality: 85);
    if (x == null || !mounted) return;
    setState(() => _thinking = true);
    _say(tr('我看看…'), hold: const Duration(minutes: 2));
    try {
      final items = await ref.read(autoLedgerProvider.notifier).readScreenshot(await x.readAsBytes());
      if (!mounted) return;
      setState(() => _thinking = false);
      if (items.isEmpty) {
        _say(tr('这张图里没看到账'));
        return;
      }
      _bubbleTimer?.cancel();
      setState(() => _bubble = null);
      final picked = await _sheet<List<({ParsedPayment pay, DateTime at})>>((c) => _ScreenshotSheet(items: items));
      if (picked == null || picked.isEmpty) return;
      await ref.read(autoLedgerProvider.notifier).logScreenshot(picked);
      _say(tr('记了 ${picked.length} 笔'));
    } catch (e) {
      debugPrint('[records] 截图识别失败: $e');
      if (!mounted) return;
      setState(() => _thinking = false);
      _say(tr('没看懂这张，换一张试试'));
    }
  }

  Future<void> _openAuto() async {
    await ref.read(autoLedgerProvider.notifier).refresh();
    if (!mounted) return;
    await showModalBottomSheet<void>(context: context, isScrollControlled: true, showDragHandle: true, builder: (_) => const _AutoSheet());
  }

  Future<void> _openFlow() async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (c) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.62,
        maxChildSize: 0.92,
        builder: (c, scroll) => StatefulBuilder(builder: (c, setSheet) {
          final items = _items ?? const <PilotRecord>[];
          final theme = Theme.of(c);
          final spent = items.where((r) => r.type == 'finance.expense' && (r.unit == null || r.unit == 'CNY')).fold<double>(0, (a, r) => a + (r.value ?? 0));
          /* 流水按天翻: 翻完等这一天拉回来再刷底板 */
          Future<void> go(Future<void> Function() change) async {
            await change();
            if (c.mounted) setSheet(() {});
          }
          return ListView(
            controller: scroll,
            padding: const EdgeInsets.fromLTRB(NeoxSpace.xl, 0, NeoxSpace.xl, NeoxSpace.xxl),
            children: [
              Row(children: [
                _DaySwitch(
                  day: _day,
                  isToday: _isToday,
                  onShift: (n) => go(() async { _shift(n); await _load(); }),
                  onToday: () => go(() async { _backToToday(); await _load(); }),
                ),
                const Spacer(),
                if (spent > 0) Text(tr('花了 ${_yuan(spent)}'), style: theme.textTheme.labelLarge?.copyWith(fontWeight: FontWeight.w700)),
              ]),
              const SizedBox(height: NeoxSpace.sm),
              if (_error != null)
                Text(tr('连不上, 显示的可能不全'), style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
              if (items.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: NeoxSpace.xxl),
                  child: Text(tr('还没有记录'), textAlign: TextAlign.center, style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
                ),
              for (final r in items)
                Dismissible(
                  key: ValueKey(r.id),
                  direction: DismissDirection.endToStart,
                  confirmDismiss: (_) => _delete(r),
                  onDismissed: (_) {
                    setState(() => _items = [...items]..removeWhere((x) => x.id == r.id));
                    setSheet(() {});
                  },
                  background: Container(
                    alignment: Alignment.centerRight,
                    padding: const EdgeInsets.only(right: NeoxSpace.lg),
                    color: theme.colorScheme.errorContainer,
                    child: Icon(Icons.delete_outline, color: theme.colorScheme.onErrorContainer),
                  ),
                  child: _RecordRow(record: r),
                ),
            ],
          );
        }),
      ),
    );
  }

  Future<void> _openDim(LifeDim dim) async {
    final label = _dimLabels[dim]!;
    final rows = (_items ?? const <PilotRecord>[])
        .where((r) => r.type == 'finance.expense' && dimOfExpense(r.data, r.title) == dim)
        .toList();
    /* 这一格还空着: 直接记一笔, 不先弹一张空清单 */
    if (rows.isEmpty) {
      await _quick('finance.expense', category: label.$2);
      return;
    }
    final add = await showModalBottomSheet<bool>(
      context: context,
      showDragHandle: true,
      builder: (c) => SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(NeoxSpace.xl, 0, NeoxSpace.xl, NeoxSpace.lg),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text(label.$1, style: Theme.of(c).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
            const SizedBox(height: NeoxSpace.sm),
            for (final r in rows) _RecordRow(record: r),
            const SizedBox(height: NeoxSpace.md),
            Row(mainAxisAlignment: MainAxisAlignment.end, children: [
              _Pill(label: tr('记一笔'), onTap: () => Navigator.pop(c, true)),
            ]),
          ]),
        ),
      ),
    );
    if (add == true) await _quick('finance.expense', category: label.$2);
  }

  // ───────── 界面 ─────────

  @override
  Widget build(BuildContext context) {
    ref.listen<int>(autoLedgerProvider.select((s) => s.added), (a, b) {
      if (b > (a ?? 0)) {
        _dropCoins();
        unawaited(_reload());
      }
    });
    final auto = ref.watch(autoLedgerProvider);
    final theme = Theme.of(context);
    return Scaffold(
      backgroundColor: theme.colorScheme.surface,
      body: Stack(children: [
        /* 每个场景一层很淡的环境光, 切场景时慢慢换色 —— 不是平涂的底, 陶土台像放在有光的房间里 */
        Positioned.fill(child: _Ambient(world: _world, dark: theme.brightness == Brightness.dark)),
        SafeArea(
        child: Column(children: [
          _header(theme),
          Expanded(
            child: Stack(children: [
              PageView(
                controller: _pager,
                onPageChanged: (i) {
                  HapticFeedback.selectionClick();
                  /* 上一页它说的话不带过来 (正在想的除外) */
                  if (!_thinking) _bubbleTimer?.cancel();
                  setState(() { _world = i; _pickingMood = false; if (!_thinking) _bubble = null; });
                },
                children: [
                  _bodyWorld(theme),
                  _lifeWorld(theme),
                  _homeRoom(theme),
                  _peopleRoom(theme),
                  _workRoom(theme),
                  _tripsWorld(theme),
                  _moodWorld(theme),
                  _meRoom(theme),
                ],
              ),
              /* 它说的话 / 正在想: 贴在底下那排按钮上方 (以前浮在页头下面, 跟房间名、大数挤成一团) */
              Positioned(
                left: NeoxSpace.xl,
                right: NeoxSpace.xl,
                bottom: 6,
                child: GestureDetector(
                  /* 点气泡收起 (正在听 / 正在想时不收) */
                  onTap: _listening || _thinking ? null : () { _bubbleTimer?.cancel(); setState(() => _bubble = null); },
                  child: AnimatedSwitcher(
                    duration: const Duration(milliseconds: 220),
                    transitionBuilder: (c, a) => FadeTransition(opacity: a, child: ScaleTransition(scale: Tween(begin: 0.92, end: 1.0).animate(a), child: c)),
                    child: _listening
                        ? _SpeechBubble(key: const ValueKey('heard'), text: _heard.isEmpty ? '…' : _heard, muted: true)
                        : _bubble == null
                            ? const SizedBox(key: ValueKey('none'), height: 0)
                            : _SpeechBubble(key: ValueKey(_bubble), text: _bubble!, thinking: _thinking),
                  ),
                ),
              ),
              /* 新进来一笔: 金币落下 */
              Positioned.fill(child: IgnorePointer(child: _CoinRain(anim: _coins))),
            ]),
          ),
          _dock(theme, auto),
        ]),
        ),
      ]),
    );
  }

  /// 一行: 返回 · 四个场景 · 它发现的 · 流水。
  /// 哪一天不放这里 —— 只有花销和流水按天看, 身体 / 足迹 / 心情看的是走势 (2026-10-11 体验检查: 顶上「今天」翻到昨天, 身体那页纹丝不动, 像坏了)
  Widget _header(ThemeData theme) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(0, 4, 4, 0),
      child: Row(children: [
        IconButton(icon: const Icon(Icons.arrow_back_ios_new, size: 20), onPressed: () => Navigator.of(context).maybePop()),
        Expanded(child: Center(child: _worldTabs(theme))),
        IconButton(
          tooltip: tr('它发现的'),
          /* 在哪个场景点的, 就先翻到那个场景的那张 */
          onPressed: () => _openInsights(focus: _questFor(_world)?.id),
          icon: Stack(clipBehavior: Clip.none, children: [
            Image.asset(NeoxClay.of('i-bulb'), width: 28, height: 28, filterQuality: FilterQuality.medium),
            /* 一个小点就够: 「7」这种数字像未读消息在催人 */
            if (_insights.any((i) => i.tone == 'watch'))
              Positioned(
                right: 0,
                top: 0,
                child: Container(width: 8, height: 8, decoration: BoxDecoration(color: _toneColor('watch'), shape: BoxShape.circle)),
              ),
          ]),
        ),
        IconButton(
          tooltip: tr('流水'),
          onPressed: _openFlow,
          icon: Image.asset(NeoxClay.of('i-list'), width: 28, height: 28, filterQuality: FilterQuality.medium),
        ),
      ]),
    );
  }

  /// 八个房间放不下一排标签: 页头只放「当前房间」一枚胶囊 (点开是地图) + 下面一排小点 (左右滑)
  Widget _worldTabs(ThemeData theme) {
    final (clay, label) = _worlds[_world];
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: _openMap,
      /* 只放房间名: 下面那排八个点挤在名字和内容之间, 一看就乱 (2026-10-11 用户); 左右滑照样能翻, 点名字出地图 */
      child: AnimatedSwitcher(
        duration: const Duration(milliseconds: 220),
        transitionBuilder: (c, a) => FadeTransition(opacity: a, child: ScaleTransition(scale: Tween(begin: 0.9, end: 1.0).animate(a), child: c)),
        child: Container(
          key: ValueKey(_world),
          padding: const EdgeInsets.fromLTRB(8, 5, 8, 5),
          decoration: BoxDecoration(color: theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.7), borderRadius: NeoxRadius.pillR),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Image.asset(NeoxClay.of(clay), width: 26, height: 26, filterQuality: FilterQuality.medium),
            const SizedBox(width: 6),
            Text(tr(label), style: theme.textTheme.labelLarge?.copyWith(fontWeight: FontWeight.w700)),
            Icon(Icons.expand_more, size: 18, color: theme.colorScheme.onSurfaceVariant),
          ]),
        ),
      ),
    );
  }

  /// 场景骨架: 顶上一个大数, 底下一块陶土台, 泡泡按比例坐标浮在台子周围
  Widget _stage({
    required String art,
    required double artAspect,
    required Widget headline,
    required int world,
    List<_Float> floats = const [],
    Widget Function(Rect tile)? onTile,
    /* 场景本身就是内容 (地图): 铺满宽度, 放在大数下面剩下的空里居中, 不贴底 */
    bool bigTile = false,
  }) {
    /* 任务提示只挂「要留神、而且能一键办」的那件; 「这个月去了 3 个新地方」这种知道一下的不挂 (2026-10-11 用户: 意义在哪)。
     * 身体那页不挂 (会压住人头), 改成分身头上一个「!」 */
    final q = world == 0 ? null : _questFor(world);
    final quest = q != null && q.tone == 'watch' && q.action != null ? q : null;
    return LayoutBuilder(builder: (c, box) {
      final w = box.maxWidth, h = box.maxHeight;
      final tw = bigTile ? math.min(w * 1.02, 520.0) : math.min(w * 0.92, 440.0);
      final th = tw / artAspect;
      final top = h * (quest == null ? 0.26 : 0.32);
      final tile = bigTile
          ? Rect.fromLTWH((w - tw) / 2, math.max(top, top + (h - top - th) / 2), tw, th)
          : Rect.fromLTWH((w - tw) / 2, h - th - h * 0.03, tw, th);
      return Stack(clipBehavior: Clip.none, children: [
        Positioned(
          left: NeoxSpace.xl,
          right: NeoxSpace.xl,
          top: h * 0.09,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            headline,
            /* 这个场景里它看出来最要紧的一件事: 像游戏里的任务提示, 点开是整副卡 */
            if (quest != null) ...[
              const SizedBox(height: 10),
              _QuestPill(insight: quest, onTap: () => _openInsights(focus: quest.id)),
            ],
            /* 这个房间的几个数: 排成一行放在大数下面, 不再东一个西一个浮在场景四周
             * (2026-10-11 用户: 「搞几个这样悬浮的弹窗, 我不知道什么意义」) */
            if (floats.isNotEmpty) ...[
              const SizedBox(height: 12),
              Wrap(alignment: WrapAlignment.center, spacing: 8, runSpacing: 8, children: [for (final f in floats.take(3)) f.child]),
            ],
          ]),
        ),
        /* art 为空 = 场景由 onTile 自己按数据拼 (钱 / 足迹) */
        if (art.isNotEmpty) Positioned.fromRect(rect: tile, child: Image.asset(art, fit: BoxFit.contain, filterQuality: FilterQuality.medium)),
        if (onTile != null) onTile(tile),
      ]);
    });
  }

  Widget _bigNumber(ThemeData theme, String value, {String? sub, VoidCallback? onTap}) => GestureDetector(
        onTap: onTap,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Text(value, style: theme.textTheme.displaySmall?.copyWith(fontWeight: FontWeight.w800, letterSpacing: -1)),
          if (sub != null) Text(sub, style: theme.textTheme.labelMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
        ]),
      );

  // 身体: 分身站在台上
  Widget _bodyWorld(ThemeData theme) {
    final w = _weight.isEmpty ? null : _weight.last.value;
    final sleep = _sleep;
    /* 大数 = 体重, 下面一句离目标还差多少 (目标来自档案 goal.weight, 服务端 scene 带回来) */
    final scene = _room('body')['scene'] is Map ? Map<String, dynamic>.from(_room('body')['scene'] as Map) : const <String, dynamic>{};
    final goal = (scene['goal'] as num?)?.toDouble();
    final start = (scene['start'] as num?)?.toDouble();
    String? sub;
    if (w != null && goal != null) {
      final left = w - goal;
      final trendDir = start != null && start > w ? tr('轻了') : tr('重了');
      final trend = start != null && (start - w).abs() >= 0.2 ? tr(' · 三个月$trendDir ${_num((start - w).abs())} kg') : '';
      sub = left.abs() < 0.2
          ? tr('到目标 ${_num(goal)} kg 了')
          : '${tr('离目标 ${_num(goal)} kg 还差 ${_num(left.abs())}')}$trend';
    }
    return _stage(
      art: _worldArt('body'),
      world: 0,
      artAspect: 900 / 588,
      headline: _bigNumber(theme, w == null ? '—' : '${_num(w)} kg', sub: sub ?? (w == null ? tr('点这里记今天的体重') : null), onTap: () => _quick('health.weight')),
      floats: [
        _Float(const Offset(0.83, 0.26), _Orb(
          clay: 'i-moon',
          value: sleep == null ? '睡眠' : _hours((sleep.value ?? 0).round()),
          ghost: sleep == null,
          onTap: () => _quick('health.sleep'),
        )),
        /* 打卡: 只挂最近打的那一个 —— 一页最多三个泡泡, 多了就乱 (2026-10-11 「乍一看挺乱」) */
        for (final h in _habitStreaks.take(1))
          _Float(const Offset(0.82, 0.55), _Orb(
            clay: 'i-sneaker',
            /* 「跑步 0 天」像在数落人: 断了就只写名字, 等着点 */
            value: h.doneToday ? '${h.name} ✓ ${h.streak} 天' : h.streak > 0 ? '${h.name} ${h.streak} 天' : h.name,
            ghost: !h.doneToday,
            onTap: () => _checkIn(h.name, already: h.doneToday, streak: h.streak),
          )),
        if (_habitStreaks.isEmpty)
          _Float(const Offset(0.82, 0.55), _Orb(clay: 'i-sneaker', value: '打卡', ghost: true, onTap: () => _checkIn(null))),
      ],
      onTile: (tile) {
        /* 人比台子高一些就够, 头顶留出大数和那一行数的位置 */
        final ph = math.min(tile.height * 1.7, tile.top + tile.height * 0.58 - 200);
        return Positioned(
          left: tile.center.dx - ph * 0.25,
          width: ph * 0.5,
          top: tile.top + tile.height * 0.58 - ph,
          height: ph,
          child: GestureDetector(
            onTap: _tapTwin,
            onLongPress: _pickLook,
            child: AnimatedBuilder(
              animation: Listenable.merge([_float, _jump]),
              builder: (c, child) {
                final j = _jump.value;
                final up = math.sin(j * math.pi) * 34;
                /* 起跳前一压、落地一压 */
                final squash = j < 0.12 ? j / 0.12 : (j > 0.88 ? (1 - j) / 0.12 : 0.0);
                final breathe = math.sin(_float.value * 2 * math.pi * 2) * 0.012;
                return Transform.translate(
                  offset: Offset(0, -up),
                  child: Transform(
                    alignment: Alignment.bottomCenter,
                    transform: Matrix4.diagonal3Values(1 + squash * 0.06, 1 - squash * 0.08 + breathe, 1),
                    child: child,
                  ),
                );
              },
              child: Stack(clipBehavior: Clip.none, alignment: Alignment.topCenter, children: [
                Positioned.fill(
                  child: AnimatedSwitcher(
                    duration: const Duration(milliseconds: 300),
                    child: Image.asset(_twinArt(_look), key: ValueKey(_look), fit: BoxFit.contain, alignment: Alignment.bottomCenter, filterQuality: FilterQuality.medium),
                  ),
                ),
                if (_questFor(0) != null)
                  Positioned(
                    top: -30,
                    child: AnimatedBuilder(
                      animation: _float,
                      builder: (c, child) => Transform.translate(offset: Offset(0, math.sin(_float.value * 2 * math.pi * 3) * 3), child: child),
                      child: _Bang(color: _toneColor(_questFor(0)!.tone)),
                    ),
                  ),
              ]),
            ),
          ),
        );
      },
    );
  }

  // 钱: 今天花了多少 (按天翻) + 净资产; 花销按衣食住行挂在存钱罐周围
  Widget _lifeWorld(ThemeData theme) {
    final sums = <LifeDim, double>{};
    var total = 0.0;
    for (final r in _items ?? const <PilotRecord>[]) {
      if (r.type != 'finance.expense' || (r.unit != null && r.unit != 'CNY')) continue;
      final d = dimOfExpense(r.data, r.title);
      sums[d] = (sums[d] ?? 0) + (r.value ?? 0);
      total += r.value ?? 0;
    }
    /* 只挂花了钱的前三格 (按金额); 没花的不摆空泡泡 */
    /* 场景下半截是柱子和存钱罐, 今天的分类只挂前两格, 放在场景上沿 */
    final top = (sums.entries.toList()..sort((a, b) => b.value.compareTo(a.value))).take(2).toList();
    const spots = [Offset(0.5, 0.47)];
    final money = _room('money');
    final nw = (money['netWorth'] as num?)?.toDouble();
    return _stage(
      art: '',
      world: 1,
      artAspect: 900 / 780,
      onTile: (tile) => Positioned.fromRect(
        rect: tile,
        child: _MoneyScene(scene: money['scene'] is Map ? Map<String, dynamic>.from(money['scene'] as Map) : const {}, onSay: _say),
      ),
      headline: Column(mainAxisSize: MainAxisSize.min, children: [
        /* 只有花销按天看: 哪一天放在这里, 不放页头 */
        _DaySwitch(day: _day, isToday: _isToday, onShift: _shift, onToday: _backToToday),
        TweenAnimationBuilder<double>(
          tween: Tween(end: total),
          duration: const Duration(milliseconds: 700),
          curve: Curves.easeOutCubic,
          builder: (c, v, _) => _bigNumber(theme, _yuan(v), sub: _spent7 == null ? null : tr('近 7 天 ${_yuan(_spent7!)}')),
        ),
      ]),
      floats: [
        /* 今天花在哪: 只挂最多的那一格 (柱子已经说了月度, 泡泡多了就乱) */
        for (final (i, e) in top.take(1).indexed)
          _Float(spots[i], _Orb(letter: _dimLabels[e.key]!.$1, value: _yuan(e.value), onTap: () => _openDim(e.key))),
        if (nw != null) _Float(const Offset(0.18, 0.38), _Orb(clay: 'i-gem', value: '净资产 ${_yuanShort(nw)}', onTap: _openAssets)),
      ],
    );
  }

  // 足迹: 去过的地方插在岛上
  Widget _tripsWorld(ThemeData theme) {
    final names = <String>[];
    for (final p in _places) {
      final n = '${p.data['name'] ?? p.title}'.replaceFirst(RegExp(r'^在\s*'), '').trim();
      if (n.isNotEmpty && !names.contains(n)) names.add(n);
    }
    const spots = [Offset(0.2, 0.32), Offset(0.8, 0.30), Offset(0.24, 0.56), Offset(0.78, 0.55)];
    /* 有坐标的地方就画成地图 (按真坐标落点、按时间连线); 一个都没有才用老的那张图 */
    final place = _room('place');
    final scene = place['scene'] is Map ? Map<String, dynamic>.from(place['scene'] as Map) : const <String, dynamic>{};
    final pins = (scene['pins'] as List? ?? const []).length;
    if (pins > 0) {
      /* 此刻在哪并进大数下面那行 (单独浮一个「在家 · 13 分钟」泡泡, 看不出是干嘛的); 点地图上的家 = 设置它看着的 */
      final now = Platform.isAndroid ? _senseLine() : null;
      return _stage(
        art: '',
        world: 5,
        artAspect: 1000 / 620,
        bigTile: true,
        onTile: (tile) => Positioned.fromRect(rect: tile, child: _MapScene(scene: scene, onSay: _say, onHome: Platform.isAndroid ? _openSense : null)),
        headline: _bigNumber(theme, '$pins', sub: now == null ? tr('个地方 · 一年') : tr('个地方 · 一年 · $now'), onTap: Platform.isAndroid ? _openSense : null),
      );
    }
    return _stage(
      art: _worldArt('trips'),
      world: 5,
      artAspect: 900 / 700,
      headline: _bigNumber(theme, names.isEmpty ? '0' : '${names.length}', sub: tr('个地方 · 近 3 个月')),
      floats: [
        /* 点地点说真数: 哪天去的、近 3 个月几次 (以前是一句「记得那天吗」, 什么都没告诉你) */
        for (final (i, n) in names.take(4).indexed)
          _Float(spots[i], _Orb(clay: 'i-route', value: n, onTap: () {
            final visits = _places.where((p) => '${p.data['name'] ?? p.title}'.replaceFirst(RegExp(r'^在\s*'), '').trim() == n).toList();
            final last = visits.first.at;
            final more = visits.length > 1 ? tr('，近 3 个月去了 ${visits.length} 次') : '';
            _say(tr('$n · 上次 ${last.month}月${last.day}日$more'));
          })),
        if (names.isEmpty)
          _Float(spots[0], _Orb(clay: 'i-route', value: '去过哪儿', ghost: true, onTap: () => _say(tr('按下面的圆钮跟我说「今天去了西湖」')))),
        if (Platform.isAndroid) _senseFloat(),
      ],
    );
  }

  // 心情: 今天的脸 + 一周
  Widget _moodWorld(ThemeData theme) {
    final today = _todayMood;
    final now = DateTime.now();
    final byDay = {for (final p in _mood7) DateTime(p.day.year, p.day.month, p.day.day): p.value};
    const wk = ['一', '二', '三', '四', '五', '六', '日'];
    final notes = _todayItems.where((r) => r.type == 'note').toList();
    final lastNote = notes.isEmpty ? null : '${notes.last.data['text'] ?? notes.last.title}';
    return _stage(
      art: _worldArt('mood'),
      world: 6,
      artAspect: 900 / 725,
      /* 今天的一句话 (随手记) 挂在大树边上 */
      floats: [
        _Float(const Offset(0.78, 0.56), _Orb(
          clay: 'i-chat',
          value: lastNote == null ? '写一句' : (lastNote.length > 8 ? '${lastNote.substring(0, 8)}…' : lastNote),
          ghost: lastNote == null,
          onTap: () => _quick('note'),
        )),
      ],
      headline: Column(mainAxisSize: MainAxisSize.min, children: [
       GestureDetector(
        onTap: () { HapticFeedback.selectionClick(); setState(() => _pickingMood = !_pickingMood); },
        child: AnimatedSwitcher(
          duration: const Duration(milliseconds: 260),
          transitionBuilder: (c, a) => ScaleTransition(scale: a, child: c),
          child: _pickingMood
              ? Row(key: const ValueKey('pick'), mainAxisSize: MainAxisSize.min, children: [
                  for (var i = 1; i <= 5; i++)
                    TweenAnimationBuilder<double>(
                      tween: Tween(begin: 0, end: 1),
                      duration: Duration(milliseconds: 220 + i * 60),
                      curve: Curves.easeOutBack,
                      builder: (c, v, child) => Transform.scale(scale: v, child: child),
                      child: GestureDetector(
                        onTap: () => _logMood(i),
                        child: Padding(padding: const EdgeInsets.symmetric(horizontal: 6), child: Text(_moodFace(i), style: const TextStyle(fontSize: 40))),
                      ),
                    ),
                ])
              : Column(key: const ValueKey('face'), mainAxisSize: MainAxisSize.min, children: [
                  Text(today == null ? '🫥' : _moodFace(today), style: const TextStyle(fontSize: 56)),
                  if (today == null) Text(tr('点一下'), style: theme.textTheme.labelMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
                ]),
        ),
       ),
        /* 这一周的脸跟着今天那张脸走 (以前压在台子上沿, 跟「写一句」撞在一起) */
        const SizedBox(height: 8),
        Row(mainAxisSize: MainAxisSize.min, children: [
          for (var i = 6; i >= 0; i--)
            Builder(builder: (c) {
              final d = DateTime(now.year, now.month, now.day - i);
              final v = byDay[d];
              return SizedBox(
                width: 34,
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  SizedBox(
                    height: 24,
                    child: Center(child: Text(v == null ? '·' : _moodFace(v.round()), style: TextStyle(fontSize: v == null ? 16 : 18, color: theme.colorScheme.onSurfaceVariant))),
                  ),
                  Text(i == 0 ? tr('今') : wk[d.weekday - 1], style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onSurfaceVariant, fontWeight: i == 0 ? FontWeight.w700 : null)),
                ]),
              );
            }),
        ]),
      ]),
    );
  }

  Widget _dock(ThemeData theme, AutoLedgerState auto) => Padding(
        padding: const EdgeInsets.fromLTRB(NeoxSpace.xl, 4, NeoxSpace.xl, NeoxSpace.md),
        child: Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, crossAxisAlignment: CrossAxisAlignment.end, children: [
          _DockButton(clay: 'i-photo', label: tr('截图记'), onTap: _thinking ? null : _screenshot),
          /* 三个钮底下都有两三个字, 中间这个也要有 —— 不然一排里只有它不说自己是干嘛的 */
          Column(mainAxisSize: MainAxisSize.min, children: [
            if (widget.pilot != null)
              _MicButton(listening: _listening, thinking: _thinking, level: _level, onTap: _onMic, onLongPress: _typeIt)
            else
              _MicButton(listening: false, thinking: false, level: 0, onTap: _typeIt, onLongPress: null),
            Text(
              _listening ? tr('说完点一下') : tr('说一句'),
              style: theme.textTheme.labelSmall?.copyWith(color: _listening ? NeoxBrand.blue : theme.colorScheme.onSurfaceVariant),
            ),
          ]),
          _DockButton(clay: 'i-autoreceipt', label: tr('自动记账'), dot: auto.working, onTap: _openAuto),
        ]),
      );
}

/// 场景的环境光: 两团很淡的径向光 (一暖一冷), 切场景时颜色插值过渡。
/// 参考 Today 的「氛围底」, 但不用毛玻璃 —— 我们的主角是陶土台, 光只负责把它托起来。
class _Ambient extends StatelessWidget {
  const _Ambient({required this.world, required this.dark});
  final int world;
  final bool dark;

  /* (左上那团, 右下那团) */
  static const _palette = [
    (Color(0xFFFFE3CC), Color(0xFFDCE7FF)), // 身体: 暖桃 + 一点蓝
    (Color(0xFFFFECCF), Color(0xFFE6F0DA)), // 钱: 暖沙 + 一点绿
    (Color(0xFFFFE8D6), Color(0xFFF3E6D8)), // 家: 暖杏
    (Color(0xFFFFE0E6), Color(0xFFFFEFD6)), // 人: 粉 + 暖黄
    (Color(0xFFDCE7FF), Color(0xFFEDEAE4)), // 工作学习: 冷蓝 + 纸色
    (Color(0xFFD6E8FF), Color(0xFFDDF3E6)), // 足迹: 天蓝 + 薄荷
    (Color(0xFFEDE1FF), Color(0xFFFFE0E6)), // 心: 淡紫 + 粉
    (Color(0xFFF1E9DD), Color(0xFFE3E0F5)), // 我: 书页米 + 淡紫
  ];

  @override
  Widget build(BuildContext context) {
    final (a, b) = _palette[world.clamp(0, _palette.length - 1)];
    final k = dark ? 0.10 : 0.85;
    return Stack(children: [
      AnimatedContainer(
        duration: const Duration(milliseconds: 700),
        curve: Curves.easeOutCubic,
        decoration: BoxDecoration(
          gradient: RadialGradient(center: const Alignment(-0.9, -0.85), radius: 1.1, colors: [a.withValues(alpha: k), a.withValues(alpha: 0)]),
        ),
      ),
      AnimatedContainer(
        duration: const Duration(milliseconds: 700),
        curve: Curves.easeOutCubic,
        decoration: BoxDecoration(
          gradient: RadialGradient(center: const Alignment(1.0, 0.75), radius: 1.0, colors: [b.withValues(alpha: k * 0.8), b.withValues(alpha: 0)]),
        ),
      ),
    ]);
  }
}

/// 小小的「‹ 今天 ›」: 只出现在按天看的地方 (花销、流水)
class _DaySwitch extends StatelessWidget {
  const _DaySwitch({required this.day, required this.isToday, required this.onShift, required this.onToday});
  final DateTime day;
  final bool isToday;
  final void Function(int) onShift;
  final VoidCallback onToday;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mute = theme.colorScheme.onSurfaceVariant;
    Widget arrow(IconData icon, VoidCallback? onTap) => InkResponse(
          onTap: onTap,
          radius: 18,
          child: Padding(padding: const EdgeInsets.all(4), child: Icon(icon, size: 18, color: onTap == null ? mute.withValues(alpha: 0.25) : mute)),
        );
    return Row(mainAxisSize: MainAxisSize.min, children: [
      arrow(Icons.chevron_left, () => onShift(-1)),
      GestureDetector(
        onTap: isToday ? null : onToday,
        child: AnimatedSwitcher(
          duration: const Duration(milliseconds: 160),
          child: Text(
            isToday ? tr('今天') : '${day.month}月${day.day}日',
            key: ValueKey('${day.month}-${day.day}'),
            style: theme.textTheme.labelLarge?.copyWith(color: mute, fontWeight: FontWeight.w600),
          ),
        ),
      ),
      arrow(Icons.chevron_right, isToday ? null : () => onShift(1)),
    ]);
  }
}

/// 洞察的口气色: 留神 = 暖橙, 不错 = 品牌蓝, 知道一下 = 灰
Color _toneColor(String tone) => switch (tone) {
      'watch' => const Color(0xFFE8963A),
      'good' => NeoxBrand.blue,
      _ => const Color(0xFF9A948C),
    };

/// 分身头上的「!」: 有事想跟你说
class _Bang extends StatelessWidget {
  const _Bang({required this.color});
  final Color color;
  @override
  Widget build(BuildContext context) => Container(
        width: 26,
        height: 26,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: Colors.white,
          shape: BoxShape.circle,
          border: Border.all(color: color, width: 2),
          boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.1), blurRadius: 8, offset: const Offset(0, 3))],
        ),
        child: Text('!', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w900, color: color, height: 1)),
      );
}

/// 场景顶上的任务提示: 口气色点 + 一句标题 + 小箭头
class _QuestPill extends StatelessWidget {
  const _QuestPill({required this.insight, required this.onTap});
  final PilotInsight insight;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dark = theme.brightness == Brightness.dark;
    return GestureDetector(
      onTap: () { HapticFeedback.selectionClick(); onTap(); },
      child: Container(
        padding: const EdgeInsets.fromLTRB(12, 7, 8, 7),
        /* 没有描边: 一圈彩色边框像报错条 (2026-10-11 用户: 边框非常丑); 浅底 + 一颗色点就够 */
        decoration: BoxDecoration(
          color: dark ? const Color(0xFF2A2826) : Colors.white.withValues(alpha: 0.85),
          borderRadius: NeoxRadius.pillR,
          boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.05), blurRadius: 10, offset: const Offset(0, 3))],
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Container(width: 8, height: 8, decoration: BoxDecoration(color: _toneColor(insight.tone), shape: BoxShape.circle)),
          const SizedBox(width: 8),
          Flexible(child: Text(insight.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.labelLarge?.copyWith(fontWeight: FontWeight.w600))),
          Icon(Icons.chevron_right, size: 18, color: theme.colorScheme.onSurfaceVariant),
        ]),
      ),
    );
  }
}

/// 它发现的: 一副卡, 左右翻; 每张一件事 + 一件能做的事; 「跟它聊」把这件事交给 Pilot
class _InsightDeck extends StatefulWidget {
  const _InsightDeck({required this.items, required this.start, required this.canTalk});
  final List<PilotInsight> items;
  final int start;
  final bool canTalk;
  @override
  State<_InsightDeck> createState() => _InsightDeckState();
}

class _InsightDeckState extends State<_InsightDeck> {
  late final PageController _pc = PageController(initialPage: widget.start, viewportFraction: 0.86);
  late int _at = widget.start;

  @override
  void dispose() {
    _pc.dispose();
    super.dispose();
  }

  static const _domainArt = {
    'money': 'i-receipt',
    'body': 'i-pulse',
    'mood': 'i-sun',
    'social': 'i-person',
    'habit': 'i-badge',
    'place': 'i-route',
    'cross': 'i-gem',
  };

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dark = theme.brightness == Brightness.dark;
    return SafeArea(
      top: false,
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        SizedBox(
          height: 340,
          child: PageView.builder(
            controller: _pc,
            itemCount: widget.items.length,
            onPageChanged: (i) { HapticFeedback.selectionClick(); setState(() => _at = i); },
            itemBuilder: (c, i) {
              final it = widget.items[i];
              return AnimatedBuilder(
                animation: _pc,
                builder: (c, child) {
                  final page = _pc.hasClients && _pc.position.haveDimensions ? _pc.page! : widget.start.toDouble();
                  final d = (page - i).abs().clamp(0.0, 1.0);
                  return Transform.scale(scale: 1 - d * 0.08, child: Opacity(opacity: 1 - d * 0.4, child: child));
                },
                child: Container(
                  margin: const EdgeInsets.symmetric(horizontal: 6, vertical: 8),
                  padding: const EdgeInsets.fromLTRB(20, 18, 20, 16),
                  decoration: BoxDecoration(
                    color: dark ? const Color(0xFF2A2826) : Colors.white,
                    borderRadius: BorderRadius.circular(24),
                    border: Border.all(color: _toneColor(it.tone).withValues(alpha: 0.3)),
                    boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.07), blurRadius: 20, offset: const Offset(0, 8))],
                  ),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      Image.asset(NeoxClay.of(_domainArt[it.domain] ?? 'i-gem'), width: 34, height: 34, filterQuality: FilterQuality.medium),
                      const Spacer(),
                      Container(width: 10, height: 10, decoration: BoxDecoration(color: _toneColor(it.tone), shape: BoxShape.circle)),
                    ]),
                    const SizedBox(height: 14),
                    Text(it.title, style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800, letterSpacing: -0.3)),
                    const SizedBox(height: 8),
                    /* 说明占剩下的地方, 放不下就省略 —— 建议和按钮永远露出来 */
                    Expanded(
                      child: Text(it.detail, overflow: TextOverflow.fade, style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant, height: 1.45)),
                    ),
                    if (it.suggestion != null)
                      Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        const Text('👉 ', style: TextStyle(fontSize: 14)),
                        Expanded(child: Text(it.suggestion!, maxLines: 2, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600))),
                      ]),
                    const SizedBox(height: 12),
                    /* 主钮是「一键就办」(定提醒 / 打卡 / 交给它办); 「跟它聊」退成旁边的字 */
                    Row(children: [
                      if (widget.canTalk && it.action != null)
                        TextButton(onPressed: () => Navigator.pop(context, (it, false)), child: Text(tr('跟它聊'))),
                      const Spacer(),
                      if (it.action != null && (widget.canTalk || it.action!['kind'] != 'ask'))
                        _Pill(label: '${it.action!['label']}', onTap: () => Navigator.pop(context, (it, true)))
                      else if (widget.canTalk)
                        _Pill(label: tr('跟它聊'), onTap: () => Navigator.pop(context, (it, false))),
                    ]),
                  ]),
                ),
              );
            },
          ),
        ),
        Padding(
          padding: const EdgeInsets.only(top: 4, bottom: NeoxSpace.md),
          /* 超过 10 张: 一排点数不清, 写「3 / 26」 */
          child: widget.items.length > 10
              ? Text('${_at + 1} / ${widget.items.length}', textAlign: TextAlign.center, style: theme.textTheme.labelMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant))
              : Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            for (var i = 0; i < widget.items.length; i++)
              AnimatedContainer(
                duration: const Duration(milliseconds: 200),
                margin: const EdgeInsets.symmetric(horizontal: 3),
                width: i == _at ? 16 : 6,
                height: 6,
                decoration: BoxDecoration(
                  color: i == _at ? _toneColor(widget.items[i].tone) : theme.colorScheme.onSurfaceVariant.withValues(alpha: 0.3),
                  borderRadius: NeoxRadius.pillR,
                ),
              ),
          ]),
        ),
      ]),
    );
  }
}

/// 房间的一个数 (排在大数下面那一行; at 是以前浮在场景里的坐标, 现在不用了, 留着好比排序)
class _Float {
  const _Float(this.at, this.child);
  final Offset at;
  final Widget child;
}

/// 泡泡: 白底圆胖胶囊, 陶土小图 / 一个字 / 表情 + 值; 没数时是半透明的「空位」
class _Orb extends StatefulWidget {
  const _Orb({this.clay, this.letter, required this.value, this.ghost = false, required this.onTap});
  final String? clay;
  final String? letter;
  final String value;
  final bool ghost;
  final VoidCallback onTap;

  @override
  State<_Orb> createState() => _OrbState();
}

class _OrbState extends State<_Orb> {
  bool _down = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dark = theme.brightness == Brightness.dark;
    Widget lead;
    if (widget.letter != null) {
      lead = Container(
        height: 26,
        constraints: const BoxConstraints(minWidth: 26),
        padding: const EdgeInsets.symmetric(horizontal: 6),
        alignment: Alignment.center,
        decoration: BoxDecoration(color: theme.colorScheme.surfaceContainerHighest, borderRadius: NeoxRadius.pillR),
        child: Text(widget.letter!, style: theme.textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w700)),
      );
    } else {
      lead = Image.asset(NeoxClay.of(widget.clay!), width: 24, height: 24, filterQuality: FilterQuality.medium);
    }
    return GestureDetector(
      onTapDown: (_) => setState(() => _down = true),
      onTapCancel: () => setState(() => _down = false),
      onTapUp: (_) => setState(() => _down = false),
      onTap: () { HapticFeedback.selectionClick(); widget.onTap(); },
      child: AnimatedScale(
        scale: _down ? 0.9 : 1,
        duration: const Duration(milliseconds: 120),
        child: AnimatedOpacity(
          opacity: widget.ghost ? 0.62 : 1,
          duration: const Duration(milliseconds: 200),
          child: Container(
            constraints: const BoxConstraints(maxWidth: 200),
            padding: EdgeInsets.fromLTRB(6, 5, widget.value.isEmpty ? 8 : 12, 5),
            decoration: BoxDecoration(
              color: dark ? const Color(0xFF2A2826) : Colors.white,
              borderRadius: NeoxRadius.pillR,
              boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: dark ? 0.3 : 0.08), blurRadius: 14, offset: const Offset(0, 5))],
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              lead,
              /* 空格子 (「住」还没花过) 带个 + : 一眼知道是点了能记的, 不是装饰字 */
              if (widget.value.isEmpty && widget.ghost)
                Padding(padding: const EdgeInsets.only(left: 4), child: Icon(Icons.add_rounded, size: 16, color: theme.colorScheme.onSurfaceVariant)),
              if (widget.value.isNotEmpty) ...[
                const SizedBox(width: 6),
                Flexible(
                  child: Text(
                    tr(widget.value),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.labelLarge?.copyWith(
                      fontWeight: widget.ghost ? FontWeight.w500 : FontWeight.w700,
                      color: widget.ghost ? theme.colorScheme.onSurfaceVariant : null,
                    ),
                  ),
                ),
              ],
            ]),
          ),
        ),
      ),
    );
  }
}

class _SpeechBubble extends StatelessWidget {
  const _SpeechBubble({super.key, required this.text, this.thinking = false, this.muted = false});
  final String text;
  final bool thinking;
  final bool muted;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dark = theme.brightness == Brightness.dark;
    return Center(
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        decoration: BoxDecoration(
          color: dark ? const Color(0xFF2A2826) : Colors.white,
          borderRadius: BorderRadius.circular(18),
          boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.07), blurRadius: 16, offset: const Offset(0, 6))],
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Flexible(
            child: Text(
              text,
              /* 它的建议常有两三句: 长的左对齐、多给几行 */
              maxLines: 9,
              overflow: TextOverflow.ellipsis,
              textAlign: text.length > 40 ? TextAlign.start : TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(color: muted ? theme.colorScheme.onSurfaceVariant : null, height: 1.4),
            ),
          ),
          if (thinking) ...[const SizedBox(width: 8), const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))],
        ]),
      ),
    );
  }
}

class _DockButton extends StatelessWidget {
  const _DockButton({required this.clay, required this.label, required this.onTap, this.dot = false});
  final String clay;
  final String label;
  final VoidCallback? onTap;
  final bool dot;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return GestureDetector(
      onTap: onTap,
      child: Opacity(
        opacity: onTap == null ? 0.4 : 1,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Stack(clipBehavior: Clip.none, children: [
            Container(
              width: 52,
              height: 52,
              alignment: Alignment.center,
              decoration: BoxDecoration(color: theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.6), shape: BoxShape.circle),
              child: Image.asset(NeoxClay.of(clay), width: 30, height: 30, filterQuality: FilterQuality.medium),
            ),
            if (dot)
              const Positioned(
                right: 2,
                top: 2,
                child: DecoratedBox(decoration: BoxDecoration(color: NeoxBrand.blue, shape: BoxShape.circle), child: SizedBox(width: 10, height: 10)),
              ),
          ]),
          const SizedBox(height: 4),
          Text(label, style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
        ]),
      ),
    );
  }
}

/// 说一句: 暖白陶土大圆 + 话筒; 听的时候外圈随音量涨, 想的时候转圈
class _MicButton extends StatelessWidget {
  const _MicButton({required this.listening, required this.thinking, required this.level, required this.onTap, required this.onLongPress});
  final bool listening;
  final bool thinking;
  final double level;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dark = theme.brightness == Brightness.dark;
    final ring = listening ? 8 + level.clamp(0, 1) * 18 : 0.0;
    return GestureDetector(
      onTap: onTap,
      onLongPress: onLongPress,
      child: SizedBox(
        width: 104,
        height: 86,
        child: Stack(alignment: Alignment.center, children: [
          AnimatedContainer(
            duration: const Duration(milliseconds: 90),
            width: 76 + ring * 2,
            height: 76 + ring * 2,
            decoration: BoxDecoration(color: NeoxBrand.blue.withValues(alpha: listening ? 0.14 : 0), shape: BoxShape.circle),
          ),
          AnimatedScale(
            scale: listening ? 1.06 : 1,
            duration: const Duration(milliseconds: 200),
            child: Container(
              width: 76,
              height: 76,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: dark ? const Color(0xFF2E2B28) : const Color(0xFFFBF9F6),
                shape: BoxShape.circle,
                border: Border.all(color: listening ? NeoxBrand.blue : Colors.black.withValues(alpha: 0.05), width: listening ? 2 : 1),
                boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: dark ? 0.35 : 0.10), blurRadius: 18, offset: const Offset(0, 8))],
              ),
              child: thinking
                  ? const SizedBox(width: 26, height: 26, child: CircularProgressIndicator(strokeWidth: 2.4))
                  : Image.asset(NeoxClay.of('i-mic'), width: 40, height: 40, filterQuality: FilterQuality.medium),
            ),
          ),
        ]),
      ),
    );
  }
}

/// 记了一笔花销: 一把金币从上面掉下来
class _CoinRain extends StatelessWidget {
  const _CoinRain({required this.anim});
  final Animation<double> anim;

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
        animation: anim,
        builder: (c, _) {
          final t = anim.value;
          if (t == 0 || t == 1) return const SizedBox.shrink();
          return LayoutBuilder(builder: (c, box) {
            return Stack(children: [
              for (var i = 0; i < 7; i++)
                Builder(builder: (c) {
                  final start = i * 0.07;
                  final p = ((t - start) / 0.6).clamp(0.0, 1.0);
                  if (p == 0) return const SizedBox.shrink();
                  final x = box.maxWidth * (0.3 + 0.4 * ((i * 37) % 10) / 10);
                  /* 掉下来再弹一下 */
                  final y = box.maxHeight * 0.62 * Curves.bounceOut.transform(p);
                  return Positioned(
                    left: x,
                    top: y,
                    child: Opacity(
                      opacity: t > 0.85 ? ((1 - t) / 0.15).clamp(0, 1) : 1,
                      child: Transform.rotate(angle: p * (i.isEven ? 3 : -3), child: const _Coin()),
                    ),
                  );
                }),
            ]);
          });
        },
      );
}

class _Coin extends StatelessWidget {
  const _Coin();
  @override
  Widget build(BuildContext context) => Container(
        width: 22,
        height: 22,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: const Color(0xFFEDE7DE),
          shape: BoxShape.circle,
          border: Border.all(color: const Color(0xFFD9D0C3), width: 2),
          boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.12), blurRadius: 4, offset: const Offset(0, 2))],
        ),
        child: const Text('¥', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w800, color: Color(0xFF8C8275), height: 1)),
      );
}

class _Pill extends StatelessWidget {
  const _Pill({required this.label, required this.onTap, this.enabled = true});
  final String label;
  final VoidCallback onTap;
  final bool enabled;

  @override
  Widget build(BuildContext context) => Opacity(
        opacity: enabled ? 1 : 0.4,
        child: GestureDetector(
          onTap: enabled ? onTap : null,
          child: Container(
            height: 40,
            padding: const EdgeInsets.symmetric(horizontal: 26, vertical: 10),
            decoration: NeoxBrand.clayBlue(NeoxRadius.pillR),
            child: Text(label, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600, height: 1.2)),
          ),
        ),
      );
}

/// 挑一个像自己的分身
class _LookPicker extends StatelessWidget {
  const _LookPicker({required this.current});
  final String current;

  @override
  Widget build(BuildContext context) => SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(NeoxSpace.lg, 0, NeoxSpace.lg, NeoxSpace.lg),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Row(children: [
              const SizedBox(width: 64),
              Expanded(child: Text(tr('哪个像你？'), textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600))),
              SizedBox(width: 64, child: TextButton(onPressed: () => Navigator.pop(context, _kFocusEntry), child: Text(tr('关注点')))),
            ]),
            const SizedBox(height: NeoxSpace.md),
            GridView.count(
              crossAxisCount: 3,
              shrinkWrap: true,
              mainAxisSpacing: 10,
              crossAxisSpacing: 10,
              childAspectRatio: 0.72,
              physics: const NeverScrollableScrollPhysics(),
              children: [
                for (final (i, l) in _looks.indexed)
                  TweenAnimationBuilder<double>(
                    tween: Tween(begin: 0, end: 1),
                    duration: Duration(milliseconds: 260 + i * 70),
                    curve: Curves.easeOutBack,
                    builder: (c, v, child) => Transform.translate(offset: Offset(0, (1 - v) * 30), child: Opacity(opacity: v.clamp(0, 1), child: child)),
                    child: GestureDetector(
                      onTap: () { HapticFeedback.selectionClick(); Navigator.pop(context, l); },
                      child: Container(
                        padding: const EdgeInsets.all(8),
                        decoration: BoxDecoration(
                          color: Theme.of(context).colorScheme.surfaceContainerHighest.withValues(alpha: 0.5),
                          borderRadius: NeoxRadius.cardR,
                          border: Border.all(color: l == current ? NeoxBrand.blue : Colors.transparent, width: 2),
                        ),
                        child: Image.asset(_twinArt(l), fit: BoxFit.contain, filterQuality: FilterQuality.medium),
                      ),
                    ),
                  ),
              ],
            ),
          ]),
        ),
      );
}

/// 先帮你盯什么: 六个陶土格多选, 选完「好了」
class _FocusPicker extends StatefulWidget {
  const _FocusPicker();
  @override
  State<_FocusPicker> createState() => _FocusPickerState();
}

class _FocusPickerState extends State<_FocusPicker> {
  static const _opts = [
    ('money', 'i-receipt', '省钱'),
    ('body', 'i-moon', '睡眠和体重'),
    ('social', 'i-person', '家人朋友'),
    ('habit', 'i-sneaker', '坚持习惯'),
    ('mood', 'i-sun', '心情'),
    ('place', 'i-route', '出去走走'),
  ];
  final Set<String> _on = {};

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(NeoxSpace.lg, 0, NeoxSpace.lg, NeoxSpace.lg),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(tr('先帮你盯什么？'), textAlign: TextAlign.center, style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          Text(tr('选几样，我会先说这些'), textAlign: TextAlign.center, style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
          const SizedBox(height: NeoxSpace.lg),
          GridView.count(
            crossAxisCount: 3,
            shrinkWrap: true,
            mainAxisSpacing: 10,
            crossAxisSpacing: 10,
            childAspectRatio: 1.05,
            physics: const NeverScrollableScrollPhysics(),
            children: [
              for (final (key, clay, label) in _opts)
                GestureDetector(
                  onTap: () { HapticFeedback.selectionClick(); setState(() => _on.contains(key) ? _on.remove(key) : _on.add(key)); },
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 180),
                    decoration: BoxDecoration(
                      color: _on.contains(key) ? NeoxBrand.blue.withValues(alpha: 0.07) : theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.5),
                      borderRadius: NeoxRadius.cardR,
                      border: Border.all(color: _on.contains(key) ? NeoxBrand.blue : Colors.transparent, width: 1.5),
                    ),
                    child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                      AnimatedScale(
                        scale: _on.contains(key) ? 1.12 : 1,
                        duration: const Duration(milliseconds: 220),
                        curve: Curves.easeOutBack,
                        child: Image.asset(NeoxClay.of(clay), width: 40, height: 40, filterQuality: FilterQuality.medium),
                      ),
                      const SizedBox(height: 6),
                      Text(tr(label), style: theme.textTheme.labelLarge?.copyWith(fontWeight: _on.contains(key) ? FontWeight.w700 : FontWeight.w500)),
                    ]),
                  ),
                ),
            ],
          ),
          const SizedBox(height: NeoxSpace.lg),
          Row(mainAxisAlignment: MainAxisAlignment.end, children: [
            _Pill(label: tr('好了'), enabled: _on.isNotEmpty, onTap: () => Navigator.pop(context, _on.toList())),
          ]),
        ]),
      ),
    );
  }
}

/// 截图里认出来的几笔: 默认全勾, 点一下去掉
class _ScreenshotSheet extends StatefulWidget {
  const _ScreenshotSheet({required this.items});
  final List<({ParsedPayment pay, DateTime at})> items;
  @override
  State<_ScreenshotSheet> createState() => _ScreenshotSheetState();
}

class _ScreenshotSheetState extends State<_ScreenshotSheet> {
  late final Set<int> _on = {for (var i = 0; i < widget.items.length; i++) i};

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return _SheetFrame(
      title: tr('看到 ${widget.items.length} 笔'),
      doneLabel: tr('记下 ${_on.length} 笔'),
      canDone: _on.isNotEmpty,
      onDone: () => Navigator.pop(context, [for (final i in _on) widget.items[i]]),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.45),
        child: ListView(shrinkWrap: true, children: [
          for (final (i, it) in widget.items.indexed)
            InkWell(
              borderRadius: NeoxRadius.cardR,
              onTap: () => setState(() => _on.contains(i) ? _on.remove(i) : _on.add(i)),
              child: AnimatedOpacity(
                opacity: _on.contains(i) ? 1 : 0.35,
                duration: const Duration(milliseconds: 150),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 4),
                  child: Row(children: [
                    Icon(_on.contains(i) ? Icons.check_circle : Icons.circle_outlined, size: 20, color: _on.contains(i) ? NeoxBrand.blue : theme.colorScheme.outline),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        [it.pay.merchant ?? it.pay.category, if (it.pay.merchant != null) it.pay.category].join(' · '),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodyMedium,
                      ),
                    ),
                    Text(
                      '${it.pay.income ? '+' : ''}¥${_num(it.pay.amount)}',
                      style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w700),
                    ),
                  ]),
                ),
              ),
            ),
        ]),
      ),
    );
  }
}

/// 自动记账: 一张图 + 三个开关。通知使用权要去系统设置页给, 回来自动认。
class _AutoSheet extends ConsumerWidget {
  const _AutoSheet();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(autoLedgerProvider);
    final ctl = ref.read(autoLedgerProvider.notifier);
    final theme = Theme.of(context);
    Widget row(String clay, String title, String sub, bool on, VoidCallback onTap) => InkWell(
          borderRadius: NeoxRadius.cardR,
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 4),
            child: Row(children: [
              Image.asset(NeoxClay.of(clay), width: 30, height: 30, filterQuality: FilterQuality.medium),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(title, style: theme.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w600)),
                  Text(sub, style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
                ]),
              ),
              Switch(value: on, onChanged: (_) => onTap()),
            ]),
          ),
        );
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(NeoxSpace.xl, 0, NeoxSpace.xl, NeoxSpace.lg),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          TweenAnimationBuilder<double>(
            tween: Tween(begin: 0.85, end: 1),
            duration: const Duration(milliseconds: 520),
            curve: Curves.easeOutBack,
            builder: (c, v, child) => Transform.scale(scale: v, child: child),
            child: Image.asset(_worldArt('autoledger'), height: 150, filterQuality: FilterQuality.medium),
          ),
          const SizedBox(height: NeoxSpace.sm),
          Text(tr('花了钱，自动记上'), textAlign: TextAlign.center, style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          Text(tr('支付宝、微信、银行到账扣款，在手机上识别'), textAlign: TextAlign.center, style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
          const SizedBox(height: NeoxSpace.lg),
          row('i-wave', tr('支付通知'), s.notif ? tr('已允许') : tr('去系统里允许「通知使用权」'), s.on && s.notif, () async {
            if (s.on && s.notif) { await ctl.disable(); return; }
            await ctl.enable(notif: true, sms: false);
          }),
          row('i-mail', tr('银行短信'), s.sms ? tr('已允许 · 补上最近 7 天') : tr('允许读短信'), s.on && s.sms, () async {
            if (s.on && s.sms && !s.notif) { await ctl.disable(); return; }
            await ctl.enable(notif: false, sms: true);
          }),
          row('i-moon', tr('每晚问一句'), tr('21:30 带上最要紧的一件事来问你'), s.checkin, () => ctl.setCheckin(!s.checkin)),
        ]),
      ),
    );
  }
}

class _RecordRow extends StatelessWidget {
  const _RecordRow({required this.record});
  final PilotRecord record;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mute = theme.colorScheme.onSurfaceVariant;
    final k = _kinds[record.type] ?? const _Kind('i-doc', '记录');
    final value = k.format?.call(record);
    /* 标题是服务端按类型生成的人话 (「体重」「支出 午饭」); 跟类型名重复时只显示值, 不说两遍 */
    /* 还没传上去的那条没有服务端起的标题 (「支出 吃饭」), 照同样的规则补上分类 */
    final category = record.data['category'];
    final merchant = record.data['merchant'];
    final title = record.title.isEmpty || record.title == k.label
        ? (category is String && category.isNotEmpty ? '${k.label} $category' : k.label)
        : record.title;
    final tags = [
      if (merchant is String && merchant.isNotEmpty) merchant,
      if (record.byPilot) tr('Pilot 记的'),
      if (record.source == 'device:phone:auto') tr('自动'),
      if (record.source == 'device:phone:screenshot') tr('截图'),
      if (record.pending) tr('待同步'),
    ];
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: NeoxSpace.sm),
      child: Row(children: [
        SizedBox(width: 44, child: Text(_hm(record.at), style: theme.textTheme.labelMedium?.copyWith(color: mute, fontFeatures: const [FontFeature.tabularFigures()]))),
        Image.asset(NeoxClay.of(k.clay), width: 28, height: 28, filterQuality: FilterQuality.medium),
        const SizedBox(width: NeoxSpace.md),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, maxLines: 2, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodyMedium),
            if (tags.isNotEmpty)
              Text(tags.join(' · '), maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.labelSmall?.copyWith(color: mute)),
          ]),
        ),
        if (value != null && value.isNotEmpty) ...[
          const SizedBox(width: NeoxSpace.sm),
          Text(value, style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
        ],
      ]),
    );
  }
}

// ───────── 快记的几个输入 (底部弹层, 一个输入一个确认) ─────────

/// 弹层里的输入不要框 —— 主题默认的描边在弹层里是一圈粗黑边 (模拟器实测), 只写 border: none 压不住
/// enabled / focused 两档, 三个都得清掉。大字号本身就是焦点。
InputDecoration _bare({required String hint, String? prefix, String? suffix}) => InputDecoration(
      hintText: hint,
      prefixText: prefix,
      suffixText: suffix,
      border: InputBorder.none,
      enabledBorder: InputBorder.none,
      focusedBorder: InputBorder.none,
      filled: false,
      isDense: true,
      contentPadding: const EdgeInsets.symmetric(vertical: 8),
    );

class _SheetFrame extends StatelessWidget {
  const _SheetFrame({required this.title, required this.child, required this.onDone, this.canDone = true, this.doneLabel});
  final String title;
  final Widget child;
  final VoidCallback onDone;
  final bool canDone;
  final String? doneLabel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(NeoxSpace.xl, 0, NeoxSpace.xl, NeoxSpace.lg),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(title, style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
          const SizedBox(height: NeoxSpace.lg),
          child,
          const SizedBox(height: NeoxSpace.lg),
          /* 小胶囊靠右 (不是整宽大条: 2026-10-09 用户嫌整宽按钮「传统、质感低」) */
          Row(mainAxisAlignment: MainAxisAlignment.end, children: [
            _Pill(label: doneLabel ?? tr('记下'), onTap: onDone, enabled: canDone),
          ]),
        ]),
      ),
    );
  }
}

class _NumberSheet extends StatefulWidget {
  const _NumberSheet({required this.title, required this.unit});
  final String title;
  final String unit;
  @override
  State<_NumberSheet> createState() => _NumberSheetState();
}

class _NumberSheetState extends State<_NumberSheet> {
  String _text = '';
  double? get _v => double.tryParse(_text.trim());

  @override
  Widget build(BuildContext context) => _SheetFrame(
        title: widget.title,
        canDone: _v != null && _v! > 0,
        onDone: () => Navigator.pop(context, _v),
        child: TextField(
          autofocus: true,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          onChanged: (v) => setState(() => _text = v),
          onSubmitted: (_) { if (_v != null && _v! > 0) Navigator.pop(context, _v); },
          style: Theme.of(context).textTheme.headlineSmall,
          decoration: _bare(hint: '0', suffix: widget.unit),
        ),
      );
}

class _ExpenseSheet extends StatefulWidget {
  const _ExpenseSheet({this.initial = ''});
  final String initial;
  @override
  State<_ExpenseSheet> createState() => _ExpenseSheetState();
}

class _ExpenseSheetState extends State<_ExpenseSheet> {
  String _amount = '';
  late String _what = widget.initial;
  /* 不选 = 其它; 五个一行放得下 */
  static const _cats = ['吃饭', '交通', '居家', '衣着', '购物'];
  double? get _v => double.tryParse(_amount.trim());

  @override
  Widget build(BuildContext context) => _SheetFrame(
        title: tr('花了多少'),
        canDone: _v != null && _v! > 0,
        onDone: () => Navigator.pop(context, (amount: _v!, what: _what)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          TextField(
            autofocus: true,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            onChanged: (v) => setState(() => _amount = v),
            style: Theme.of(context).textTheme.headlineSmall,
            decoration: _bare(hint: '0', prefix: '¥ '),
          ),
          const SizedBox(height: NeoxSpace.sm),
          Wrap(spacing: 8, runSpacing: 6, children: [
            for (final c in _cats)
              ChoiceChip(
                label: Text(tr(c)),
                visualDensity: VisualDensity.compact,
                showCheckmark: false,
                selected: _what == c,
                onSelected: (s) => setState(() => _what = s ? c : ''),
              ),
          ]),
        ]),
      );
}

class _MoodSheet extends StatelessWidget {
  const _MoodSheet();
  @override
  Widget build(BuildContext context) => SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(NeoxSpace.xl, 0, NeoxSpace.xl, NeoxSpace.xl),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text(tr('现在心情怎么样'), style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
            const SizedBox(height: NeoxSpace.lg),
            Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
              for (var i = 1; i <= 5; i++)
                InkResponse(
                  radius: 32,
                  onTap: () => Navigator.pop(context, i),
                  child: Padding(padding: const EdgeInsets.all(6), child: Text(_moodFace(i), style: const TextStyle(fontSize: 36))),
                ),
            ]),
          ]),
        ),
      );
}

class _SleepSheet extends StatefulWidget {
  const _SleepSheet({required this.day});
  /// 起床那天
  final DateTime day;
  @override
  State<_SleepSheet> createState() => _SleepSheetState();
}

class _SleepSheetState extends State<_SleepSheet> {
  TimeOfDay _sleep = const TimeOfDay(hour: 23, minute: 30);
  TimeOfDay _wake = const TimeOfDay(hour: 7, minute: 30);

  ({DateTime start, DateTime end}) get _range {
    final d = widget.day;
    final end = DateTime(d.year, d.month, d.day, _wake.hour, _wake.minute);
    var start = DateTime(d.year, d.month, d.day, _sleep.hour, _sleep.minute);
    /* 晚上睡的算前一天晚上 */
    if (!start.isBefore(end)) start = start.subtract(const Duration(days: 1));
    return (start: start, end: end);
  }

  Future<void> _pick(bool sleep) async {
    final t = await showTimePicker(context: context, initialTime: sleep ? _sleep : _wake);
    if (t != null) setState(() => sleep ? _sleep = t : _wake = t);
  }

  @override
  Widget build(BuildContext context) {
    final r = _range;
    final mins = r.end.difference(r.start).inMinutes;
    final theme = Theme.of(context);
    Widget cell(String label, TimeOfDay t, bool sleep) => Expanded(
          child: InkWell(
            borderRadius: NeoxRadius.cardR,
            onTap: () => _pick(sleep),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: NeoxSpace.md),
              child: Column(children: [
                Text(label, style: theme.textTheme.labelMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
                const SizedBox(height: 4),
                Text(t.format(context), style: theme.textTheme.headlineSmall),
              ]),
            ),
          ),
        );
    return _SheetFrame(
      title: tr('睡了 ${_hours(mins)}'),
      canDone: mins > 0 && mins < 20 * 60,
      onDone: () => Navigator.pop(context, r),
      child: Row(children: [cell(tr('睡着'), _sleep, true), cell(tr('醒来'), _wake, false)]),
    );
  }
}

class _NoteSheet extends StatefulWidget {
  const _NoteSheet({this.title = '随手记', this.hint = '发生了什么、想到什么…'});
  final String title;
  final String hint;
  @override
  State<_NoteSheet> createState() => _NoteSheetState();
}

class _NoteSheetState extends State<_NoteSheet> {
  String _text = '';
  @override
  Widget build(BuildContext context) => _SheetFrame(
        title: tr(widget.title),
        canDone: _text.trim().isNotEmpty,
        onDone: () => Navigator.pop(context, _text),
        child: TextField(
          autofocus: true,
          minLines: 2,
          maxLines: 6,
          onChanged: (v) => setState(() => _text = v),
          decoration: _bare(hint: tr(widget.hint)),
        ),
      );
}
