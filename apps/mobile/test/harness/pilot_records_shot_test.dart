/// 我的记录页 + Pilot 记录契约 —— 截图看样子, 断言看行为 (快记一笔真的进了 log)。
///   flutter test --update-goldens test/harness/pilot_records_shot_test.dart
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:neox_app/core/pilot/pilot_cloud.dart';
import 'package:neox_app/core/pilot/pilot_records.dart';
import 'package:neox_app/features/pilot/pilot_records_page.dart';
import 'package:neox_app/shared/theme/app_theme.dart';
import 'package:neox_app/shared/theme/theme_mode_provider.dart';

import 'render_shot.dart';

class _FakeRecords implements PilotRecordsApi {
  final logged = <Map<String, Object?>>[];

  @override
  int get pendingCount => 1;

  @override
  Future<List<PilotSpecialist>> team() async => const [];


  @override
  Future<PilotToday> today() async => PilotToday(overview: await overview());

  @override
  Future<List<PilotRecord>> day(DateTime day) async {
    DateTime at(int h, int m) => DateTime(day.year, day.month, day.day, h, m);
    return [
      PilotRecord(id: 'A', type: 'health.sleep', domain: 'health', at: at(0, 10), title: '睡眠', value: 452, unit: 'min'),
      PilotRecord(id: 'B', type: 'health.weight', domain: 'health', at: at(7, 42), title: '体重', value: 72.3, unit: 'kg'),
      PilotRecord(id: 'C', type: 'finance.expense', domain: 'finance', at: at(12, 18), title: '支出 午饭', value: 35, unit: 'CNY', source: 'agent:pilot:p1'),
      PilotRecord(id: 'D', type: 'social.interaction', domain: 'social', at: at(15, 0), title: '和 老王、小李', source: 'agent:pilot:p1'),
      PilotRecord(id: 'E', type: 'mood', domain: 'life', at: at(18, 30), title: '心情 4/5', value: 4),
      PilotRecord(id: 'F', type: 'note', domain: 'life', at: at(21, 5), title: '今天把 Pilot 的数据层上线了, 明天接手机上报', pending: true),
    ];
  }

  @override
  Future<void> log(List<Map<String, Object?>> records) async => logged.addAll(records);

  @override
  Future<void> delete(String id) async {}

  @override
  Future<List<PilotMetricPoint>> metric(String metric, {required DateTime from, required DateTime to}) async {
    if (metric == 'health.weight') {
      return [for (var i = 0; i < 20; i++) PilotMetricPoint(from.add(Duration(days: i)), 73.4 - i * 0.06 + (i % 3) * 0.1)];
    }
    return [PilotMetricPoint(to, 35), PilotMetricPoint(to, 128.5)];
  }

  @override
  Future<String> profile() async => '';

  @override
  Future<PilotOverview> overview() async => PilotOverview(insights: await insights(), rooms: const {});

  @override
  Future<List<PilotInsight>> insights() async => const [
        PilotInsight(id: 'money.pace', domain: 'money', tone: 'watch', score: 0.8, title: '这个月花得快了 55%', detail: '日常开销到今天 ¥7,538，前 3 个月同期平均 ¥4,862。'),
        PilotInsight(id: 'social.drift:妈妈', domain: 'social', tone: 'watch', score: 0.85, title: '42 天没和妈妈联系了', detail: '你们平时大概 7 天联系一次。', suggestion: '今天给妈妈打个电话？'),
      ];

  @override
  Future<List<PilotRecord>> query({List<String>? types, String? q, DateTime? from, DateTime? to, int limit = 20}) async => const [];
}

class _FakeCloud implements PilotCloud {
  _FakeCloud(this.records);
  @override
  final _FakeRecords records;
  @override
  Future<bool> enabled({bool refresh = false}) async => true;
  @override
  bool? get cachedEnabled => true;
  @override
  Future<List<Map<String, dynamic>>> pilots() async => const [];
  @override
  Future<Map<String, dynamic>> board(String pilotId) async => const {};
  @override
  Future<void> answerReport(String reportId, String answer) async {}
  @override
  Future<void> markReportsRead(String pilotId) async {}
  @override
  Future<List<Map<String, dynamic>>> actions(String pilotId, String state) async => const [];
  @override
  Future<String> ask(String pilotId, String text, {List<Map<String, Object?>> attachments = const [], void Function(String, bool)? onDelta}) async => '';
  @override
  Future<void> setModel(String pilotId, String modelId) async {}
  @override
  Future<void> interrupt(String pilotId) async {}
  @override
  Future<List<Map<String, dynamic>>> messages(String pilotId, {int limit = 60, int? before}) async => const [];
  @override
  Future<void> send(String pilotId, String text, {String? clientId, List<Map<String, Object?>> attachments = const []}) async {}
  @override
  Future<({bool busy, String? step})> attach(String pilotId) async => (busy: false, step: null);
  @override
  Stream<PilotLive> get live => const Stream.empty();
}

void main() {
  late SharedPreferences prefs;

  setUpAll(() async {
    stubNativePlugins();
    await loadAppFonts();
    /* 已经挑过分身, 不弹「哪个像你」 */
    SharedPreferences.setMockInitialValues({'pilot_twin_look_v1': 'young-f'});
    prefs = await SharedPreferences.getInstance();
  });

  /* 场景里一直有浮动动画 (repeat), pumpAndSettle 等不到头 —— 一律按时长推 */
  Future<void> settle(WidgetTester t) async {
    for (var i = 0; i < 8; i++) {
      await t.pump(const Duration(milliseconds: 100));
    }
  }

  test('ULID: 26 位、按时间排序', () {
    final a = pilotUlid(DateTime(2026, 10, 11, 8));
    final b = pilotUlid(DateTime(2026, 10, 11, 9));
    expect(RegExp(r'^[0-9A-HJKMNP-TV-Z]{26}$').hasMatch(a), isTrue);
    expect(a.compareTo(b) < 0, isTrue);
    expect(RegExp(r'^[+-]\d{2}:\d{2}$').hasMatch(pilotTimezone()), isTrue);
  });

  for (final dark in [false, true]) {
    testWidgets('我的记录 · ${dark ? "深色" : "浅色"}', (t) async {
      final records = _FakeRecords();
      await shoot(t,
        name: 'pilot-records-${dark ? "dark" : "light"}',
        child: const PilotRecordsPage(),
        theme: dark ? AppTheme.dark : AppTheme.light,
        size: ShotSize.phoneNarrow,
        settleAnimations: false,
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          pilotCloudProvider.overrideWithValue(_FakeCloud(records)),
        ],
      );
      /* 身体那页: 体重泡泡取 30 天走势最后一个点; 有身体方面的洞察时分身头上一个「!」 */
      expect(find.text('72.4 kg'), findsOneWidget);
      /* 流水收在右上角 */
      await t.tap(find.byTooltip('流水'));
      await settle(t);
      expect(find.text('Pilot 记的'), findsNWidgets(2));
      expect(find.text('待同步'), findsOneWidget);
    });
  }

  testWidgets('它发现的: 卡组按要紧排, 能翻', (t) async {
    final records = _FakeRecords();
    await shoot(t,
      name: 'pilot-records-insights',
      child: const PilotRecordsPage(),
      theme: AppTheme.light,
      size: ShotSize.phoneNarrow,
      settleAnimations: false,
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        pilotCloudProvider.overrideWithValue(_FakeCloud(records)),
      ],
    );
    await t.tap(find.byTooltip('它发现的'));
    await settle(t);
    expect(find.text('这个月花得快了 55%'), findsOneWidget);
    expect(find.text('42 天没和妈妈联系了'), findsOneWidget);
  });

  testWidgets('快记体重: 输入数字点「记下」→ 进 log', (t) async {
    final records = _FakeRecords();
    await shoot(t,
      name: 'pilot-records-quick-weight',
      child: const PilotRecordsPage(),
      theme: AppTheme.light,
      size: ShotSize.phoneNarrow,
      settleAnimations: false,
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        pilotCloudProvider.overrideWithValue(_FakeCloud(records)),
      ],
    );
    /* 点身边浮着的体重泡泡 → 输入 → 记下 */
    await t.tap(find.text('72.4 kg'));
    await settle(t);
    await t.enterText(find.byType(TextField), '71.8');
    await t.pump();
    await t.tap(find.text('记下'));
    await settle(t);
    expect(records.logged.single['type'], 'health.weight');
    expect(records.logged.single['value'], 71.8);
    expect(records.logged.single['occurred_at'], isA<int>());
  });
}
