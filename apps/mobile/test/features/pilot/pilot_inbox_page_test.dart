/// pilot_inbox_page_test.dart — Pilot 首页 = 会话列表.
///
/// 用户看到的是「联系人」: Pilot 自己 / 我的团队 / 每个专员。
/// 这里钉: 谁在上面、谁被淡掉、未读几个、搜索怎么筛、点进去到哪。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:neox_app/core/i18n/tr.dart';
import 'package:neox_app/core/pilot/pilot_records.dart';
import 'package:neox_app/core/storage/database.dart';
import 'package:neox_app/features/pilot/pilot_im.dart';
import 'package:neox_app/features/pilot/pilot_inbox_page.dart';
import 'package:neox_app/features/pilot/pilot_link.dart';
import 'package:neox_app/shared/theme/theme_mode_provider.dart';

import '../../support/mobile_test_support.dart';

final _pilot = PilotContact.fromJson({'session_id': 's-pilot', 'name': '小航', 'avatar': 'cat', 'persona': '你的生活助理'});

PilotSpecialist _spec(String name, {bool on = true, int? lastAt, String? summary, String? duty}) =>
    PilotSpecialist.fromJson({
      'id': name,
      'name': name,
      'duty': duty ?? '看消息',
      'clay': 'i-team',
      'on': on,
      'last': lastAt == null ? null : {'at': lastAt, 'summary': summary ?? ''},
    });

Future<void> _pump(
  WidgetTester t, {
  List<PilotSpecialist> team = const [],
  PilotPreview preview = const PilotPreview(),
  GoRouter? router,
  List<Override> extra = const [],
}) async {
  phoneViewport(t);
  final prefs = await testPrefs(aiConsentGiven);
  final db = newTestDb();
  addTearDown(db.close);
  final overrides = <Override>[
    sharedPreferencesProvider.overrideWithValue(prefs),
    appDatabaseProvider.overrideWithValue(db),
    pilotTeamProvider.overrideWith((ref) async => team),
    pilotPreviewProvider(_pilot.sessionId).overrideWith((ref) async => preview),
    ...extra,
  ];
  final page = PilotInboxPage(pilots: [_pilot]);
  await t.pumpWidget(
    ProviderScope(
      overrides: overrides,
      child: router == null ? MaterialApp(home: page) : MaterialApp.router(routerConfig: router),
    ),
  );
  await t.pump();
  await t.pump(const Duration(milliseconds: 50));
}

void main() {
  testWidgets('一行一个联系人: Pilot 名字 + 主管签 + 最后一句', (t) async {
    await _pump(
      t,
      preview: PilotPreview(direct: PilotLine(role: 'assistant', text: '今天 3 件事', at: DateTime.now()), unread: 2),
    );

    expect(find.text('Pilot'), findsOneWidget); // 顶栏
    expect(find.text('小航'), findsOneWidget);
    expect(find.text(tr('主管')), findsOneWidget);
    expect(find.text('今天 3 件事'), findsOneWidget);
    expect(find.text('2'), findsOneWidget, reason: '未读计数');
  });

  testWidgets('没有未读时不画徽标', (t) async {
    await _pump(t);
    expect(find.text('0'), findsNothing);
  });

  testWidgets('未读超过 99 显示 99+', (t) async {
    await _pump(t, preview: const PilotPreview(unread: 120));
    expect(find.text('99+'), findsOneWidget);
  });

  testWidgets('有团队时多一行「我的团队」, 数字是开着的专员 + 1 (自己)', (t) async {
    await _pump(t, team: [_spec('收支'), _spec('家里', on: false)]);

    expect(find.text(tr('我的团队')), findsOneWidget);
    expect(find.text('2'), findsWidgets);
  });

  testWidgets('没团队时不出群行 (不画一个空群)', (t) async {
    await _pump(t);
    expect(find.text(tr('我的团队')), findsNothing);
  });

  testWidgets('专员按「开着的靠前、最近做事的靠前」排; 关着的沉底且淡', (t) async {
    await _pump(t, team: [
      _spec('家里', on: false, lastAt: 9000),
      _spec('收支', lastAt: 1000),
      _spec('日程', lastAt: 5000),
    ]);

    final yShouzhi = t.getTopLeft(find.text('收支')).dy;
    final yRicheng = t.getTopLeft(find.text('日程')).dy;
    final yJiali = t.getTopLeft(find.text('家里')).dy;
    expect(yRicheng, lessThan(yShouzhi));
    expect(yShouzhi, lessThan(yJiali));

    final opacity = t.widget<Opacity>(
      find.ancestor(of: find.text('家里'), matching: find.byType(Opacity)).first,
    );
    expect(opacity.opacity, lessThan(1), reason: '关着的专员要看起来就是不吭声的');
  });

  testWidgets('关着的专员写「关着」, 开着的写最近做了什么', (t) async {
    await _pump(t, team: [
      _spec('收支', on: false),
      _spec('日程', lastAt: 1, summary: '排了明天三个会'),
    ]);
    expect(find.text(tr('关着 · 点开可以打开')), findsOneWidget);
    expect(find.text('排了明天三个会'), findsOneWidget);
  });

  testWidgets('搜索: 只留名字匹配的; 群行名字也算', (t) async {
    await _pump(t, team: [_spec('收支'), _spec('家里')]);

    await t.enterText(find.byType(TextField), '收支');
    await t.pump();
    expect(find.text('收支'), findsNWidgets(2), reason: '一行 + 输入框里的字');
    expect(find.text('小航'), findsNothing);
    expect(find.text('家里'), findsNothing);
    expect(find.text(tr('我的团队')), findsNothing);
  });

  testWidgets('搜索「团队」能找到群行', (t) async {
    await _pump(t, team: [_spec('收支')]);
    await t.enterText(find.byType(TextField), '团队');
    await t.pump();
    expect(find.text(tr('我的团队')), findsOneWidget);
    expect(find.text('收支'), findsNothing);
  });

  testWidgets('什么都没找到时说「没找到」, 不是空白一片', (t) async {
    await _pump(t, team: [_spec('收支')]);
    await t.enterText(find.byType(TextField), 'zzzz');
    await t.pump();
    expect(find.text(tr('没找到')), findsOneWidget);
  });

  testWidgets('点 Pilot 一行进聊天页, 标题是它的名字', (t) async {
    await _pump(t);
    await t.tap(find.text('小航'));
    await t.pump();
    await t.pump(const Duration(milliseconds: 400));

    /* 列表被聊天页盖住了, 顶栏只刺一个「小航」 */
    expect(find.text('小航'), findsOneWidget);
  });

  testWidgets('点专员一行进的是那个专员的窗口', (t) async {
    await _pump(t, team: [_spec('收支', lastAt: 1)]);
    await t.tap(find.text('收支'));
    await t.pump();
    await t.pump(const Duration(milliseconds: 400));

    expect(find.text('收支'), findsOneWidget);
    expect(find.text('小航'), findsNothing);
  });

  testWidgets('无障碍关着时顶部给一条提示; 点它去检查页', (t) async {
    mockKeepAlive(accessibility: false);
    final router = GoRouter(initialLocation: '/pilot', routes: [
      GoRoute(path: '/pilot', builder: (_, __) => PilotInboxPage(pilots: [_pilot])),
      GoRoute(path: '/pilot/keepalive', builder: (_, __) => const Scaffold(body: Text('检查页'))),
    ]);
    await _pump(t, router: router);

    expect(find.text(tr('无障碍被关掉了')), findsOneWidget);
    await t.tap(find.text(tr('无障碍被关掉了')));
    await t.pump();
    await t.pump(const Duration(milliseconds: 100));
    expect(find.text('检查页'), findsOneWidget);
  });

  testWidgets('无障碍开着 / 不知道时不占地方', (t) async {
    mockKeepAlive(accessibility: true);
    await _pump(t);
    expect(find.text(tr('无障碍被关掉了')), findsNothing);
  });

  testWidgets('加人面板: 团队成员能点, 新建 Pilot 说明去电脑上建', (t) async {
    await _pump(t, team: [_spec('收支')]);
    await t.tap(find.byTooltip(tr('加人')));
    await t.pumpAndSettle();

    expect(find.text(tr('加人')), findsWidgets);
    expect(find.text(tr('团队成员')), findsOneWidget);
    expect(find.text(tr('新建一个 Pilot')), findsOneWidget);
    expect(find.text(tr('在电脑上切到 Pilot 模式建，这里会自动出现')), findsOneWidget);
  });

  testWidgets('菜单键拉出侧栏', (t) async {
    await _pump(t);
    await t.tap(find.byTooltip(tr('菜单')));
    await t.pump();
    await t.pump(const Duration(milliseconds: 400));
    expect(find.byType(Drawer), findsOneWidget);

    /* 抽屉里的 ws 控制器排了连接探测, drift 的查询流注销也会排零延时任务;
       卸掉组件并让它们跑完, 否则测试结束时会报 pending timer */
    await t.pumpWidget(const SizedBox.shrink());
    await t.pump(const Duration(seconds: 1));
  });
}
