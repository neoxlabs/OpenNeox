/// pilot_chat_page_test.dart — 跟 Pilot / 专员聊天的那一页 (头栏 + 发话 + 出错提示).
///
/// 用户在这里看到的东西比能点的事更重要: 是谁的窗口、它在不在、
/// 发不出去时有没有说清楚。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/i18n/tr.dart';
import 'package:neox_app/core/pilot/pilot_cloud.dart';
import 'package:neox_app/core/pilot/pilot_records.dart';
import 'package:neox_app/features/pilot/pilot_chat_page.dart';
import 'package:neox_app/features/pilot/pilot_im.dart';
import 'package:neox_app/features/pilot/pilot_link.dart';
import 'package:neox_app/shared/theme/theme_mode_provider.dart';

import '../../support/fake_pilot_cloud.dart';
import '../../support/mobile_test_support.dart';

final _pilot = PilotContact.fromJson({
  'session_id': 's-pilot',
  'name': '小航',
  'avatar': 'cat',
  'persona': '你的生活助理',
});

PilotSpecialist _spec(String name, {bool on = true, String? schedule, String duty = '看消息'}) =>
    PilotSpecialist.fromJson({
      'id': name,
      'name': name,
      'duty': duty,
      'clay': 'i-team',
      'on': on,
      'schedule': schedule == null ? null : {'label': schedule},
    });

Future<void> _pump(
  WidgetTester t,
  PilotThread thread, {
  FakePilotCloud? cloud,
  List<PilotSpecialist> team = const [],
}) async {
  phoneViewport(t);
  final prefs = await testPrefs(aiConsentGiven);
  await t.pumpWidget(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        pilotCloudProvider.overrideWithValue(cloud),
        pilotTeamProvider.overrideWith((ref) async => team),
      ],
      child: MaterialApp(home: PilotChatPage(thread: thread)),
    ),
  );
  /* 同意告知在 post-frame 后跑; 再给 _load 一帧 */
  await t.pump();
  await t.pump(const Duration(milliseconds: 50));
  await t.pump(const Duration(milliseconds: 50));
}

void main() {
  testWidgets('单聊: 标题是它的名字, 副标题是它的人设, 有打电话的键', (t) async {
    await _pump(t, PilotThread.direct(_pilot), cloud: FakePilotCloud());

    expect(find.text('小航'), findsOneWidget);
    expect(find.text('你的生活助理'), findsOneWidget);
    expect(find.byTooltip(tr('让它打给你')), findsOneWidget);
  });

  testWidgets('手机没网: 副标题直说「手机没网」, 不再挂«在线»', (t) async {
    mockConnectivity(online: false);
    await _pump(t, PilotThread.direct(_pilot), cloud: FakePilotCloud());

    expect(find.text(tr('手机没网，连不上它')), findsOneWidget);
    expect(find.text(tr('在线')), findsNothing);
  });

  testWidgets('有网但没填人设: 副标题写「在线」', (t) async {
    mockConnectivity(online: true);
    final quiet = PilotContact.fromJson({'session_id': 's2', 'name': '小航'});
    await _pump(t, PilotThread.direct(quiet), cloud: FakePilotCloud());

    expect(find.text(tr('在线')), findsOneWidget);
  });

  testWidgets('群: 标题带人数 (自己 + 开着的专员), 副标题说由谁派活, 不能打电话', (t) async {
    final team = [_spec('收支'), _spec('家里', on: false)];
    await _pump(t, PilotThread.group(_pilot), cloud: FakePilotCloud(), team: team);

    expect(find.text(tr('我的团队（2）')), findsOneWidget);
    expect(find.text(tr('小航 + 1 个专员 · 你说一句小航来派')), findsOneWidget);
    expect(find.byTooltip(tr('让它打给你')), findsNothing);
  });

  testWidgets('专员: 标题是专员名, 副标题是排班', (t) async {
    await _pump(
      t,
      PilotThread.specialist(_pilot, _spec('收支', schedule: '每天 9:00')),
      cloud: FakePilotCloud(),
    );
    expect(find.text('收支'), findsOneWidget);
    expect(find.text('每天 9:00'), findsOneWidget);
  });

  testWidgets('关着的专员: 副标题说「关着」', (t) async {
    await _pump(t, PilotThread.specialist(_pilot, _spec('家里', on: false)), cloud: FakePilotCloud());
    expect(find.text(tr('关着')), findsOneWidget);
  });

  testWidgets('空输入时右侧是麦克风 / 拍照, 没有「发送」', (t) async {
    await _pump(t, PilotThread.direct(_pilot), cloud: FakePilotCloud());
    expect(find.byTooltip(tr('发送')), findsNothing);
    expect(find.byTooltip(tr('让它打给你')), findsOneWidget);
  });

  testWidgets('打字后出现「发送」, 点一下把话交给云端并从输入框清掉', (t) async {
    final cloud = FakePilotCloud();
    await _pump(t, PilotThread.direct(_pilot), cloud: cloud);

    await t.enterText(find.byType(TextField), '帮我看下天气');
    await t.pump();
    await t.tap(find.byTooltip(tr('发送')));
    await t.pump();
    await t.pump(const Duration(milliseconds: 50));

    expect(cloud.sent, ['帮我看下天气']);
    expect(find.text('帮我看下天气'), findsOneWidget, reason: '自己的气泡已经在列表里');
    expect(t.widget<TextField>(find.byType(TextField)).controller!.text, isEmpty);
  });

  testWidgets('专员窗口发出去的话带「@名字 」', (t) async {
    final cloud = FakePilotCloud();
    await _pump(t, PilotThread.specialist(_pilot, _spec('收支')), cloud: cloud);

    await t.enterText(find.byType(TextField), '这周怎么样');
    await t.pump();
    await t.tap(find.byTooltip(tr('发送')));
    await t.pump();
    await t.pump(const Duration(milliseconds: 50));

    expect(cloud.sent, ['@收支 这周怎么样']);
  });

  testWidgets('发不出去 (超时): 顶一条「连不上云端」，说清楚恢复后再发', (t) async {
    mockConnectivity(online: true);
    final cloud = FakePilotCloud(sendError: TimeoutException('too slow'));
    await _pump(t, PilotThread.direct(_pilot), cloud: cloud);

    await t.enterText(find.byType(TextField), '在吗');
    await t.pump();
    await t.tap(find.byTooltip(tr('发送')));
    await t.pump();
    await t.pump(const Duration(milliseconds: 100));

    expect(find.text(tr('连不上云端，恢复后再发')), findsOneWidget);
    expect(find.text(tr('重试')), findsOneWidget);

    /* 气泡左边挂一个可点的失败标记 (点它重发) */
    expect(find.byIcon(Icons.error_outline), findsOneWidget);

    /* NeoxToast 的自动关闭定时器 */
    await t.pumpWidget(const SizedBox.shrink());
    await t.pump(const Duration(seconds: 3));
  });

  testWidgets('断网时发失败: 也是「连不上云端」, 不把英文异常招出来', (t) async {
    mockConnectivity(online: false);
    final cloud = FakePilotCloud(sendError: Exception('SocketException: down'));
    await _pump(t, PilotThread.direct(_pilot), cloud: cloud);

    await t.enterText(find.byType(TextField), '在吗');
    await t.pump();
    await t.tap(find.byTooltip(tr('发送')));
    await t.pump();
    await t.pump(const Duration(milliseconds: 100));

    expect(find.text(tr('连不上云端，恢复后再发')), findsOneWidget);
    expect(find.byIcon(Icons.error_outline), findsOneWidget);
    expect(find.textContaining('SocketException'), findsNothing);

    await t.pumpWidget(const SizedBox.shrink());
    await t.pump(const Duration(seconds: 3));
  });

  testWidgets('返回键能退出这个窗口', (t) async {
    await _pump(t, PilotThread.direct(_pilot), cloud: FakePilotCloud());
    expect(find.byIcon(Icons.arrow_back_rounded), findsOneWidget);
  });
}
