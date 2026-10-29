/// drawer_session_list_test.dart — 侧栏的「我的电脑 / 最近」列表.
///
/// 用户找不到会话时第一个动作就是拉侧栏。这里钉:
///   - 电脑行的状态 (离线 / 终端在线 / 几个终端)
///   - 会话行的来源签: 同一台电脑上既有终端又有客户端时才标「终端 / 客户端」
///   - 搜索和空状态
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/edition/edition.dart';
import 'package:neox_app/core/i18n/tr.dart';
import 'package:neox_app/core/network/cli_endpoint_id.dart';
import 'package:neox_app/core/storage/database.dart';
import 'package:neox_app/shared/theme/theme_mode_provider.dart';
import 'package:neox_app/shared/widgets/neox_drawer.dart';

import '../support/mobile_test_support.dart';

Future<void> _pumpDrawer(
  WidgetTester t,
  AppDatabase db, {
  Set<String> online = const {},
  NeoxEdition edition = const PilotEdition(),
}) async {
  phoneViewport(t);
  final prefs = await testPrefs();
  await t.pumpWidget(
    ProviderScope(
      overrides: [
        editionProvider.overrideWithValue(edition),
        sharedPreferencesProvider.overrideWithValue(prefs),
        appDatabaseProvider.overrideWithValue(db),
        desktopPresenceProvider.overrideWithValue(FakePresence(online: online)),
      ],
      child: const MaterialApp(
        home: Scaffold(body: NeoxDrawer(here: 'pilot')),
      ),
    ),
  );
  await t.pump();
  await t.pump(const Duration(milliseconds: 20));
}

/// 卸掉侧栏并走完 ws 控制器 / drift 流注销排下的定时器。
Future<void> _close(WidgetTester t) async {
  await t.pumpWidget(const SizedBox.shrink());
  await t.pump(const Duration(seconds: 1));
}

void main() {
  testWidgets('顶部六个目的地都在', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await _pumpDrawer(t, db);

    for (final label in ['对话', '工作', '编码', 'Pilot', '图片', '成品']) {
      expect(find.text(tr(label)), findsOneWidget, reason: '缺入口 $label');
    }
    await _close(t);
  });

  testWidgets('没有 Pilot 的发行版 (开源版): 不出 Pilot 格, 其余五个都在', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await _pumpDrawer(t, db, edition: const OpenEdition());

    expect(find.text('Pilot'), findsNothing);
    for (final label in ['对话', '工作', '编码', '图片', '成品']) {
      expect(find.text(tr(label)), findsOneWidget, reason: '缺入口 $label');
    }
    await _close(t);
  });

  testWidgets('一台电脑都没配: 「我的电脑」下面直接给连一台电脑的入口', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await _pumpDrawer(t, db);

    expect(find.text(tr('我的电脑')), findsOneWidget);
    expect(find.text(tr('连一台电脑')), findsOneWidget);
    expect(find.text(tr('在手机上看电脑上的活、改代码、跑项目')), findsOneWidget);
    await _close(t);
  });

  testWidgets('一台配对的电脑: 写名字和离线状态', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await seedDesktop(db, deviceId: 'mac-1', name: 'MacBook Pro');
    await _pumpDrawer(t, db);

    expect(find.text('MacBook Pro'), findsOneWidget);
    expect(find.textContaining(tr('不在线')), findsOneWidget);
    await _close(t);
  });

  testWidgets('在线电脑写明「在线」', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await seedDesktop(db, deviceId: 'mac-1', name: 'MacBook Pro');
    await _pumpDrawer(t, db, online: {'mac-1'});

    expect(find.text(tr('在线')), findsOneWidget);
    await _close(t);
  });

  testWidgets('只有终端开着 (客户端关着): 这台电脑算在线, 并说几个终端', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await seedDesktop(db, deviceId: 'mac-1', name: 'MacBook Pro');
    await seedSession(
      db,
      id: 'cli-1',
      desktopDeviceId: makeCliEndpointId('mac-1', 'cli:aa'),
      title: '终端里的会',
    );
    await _pumpDrawer(t, db);

    expect(find.text(tr('终端在线') + ' · ' + tr('1 个终端')), findsOneWidget);
    await _close(t);
  });

  testWidgets('超过 3 台电脑: 标题右边给「全部 N ›」', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    for (var i = 0; i < 4; i++) {
      await seedDesktop(db, deviceId: 'mac-$i', name: 'Mac $i');
    }
    await _pumpDrawer(t, db);

    expect(find.text('${tr('全部')} 4 ›'), findsOneWidget);
    /* 最多只画 3 台 */
    expect(find.textContaining('Mac '), findsNWidgets(3));
    await _close(t);
  });

  testWidgets('最近: 会话按标题列出, 最多 5 条', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await seedDesktop(db, deviceId: 'mac-1', name: 'MacBook Pro');
    for (var i = 0; i < 7; i++) {
      await seedSession(db, id: 's$i', title: '任务 $i', lastMessageAt: 1000 + i);
    }
    await _pumpDrawer(t, db);

    expect(find.text(tr('最近')), findsOneWidget);
    for (var i = 2; i < 7; i++) {
      expect(find.text('任务 $i'), findsOneWidget);
    }
    expect(find.text('任务 0'), findsNothing);
    expect(find.text('${tr('全部')} ›'), findsOneWidget);
    await _close(t);
  });

  testWidgets('同一台电脑上终端 + 客户端都有: 两行各带自己的签', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await seedDesktop(db, deviceId: 'mac-1', name: 'MacBook Pro');
    await seedSession(db, id: 'c1', title: '客户端任务', lastMessageAt: 2000);
    await seedSession(
      db,
      id: 't1',
      desktopDeviceId: makeCliEndpointId('mac-1', 'cli:aa'),
      title: '终端任务',
      lastMessageAt: 1000,
    );
    await _pumpDrawer(t, db);

    expect(find.text(tr('终端')), findsOneWidget);
    expect(find.text(tr('客户端')), findsOneWidget);
    await _close(t);
  });

  testWidgets('只有客户端会话: 不标「客户端」, 不多一个字', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await seedDesktop(db, deviceId: 'mac-1', name: 'MacBook Pro');
    await seedSession(db, id: 'c1', title: '客户端任务');
    await _pumpDrawer(t, db);

    expect(find.text(tr('客户端')), findsNothing);
    expect(find.text(tr('终端')), findsNothing);
    await _close(t);
  });

  testWidgets('没名字 / 「新会话」的标题显示成「新会话」占位', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await seedDesktop(db, deviceId: 'mac-1', name: 'MacBook Pro');
    await seedSession(db, id: 'c1', title: '新会话');
    await seedSession(db, id: 'c2', title: null, lastMessageAt: 1);
    await _pumpDrawer(t, db);

    expect(find.text(tr('新会话')), findsNWidgets(2));
    await _close(t);
  });

  testWidgets('一条会话都没有时写「还没有会话」', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await _pumpDrawer(t, db);

    expect(find.text(tr('还没有会话')), findsOneWidget);
    await _close(t);
  });

  testWidgets('搜索: 点搜索框开输入, 按标题筛', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await seedDesktop(db, deviceId: 'mac-1', name: 'MacBook Pro');
    await seedSession(db, id: 's1', title: '改登录页', lastMessageAt: 3);
    await seedSession(db, id: 's2', title: '写周报', lastMessageAt: 2);
    await _pumpDrawer(t, db);

    await t.tap(find.text(tr('搜索任务和对话')));
    await t.pump();
    await t.enterText(find.byType(TextField), '登录');
    await t.pump();

    expect(find.text('改登录页'), findsOneWidget);
    expect(find.text('写周报'), findsNothing);
    expect(find.text('${tr('对话')} · 1'), findsOneWidget);
    await _close(t);
  });

  testWidgets('搜索也能搜工作区名字', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await seedSession(db, id: 's1', title: '改登录页', workspaceName: 'my-app');
    await _pumpDrawer(t, db);

    await t.tap(find.text(tr('搜索任务和对话')));
    await t.pump();
    await t.enterText(find.byType(TextField), 'my-app');
    await t.pump();

    expect(find.text('改登录页'), findsOneWidget);
    await _close(t);
  });

  testWidgets('搜不到: 说「没找到「x」」并建议换个说法', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await seedSession(db, id: 's1', title: '改登录页');
    await _pumpDrawer(t, db);

    await t.tap(find.text(tr('搜索任务和对话')));
    await t.pump();
    await t.enterText(find.byType(TextField), 'zzz');
    await t.pump();

    expect(find.text(tr('没找到「zzz」')), findsOneWidget);
    expect(find.text(tr('换个说法试试')), findsOneWidget);
    await _close(t);
  });

  testWidgets('取消搜索: 回到普通列表', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await seedSession(db, id: 's1', title: '改登录页');
    await _pumpDrawer(t, db);

    await t.tap(find.text(tr('搜索任务和对话')));
    await t.pump();
    await t.tap(find.text(tr('取消')));
    await t.pump();

    expect(find.text(tr('搜索任务和对话')), findsOneWidget);
    expect(find.text('改登录页'), findsOneWidget);
    await _close(t);
  });

  testWidgets('新会话按钮在搜索框右边', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await _pumpDrawer(t, db);
    expect(find.byTooltip(tr('新会话')), findsOneWidget);
    await _close(t);
  });
}
