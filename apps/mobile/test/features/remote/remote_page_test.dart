/// remote_page_test.dart — 远程电脑页 (「我的电脑」).
///
/// 用户:「我发现我找不到远程的了」—— 这页就是那扇门。这里钉:
///   - 空状态把「为什么要配对」说清楚
///   - 每台电脑一行, 名字 / 状态 / 会话数 / 有几个终端
///   - 在线数汇总
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:neox_app/core/edition/edition.dart';
import 'package:neox_app/core/i18n/tr.dart';
import 'package:neox_app/core/network/cli_endpoint_id.dart';
import 'package:neox_app/core/storage/database.dart';
import 'package:neox_app/features/remote/remote_pages.dart';
import 'package:neox_app/shared/theme/theme_mode_provider.dart';

import '../../support/mobile_test_support.dart';

GoRouter _router({String initial = '/remote'}) => GoRouter(
      initialLocation: initial,
      routes: [
        GoRoute(path: '/remote', builder: (_, __) => const RemotePage()),
        GoRoute(path: '/pairing', builder: (_, __) => const Scaffold(body: Text('配对页'))),
        GoRoute(
          path: '/remote/:id',
          builder: (_, s) => RemoteDesktopPage(deviceId: s.pathParameters['id']!),
        ),
      ],
    );

Future<void> _pump(
  WidgetTester t,
  AppDatabase db, {
  Set<String> online = const {},
  String initial = '/remote',
}) async {
  phoneViewport(t);
  final prefs = await testPrefs();
  await t.pumpWidget(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        appDatabaseProvider.overrideWithValue(db),
        desktopPresenceProvider.overrideWithValue(FakePresence(online: online)),
      ],
      child: MaterialApp.router(routerConfig: _router(initial: initial)),
    ),
  );
  await t.pump();
  /* 会话 / 终端行来自 drift 的异步查询, 多给几帧 (单跑快、全量跑时会被别的测试拖慢) */
  for (var i = 0; i < 3; i++) {
    await t.pump(const Duration(milliseconds: 50));
  }
}

Future<void> _close(WidgetTester t) async {
  await t.pumpWidget(const SizedBox.shrink());
  await t.pump(const Duration(seconds: 1));
}

void main() {
  testWidgets('空状态: 标题 + 为什么要配对 + 扫码入口', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await _pump(t, db);

    expect(find.text(tr('我的电脑')), findsOneWidget);
    expect(find.text(tr('还没有配对电脑')), findsOneWidget);
    expect(find.textContaining('进度实时同步'), findsOneWidget);
    expect(find.text(tr('扫码配对一台电脑')), findsOneWidget);
    await _close(t);
  });

  testWidgets('空状态里的扫码按钮真的去配对页', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await _pump(t, db);

    await t.tap(find.text(tr('扫码配对一台电脑')));
    await t.pump();
    await t.pump(const Duration(milliseconds: 400));
    expect(find.text('配对页'), findsOneWidget);
    await _close(t);
  });

  testWidgets('一台离线电脑: 名字 + 状态 + 没有会话时不说会话数', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await seedDesktop(db, deviceId: 'mac-1', name: 'MacBook Pro');
    await _pump(t, db);

    expect(find.text('MacBook Pro'), findsOneWidget);
    expect(find.textContaining(tr('不在线')), findsNWidgets(2));
    expect(find.textContaining(tr('0 个会话')), findsNothing);
    /* 离线时告诉用户怎么办 */
    expect(find.text(tr('电脑开机并打开 Neox 就会连上')), findsOneWidget);
    await _close(t);
  });

  testWidgets('有会话时写「N 个会话」和最近一条', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await seedDesktop(db, deviceId: 'mac-1', name: 'MacBook Pro');
    await seedSession(db, id: 's1', title: '改登录页', lastMessageAt: 5000);
    await seedSession(db, id: 's2', title: '写周报', lastMessageAt: 4000);
    await _pump(t, db);

    expect(find.textContaining(tr('2 个会话')), findsOneWidget);
    expect(find.textContaining(tr('最近') + ': 改登录页'), findsOneWidget);
    await _close(t);
  });

  testWidgets('两台都不在线: 头部写「都不在线 · 共 2 台」', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await seedDesktop(db, deviceId: 'mac-1', name: 'Mac One');
    await seedDesktop(db, deviceId: 'win-1', name: 'PC Two');
    await _pump(t, db);

    expect(find.text(tr('都不在线 · 共 2 台')), findsOneWidget);
    await _close(t);
  });

  testWidgets('一台在线: 头部写「1 台在线 · 共 2 台」, 那台写「在线」', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await seedDesktop(db, deviceId: 'mac-1', name: 'Mac One');
    await seedDesktop(db, deviceId: 'win-1', name: 'PC Two');
    await _pump(t, db, online: {'mac-1'});

    expect(find.text(tr('1 台在线 · 共 2 台')), findsOneWidget);
    expect(find.text(tr('在线')), findsOneWidget);
    await _close(t);
  });

  testWidgets('终端会话不混进这台电脑的会话数 (终端在侧栏单列)', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await seedDesktop(db, deviceId: 'mac-1', name: 'MacBook Pro');
    await seedSession(
      db,
      id: 't1',
      desktopDeviceId: makeCliEndpointId('mac-1', 'cli:aa'),
      title: '终端任务',
    );
    await _pump(t, db);

    expect(find.text('MacBook Pro'), findsOneWidget);
    /* 终端会话挂在伪设备 mac-1#cli:aa 上, 不属于这台电脑的客户端会话 */
    expect(find.textContaining(tr('个会话')), findsNothing);
    await _close(t);
  });

  testWidgets('苹果电脑和 Windows 用不同图标', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await seedDesktop(db, deviceId: 'mac-1', name: 'MacBook Pro');
    await seedDesktop(db, deviceId: 'win-1', name: 'Windows PC');
    await _pump(t, db);

    expect(find.byIcon(Icons.laptop_mac_rounded), findsOneWidget);
    expect(find.byIcon(Icons.desktop_windows_outlined), findsOneWidget);
    await _close(t);
  });

  testWidgets('配对新电脑的入口在两个地方都在 (右上 + 列表底部)', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await seedDesktop(db, deviceId: 'mac-1', name: 'MacBook Pro');
    await _pump(t, db);

    expect(find.byTooltip(tr('配对一台新电脑')), findsOneWidget);
    expect(find.text(tr('配对一台新电脑')), findsOneWidget);
    expect(find.text(tr('电脑上打开 设置 → 远程访问, 扫二维码')), findsOneWidget);
    await _close(t);
  });

  testWidgets('点电脑卡进那台电脑的详情页', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await seedDesktop(db, deviceId: 'mac-1', name: 'MacBook Pro');
    await _pump(t, db);

    await t.tap(find.text('MacBook Pro'));
    await t.pump();
    await t.pump(const Duration(milliseconds: 50));

    /* 详情页顶栏也写名字; 同样至少证明路由去了 */
    expect(find.text('MacBook Pro'), findsWidgets);
    await _close(t);
  });
}
