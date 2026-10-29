/// pilot_records.dart — Pilot 的个人记录 (2026-10-11): 体重、睡眠、花销、心情、打卡、随手记……一生的流水账。
///
/// 服务端是 pilot-data (NeoxCloud apps/pilot-data, 协议见 Neox 仓 packages/pilot-data-sdk)。
/// 这里是共享层的契约 + 记录模型; 实现在发行版里 (商业版 lib/commercial/pilot/neox_pilot_records.dart),
/// 经 [PilotCloud.records] 拿到。没有 Pilot 的发行版拿到 null。
library;

import 'dart:math';

/// 一条记录 (服务端 StoredRecord 的手机侧形状)
class PilotRecord {
  PilotRecord({
    required this.id,
    required this.type,
    required this.domain,
    required this.at,
    this.endAt,
    required this.title,
    this.value,
    this.unit,
    this.data = const {},
    this.privacy = 'normal',
    this.source = '',
    this.pending = false,
  });

  factory PilotRecord.fromJson(Map<String, dynamic> j) => PilotRecord(
        id: '${j['id']}',
        type: '${j['type']}'.split('@').first,
        domain: '${j['domain'] ?? 'life'}',
        at: DateTime.fromMillisecondsSinceEpoch((j['occurred_at'] as num).toInt()),
        endAt: j['ended_at'] == null ? null : DateTime.fromMillisecondsSinceEpoch((j['ended_at'] as num).toInt()),
        title: '${j['title'] ?? ''}',
        value: (j['value'] as num?)?.toDouble(),
        unit: j['unit'] as String?,
        data: j['data'] is Map ? Map<String, dynamic>.from(j['data'] as Map) : const {},
        privacy: '${j['privacy'] ?? 'normal'}',
        source: '${j['source'] ?? ''}',
      );

  final String id;
  /// 不带版本: 'health.weight'
  final String type;
  final String domain;
  final DateTime at;
  final DateTime? endAt;
  final String title;
  final double? value;
  final String? unit;
  final Map<String, dynamic> data;
  final String privacy;
  /// device:phone/... | agent:pilot:... | user
  final String source;
  /// 还在手机上排队没传上去 (断网时记的)
  final bool pending;

  bool get byPilot => source.startsWith('agent:pilot');
}

/// 指标序列里的一个点
class PilotMetricPoint {
  const PilotMetricPoint(this.day, this.value);
  final DateTime day;
  final double value;
}

/// 一条洞察 (服务端 pilot-data-sdk insights.ts 算的): 一个短标题 + 一句带数的说明 + 一件能做的事
class PilotInsight {
  const PilotInsight({required this.id, required this.domain, required this.tone, required this.score, required this.title, required this.detail, this.suggestion, this.action});

  factory PilotInsight.fromJson(Map<String, dynamic> j) => PilotInsight(
        id: '${j['id']}',
        domain: '${j['domain']}',
        tone: '${j['tone']}',
        score: (j['score'] as num?)?.toDouble() ?? 0,
        title: '${j['title'] ?? ''}',
        detail: '${j['detail'] ?? ''}',
        suggestion: j['suggestion'] as String?,
        action: j['action'] is Map ? Map<String, dynamic>.from(j['action'] as Map) : null,
      );

  /// 一键就办的那件事: {kind: remind, label, at 'HH:mm', title} / {kind: checkin, label, habit} / {kind: ask, label, prompt}
  final Map<String, dynamic>? action;

  final String id;
  /// money / body / mood / social / habit / place / cross
  final String domain;
  /// good / watch / info
  final String tone;
  final double score;
  final String title;
  final String detail;
  final String? suggestion;
}

/// 洞察 + 八个房间的摘要 (服务端 summarizeRooms 算好, 手机只画): rooms[房间 id] 是那个房间的数
class PilotOverview {
  const PilotOverview({required this.insights, required this.rooms});
  final List<PilotInsight> insights;
  final Map<String, dynamic> rooms;

  Map<String, dynamic> room(String id) => rooms[id] is Map ? Map<String, dynamic>.from(rooms[id] as Map) : const {};
}

/// 「今天」页: 简报 (最要紧的三件) · 今天到点响过的 · 它替你办完的 · 洞察 + 房间
class PilotToday {
  const PilotToday({this.briefTitle, this.briefItems = const [], this.fired = const [], this.done = const [], required this.overview});

  factory PilotToday.fromJson(Map<String, dynamic> j) {
    final b = j['brief'] is Map ? Map<String, dynamic>.from(j['brief'] as Map) : null;
    List<Map<String, dynamic>> maps(Object? v) => [for (final x in (v as List? ?? const [])) if (x is Map) Map<String, dynamic>.from(x)];
    return PilotToday(
      briefTitle: b?['title'] as String?,
      briefItems: [for (final x in (b?['items'] as List? ?? const [])) '$x'],
      fired: maps(j['fired']),
      done: maps(j['done']),
      overview: PilotOverview(
        insights: [for (final x in maps(j['insights'])) PilotInsight.fromJson(x)],
        rooms: j['rooms'] is Map ? Map<String, dynamic>.from(j['rooms'] as Map) : const {},
      ),
    );
  }

  final String? briefTitle;
  final List<String> briefItems;
  /// [{text, result: sent|deferred|briefed, at}]
  final List<Map<String, dynamic>> fired;
  /// [{id, at, title, url?, text?}] 近 3 天它做出来的成品
  final List<Map<String, dynamic>> done;
  final PilotOverview overview;
}

/// 团队里的一个专员 (服务端 SDK team.ts 的目录 + 这个人的开关 / 最近一次)
class PilotSpecialist {
  PilotSpecialist.fromJson(Map<String, dynamic> j)
      : id = '${j['id']}',
        name = '${j['name'] ?? ''}',
        duty = '${j['duty'] ?? ''}',
        clay = '${j['clay'] ?? 'i-team'}',
        on = j['on'] != false,
        scheduleLabel = (j['schedule'] as Map?)?['label'] as String?,
        next = (j['schedule'] as Map?)?['next'] as String?,
        lastAt = ((j['last'] as Map?)?['at'] as num?)?.toInt(),
        lastSummary = (j['last'] as Map?)?['summary'] as String?,
        runs30 = (j['runs30'] as num?)?.toInt() ?? 0,
        today = (j['today'] as num?)?.toInt() ?? 0,
        tokensToday = (j['tokensToday'] as num?)?.toInt() ?? 0,
        sees = [for (final s in (j['sees'] as List? ?? const [])) '$s'];

  final String id;
  final String name;
  final String duty;
  final String clay;
  final bool on;
  /// 「每月 1 号出月报」; 没有定时活的是 null
  final String? scheduleLabel;
  /// 下次 'YYYY-MM-DD HH:mm'
  final String? next;
  final int? lastAt;
  final String? lastSummary;
  final int runs30;
  final int today;
  final int tokensToday;
  /// 它能看的记录类型 (前缀)
  final List<String> sees;
}

abstract class PilotRecordsApi {
  /// 团队: 每个专员的开关 / 下次 / 最近交了什么
  Future<List<PilotSpecialist>> team();

  /// 从这个人一年的记录里挑出值得说的事, 按要紧程度排好
  Future<List<PilotInsight>> insights();

  /// 「今天」页一次拿齐
  Future<PilotToday> today();

  /// 洞察 + 八个房间的摘要, 一次拿齐
  Future<PilotOverview> overview();

  /// 某一天 (按发生地当天) 的全部记录, 时间正序; 含还没传上去的
  Future<List<PilotRecord>> day(DateTime day);

  /// 记一笔或几笔。不带 id 的自动补; 断网先存手机、联网后补传 (返回时已经在本地队列或服务端)。
  /// 每条: {type, occurred_at(毫秒, 默认现在), value?, data?, title?, ended_at?}
  Future<void> log(List<Map<String, Object?>> records);

  Future<void> delete(String id);

  /// 指标按天: 'health.weight' / 'health.steps' / 'finance.expense:CNY' …
  Future<List<PilotMetricPoint>> metric(String metric, {required DateTime from, required DateTime to});

  /// 给模型看的档案文本 (当前有效的事实)
  Future<String> profile();

  /// 结构化查 / 关键词搜 (Pilot 的 pilot_query / pilot_metric 工具用)
  Future<List<PilotRecord>> query({List<String>? types, String? q, DateTime? from, DateTime? to, int limit = 20});

  /// 排队中的条数 (界面上标「待同步」)
  int get pendingCount;
}

// ───────── ULID: 客户端生成 id → 断网可记、重发不重复 (与 pilot-data-sdk ulid.ts 同规则) ─────────

const _alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
final _rand = Random.secure();

String pilotUlid([DateTime? at]) {
  var ms = (at ?? DateTime.now()).millisecondsSinceEpoch;
  final time = List.filled(10, '0');
  for (var i = 9; i >= 0; i--) {
    time[i] = _alphabet[ms % 32];
    ms ~/= 32;
  }
  final rand = List.generate(16, (_) => _alphabet[_rand.nextInt(32)]);
  return time.join() + rand.join();
}

/// 记录发生那一刻手机的 UTC 偏移, 写成 '+08:00' (服务端按它切「当天」)。
/// 不猜 IANA 名: Dart 只给缩写, 猜错了夏令时那半年的「当天」会错; 偏移按那一刻取, 一定对。
String pilotTimezone([DateTime? at]) {
  final m = (at ?? DateTime.now()).timeZoneOffset.inMinutes;
  final sign = m < 0 ? '-' : '+';
  final a = m.abs();
  return '$sign${(a ~/ 60).toString().padLeft(2, '0')}:${(a % 60).toString().padLeft(2, '0')}';
}
