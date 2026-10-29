/// pilot_im_shot_test.dart — 手机 Pilot 界面截图 (pilot:U-04 / U-05 / U-06 / U-07).
///
/// 打了 shot tag: 默认 flutter test 会跳过 (CI 不断言图), 只在显式跑时生成/比对图片:
///   flutter test --run-skipped --tags shot --update-goldens test/harness/pilot_im_shot_test.dart
///   产物: docs/pilot/ui-shots/*.png (给总控和设计看)
///
/// 截图和断言一起做: 图看排版, 断言钉行为 (今天页入口 / 回执三要素 / 卡原地变结果 / 停止冻结)。
@Tags(['shot'])
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:neox_app/core/pilot/pilot_cloud.dart';
import 'package:neox_app/core/pilot/pilot_records.dart';
import 'package:neox_app/core/storage/database.dart';
import 'package:neox_app/features/pilot/pilot_chat_page.dart';
import 'package:neox_app/features/pilot/pilot_im.dart';
import 'package:neox_app/features/pilot/pilot_inbox_page.dart';
import 'package:neox_app/features/pilot/pilot_link.dart';
import 'package:neox_app/features/pilot/pilot_today_page.dart';
import 'package:neox_app/shared/theme/app_theme.dart';
import 'package:neox_app/shared/theme/theme_mode_provider.dart';

import '../support/fake_pilot_cloud.dart';
import '../support/mobile_test_support.dart';
import 'render_shot.dart';

const _shots = '../../../../docs/pilot/ui-shots';

final _pilot = PilotContact.fromJson({
  'session_id': 's-pilot',
  'name': '小航',
  'avatar': 'cat',
  'persona': '你的生活助理',
});

class _Records implements PilotRecordsApi {
  @override
  int get pendingCount => 0;
  @override
  Future<List<PilotSpecialist>> team() async => const [];
  @override
  Future<PilotToday> today() async => PilotToday(overview: await overview());
  @override
  Future<PilotOverview> overview() async => PilotOverview(insights: await insights(), rooms: const {});
  @override
  Future<List<PilotInsight>> insights() async => const [
        PilotInsight(id: 'money.pace', domain: 'money', tone: 'watch', score: 0.8, title: '这个月花得快了 55%', detail: '日常开销到今天 ¥7,538，前 3 个月同期平均 ¥4,862。'),
      ];
  @override
  Future<List<PilotRecord>> day(DateTime day) async => const [];
  @override
  Future<void> log(List<Map<String, Object?>> records) async {}
  @override
  Future<void> delete(String id) async {}
  @override
  Future<List<PilotMetricPoint>> metric(String metric, {required DateTime from, required DateTime to}) async => const [];
  @override
  Future<String> profile() async => '';
  @override
  Future<List<PilotRecord>> query({List<String>? types, String? q, DateTime? from, DateTime? to, int limit = 20}) async => const [];
}

class _Cloud extends FakePilotCloud {
  _Cloud({
    super.liveController,
    super.actionsByState,
    super.messagesRows,
    super.interruptGate,
  });
  @override
  PilotRecordsApi get records => _Records();
}

List<Map<String, Object?>> _rows() {
  final now = DateTime.now();
  /* 时间锚在今天的固定时刻 —— 用 DateTime.now() 的话消息上的「今天 HH:mm」
   * 会随真实时钟变, golden 每次跑都红 (2026-10-18 闸门实测: 6:36 → 7:08)。 */
  final base = DateTime(now.year, now.month, now.day, 9, 41);
  int at(int minutesAgo) => base.subtract(Duration(minutes: minutesAgo)).millisecondsSinceEpoch;
  return [
    {'id': 1, 'role': 'user', 'text': '明天几点叫我？', 'at': at(9)},
    {'id': 2, 'role': 'assistant', 'text': '7:40，要我把闹钟也设上吗？', 'at': at(8)},
    {'id': 3, 'role': 'user', 'text': '设上吧', 'at': at(7)},
    {'id': 4, 'role': 'event', 'text': '✅ 设好了 7:40 的闹钟，到点叫你', 'at': at(6)},
    {'id': 5, 'role': 'assistant', 'text': '顺手看了下明天的天气：早上 12°C，出门加件外套。', 'at': at(5)},
  ];
}

Map<String, dynamic> _actionCard({String state = 'pending', String result = ''}) => {
      'id': 'c1',
      'title': '发短信给妈妈',
      'summary': '今天回家吃饭吗',
      'options': ['批准', '不要'],
      'actionState': state,
      'actionResult': result,
      'action': {'action': 'send_sms', 'preview': '今天回家吃饭吗'},
    };

void main() {
  late SharedPreferences prefs;

  setUpAll(() async {
    stubNativePlugins();
    /* 打开 NeoxRounded: 这份截图要看正文/数字的真实效果。
     * 别的截图测试不开 —— 注册字体会改变它们已入库 golden 的像素。 */
    await loadAppFonts(neoxRounded: true);
  });

  setUp(() async {
    SharedPreferences.setMockInitialValues({...aiConsentGiven});
    prefs = await SharedPreferences.getInstance();
  });

  Future<void> settle(WidgetTester t) async {
    for (var i = 0; i < 8; i++) {
      await t.pump(const Duration(milliseconds: 80));
    }
  }

  testWidgets('会话列表: 顶栏有「今天」入口', (t) async {
    phoneViewport(t);
    final db = newTestDb();
    addTearDown(db.close);
    await shoot(
      t,
      name: 'pilot-inbox-today',
      dir: _shots,
      child: PilotInboxPage(pilots: [_pilot]),
      theme: AppTheme.light,
      size: ShotSize.phoneNarrow,
      settleAnimations: false,
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        appDatabaseProvider.overrideWithValue(db),
        pilotCloudProvider.overrideWithValue(_Cloud()),
        pilotTeamProvider.overrideWith((ref) async => const <PilotSpecialist>[]),
        pilotPreviewProvider(_pilot.sessionId).overrideWith((ref) async => const PilotPreview()),
      ],
    );
    expect(find.byTooltip('今天'), findsOneWidget);
  });

  testWidgets('今天页: 通知点开看到的就是这一页', (t) async {
    await shoot(
      t,
      name: 'pilot-today',
      dir: _shots,
      child: PilotTodayPage(pilot: _pilot),
      theme: AppTheme.light,
      size: ShotSize.phoneNarrow,
      settleAnimations: false,
      overrides: [pilotCloudProvider.overrideWithValue(_Cloud())],
    );
    expect(find.text('今天'), findsWidgets);
  });

  testWidgets('对话: 回执卡三要素 + 动作卡钉在顶上', (t) async {
    await shoot(
      t,
      name: 'pilot-im-receipt',
      dir: _shots,
      child: PilotChatPage(thread: PilotThread.direct(_pilot)),
      theme: AppTheme.light,
      size: ShotSize.phoneNarrow,
      settleAnimations: false,
      capture: false,
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        pilotCloudProvider.overrideWithValue(
          _Cloud(messagesRows: _rows(), actionsByState: {'pending': [_actionCard()]}),
        ),
      ],
    );
    await settle(t);

    expect(find.text('发短信给妈妈'), findsOneWidget);
    /* 回执 = 一句话 + 数字 + 下一步 */
    expect(find.text('设好了 7:40 的闹钟，到点叫你'), findsOneWidget);
    expect(find.text('7:40 · 到点我会提醒你'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('$_shots/pilot-im-receipt.png'));
  });

  testWidgets('批准后动作卡原地变结果', (t) async {
    final cloud = _Cloud(messagesRows: _rows(), actionsByState: {'pending': [_actionCard()]});
    await shoot(
      t,
      name: 'pilot-im-action-pending',
      dir: _shots,
      child: PilotChatPage(thread: PilotThread.direct(_pilot)),
      theme: AppTheme.light,
      size: ShotSize.phoneNarrow,
      settleAnimations: false,
      capture: false,
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        pilotCloudProvider.overrideWithValue(cloud),
      ],
    );
    await settle(t);

    await t.tap(find.text('批准'));
    await t.pump();
    cloud.actionsByState = {
      'pending': [],
      'approved': [_actionCard(state: 'approved')],
    };
    await t.pump(const Duration(seconds: 3));
    cloud.actionsByState = {
      'pending': [],
      'approved': [],
      'done': [_actionCard(state: 'done', result: '已发送（1 条）')],
    };
    await t.pump(const Duration(seconds: 3));
    await t.pump();

    expect(find.text('办好了'), findsOneWidget);
    expect(find.text('已发送（1 条）'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('$_shots/pilot-im-action-result.png'));
  });

  testWidgets('点停止: 立刻定格并显示「已停」', (t) async {
    final live = StreamController<PilotLive>();
    addTearDown(live.close);
    final gate = Completer<void>();
    final cloud = _Cloud(liveController: live, messagesRows: _rows(), interruptGate: gate);
    await shoot(
      t,
      name: 'pilot-im-stopped',
      dir: _shots,
      child: PilotChatPage(thread: PilotThread.direct(_pilot)),
      theme: AppTheme.light,
      size: ShotSize.phoneNarrow,
      settleAnimations: false,
      capture: false,
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        pilotCloudProvider.overrideWithValue(cloud),
      ],
    );
    await settle(t);

    cloud.emit('delta', text: '我先把明天的安排说一半');
    await t.pump();
    await t.pump();
    await t.tap(find.byTooltip('让它停下'));
    await t.pump();
    await t.pump();

    expect(find.text('已停'), findsOneWidget);
    /* interrupt 还卡着: 还能看到停下这一刻的字 */
    expect(find.text('我先把明天的安排说一半'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('$_shots/pilot-im-stopped.png'));
    gate.complete();
    await t.pump();
  });
}
