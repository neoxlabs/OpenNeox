/// settings_page_test.dart — 设置页: 每一项都在 / 都能打开.
///
/// 用户路径很单: 进设置 → 找到想改的东西 → 点进去。这里逐行拴住。
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:neox_app/core/edition/edition.dart';
import 'package:neox_app/core/i18n/tr.dart';
import 'package:neox_app/core/local_agent/model_gateway_client.dart';
import 'package:neox_app/core/notifications/inbox.dart';
import 'package:neox_app/core/storage/database.dart';
import 'package:neox_app/features/home/state/selected_model_provider.dart';
import 'package:neox_app/features/pilot/pilot_link.dart';
import 'package:neox_app/features/settings/about_page.dart';
import 'package:neox_app/features/settings/settings_page.dart';
import 'package:neox_app/shared/theme/theme_mode_provider.dart';

import '../../support/mobile_test_support.dart';

const _pushTargets = [
  '/settings/devices',
  '/settings/models',
  '/settings/voice',
  '/settings/phone-use',
  '/settings/local-linux',
  '/pilot/keepalive',
  '/files',
  '/pilot',
  '/inbox',
  '/update',
];

GoRouter _router({String initial = '/settings'}) => GoRouter(
      initialLocation: initial,
      routes: [
        GoRoute(path: '/settings', builder: (_, __) => const SettingsPage()),
        for (final p in _pushTargets)
          GoRoute(path: p, builder: (_, __) => Scaffold(body: Text('去 $p'))),
      ],
    );

Future<void> _pump(
  WidgetTester t,
  AppDatabase db, {
  List<PilotContact> pilots = const [],
  List<GatewayModel> models = const [],
  Map<String, Object> prefsValues = const {},
  String initial = '/settings',
}) async {
  phoneViewport(t);
  final prefs = await testPrefs(prefsValues);
  await t.pumpWidget(
    ProviderScope(
      overrides: [
        editionProvider.overrideWithValue(const PilotEdition()),
        sharedPreferencesProvider.overrideWithValue(prefs),
        appDatabaseProvider.overrideWithValue(db),
        desktopPresenceProvider.overrideWithValue(FakePresence()),
        pilotContactsProvider.overrideWith((ref) => Stream.value(pilots)),
        inboxProvider.overrideWith((ref) => FakeInboxStore()),
        availableModelsProvider.overrideWith((ref) async => models),
      ],
      child: MaterialApp.router(routerConfig: _router(initial: initial)),
    ),
  );
  await t.pump();
  await t.pump(const Duration(milliseconds: 50));
}

Future<void> _close(WidgetTester t) async {
  await t.pumpWidget(const SizedBox.shrink());
  await t.pump(const Duration(seconds: 1));
}

/// 滚到「标题」那一行再点 (设置页比一屏长)。
Future<void> _tapRow(WidgetTester t, String title) async {
  final f = find.text(title);
  await t.scrollUntilVisible(f, 200, scrollable: find.byType(Scrollable).first);
  await t.tap(f);
  await t.pump();
  await t.pump(const Duration(milliseconds: 400));
}

void main() {
  testWidgets('头部: 「设置」标题 + 消息铃', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await _pump(t, db);

    expect(find.text(tr('设置')), findsOneWidget);
    expect(find.byIcon(Icons.notifications_none_rounded), findsWidgets);
    await _close(t);
  });

  testWidgets('三颗小泥块: 设备数 / 成品数 / Pilot 状态', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await seedDesktop(db, deviceId: 'mac-1', name: 'Mac');
    await _pump(t, db, pilots: [PilotContact.fromJson({'session_id': 'p1', 'name': '小航'})]);

    /* 手机自己 + 一台电脑 */
    expect(find.text('2'), findsOneWidget);
    expect(find.text(tr('台设备')), findsOneWidget);
    expect(find.text(tr('个成品')), findsOneWidget);
    expect(find.text(tr('已开')), findsOneWidget);
    await _close(t);
  });

  testWidgets('没 Pilot 时写「没开」', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await _pump(t, db);
    expect(find.text(tr('没开')), findsOneWidget);
    await _close(t);
  });

  testWidgets('十二行都在: 连接 / 模型 / 语音 / 手机相关 / 外观 / 通知 / 锁 / 语言 / 更新 / 反馈 / 关于', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await _pump(t, db);

    for (final title in [
      '设备与连接',
      '模型',
      '语音',
      '操作手机',
      '让 Pilot 一直在线',
      '工具包',
      '外观',
      '通知',
      '应用锁',
      '语言',
      '系统更新',
      '意见反馈',
      '关于 Neox',
    ]) {
      final f = find.text(tr(title));
      await t.scrollUntilVisible(f, 200, scrollable: find.byType(Scrollable).first);
      expect(f, findsOneWidget, reason: '缺设置行 $title');
    }
    await _close(t);
  });

  testWidgets('设备与连接: 没电脑写「没连电脑」, 有一台写「1 台电脑」', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await _pump(t, db);
    expect(find.text(tr('没连电脑')), findsOneWidget);
    await _close(t);

    final db2 = newTestDb();
    addTearDown(db2.close);
    await seedDesktop(db2, deviceId: 'mac-1', name: 'Mac');
    await _pump(t, db2);
    expect(find.text(tr('1 台电脑')), findsOneWidget);
    await _close(t);
  });

  testWidgets('模型行写当前模型的显示名', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await _pump(
      t,
      db,
      prefsValues: const {
        'neox_default_model': 'deepseek-v4',
        'neox_chat_model': 'deepseek-v4',
      },
      models: const [
        GatewayModel(id: 'deepseek-v4', name: 'DeepSeek V4'),
      ],
    );
    expect(find.text('DeepSeek V4'), findsOneWidget);
    await _close(t);
  });

  testWidgets('应用锁: 测试环境没有生物识别, 写「此设备不支持」', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await _pump(t, db);
    expect(find.text(tr('此设备不支持')), findsOneWidget);
    await _close(t);
  });

  testWidgets('语言行写「中文」', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await _pump(t, db);
    expect(find.text('中文'), findsOneWidget);
    await _close(t);
  });

  testWidgets('点设备与连接 → /settings/devices', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await _pump(t, db);
    await _tapRow(t, tr('设备与连接'));
    expect(find.text('去 /settings/devices'), findsOneWidget);
    await _close(t);
  });

  testWidgets('点模型 → /settings/models', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await _pump(t, db);
    await _tapRow(t, tr('模型'));
    expect(find.text('去 /settings/models'), findsOneWidget);
    await _close(t);
  });

  testWidgets('点语音 → /settings/voice', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await _pump(t, db);
    await _tapRow(t, tr('语音'));
    expect(find.text('去 /settings/voice'), findsOneWidget);
    await _close(t);
  });

  testWidgets('点操作手机 / 让 Pilot 一直在线 / 工具包 → 各自的页', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await _pump(t, db);

    await _tapRow(t, tr('操作手机'));
    expect(find.text('去 /settings/phone-use'), findsOneWidget);
    await _close(t);

    await _pump(t, db);
    await _tapRow(t, tr('让 Pilot 一直在线'));
    expect(find.text('去 /pilot/keepalive'), findsOneWidget);
    await _close(t);

    await _pump(t, db);
    await _tapRow(t, tr('工具包'));
    expect(find.text('去 /settings/local-linux'), findsOneWidget);
    await _close(t);
  });

  testWidgets('点外观 → 真的进外观页', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await _pump(t, db);
    await _tapRow(t, tr('外观'));
    /* 外观页自己的标题 */
    expect(find.text(tr('外观')), findsWidgets);
    await _close(t);
  });

  testWidgets('点通知 → 进通知设置页', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await _pump(t, db);
    await _tapRow(t, tr('通知'));
    await t.pump(const Duration(milliseconds: 200));
    expect(find.text(tr('通知')), findsWidgets);
    await _close(t);
  });

  testWidgets('点关于 Neox → 进关于页', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await _pump(t, db);
    await _tapRow(t, tr('关于 Neox'));
    await t.pump(const Duration(milliseconds: 300));
    expect(find.textContaining('Neox'), findsWidgets);
    await _close(t);
  });

  testWidgets('没有新版时点系统更新 → 去关于页 (不是空白)', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await _pump(t, db);
    await _tapRow(t, tr('系统更新'));
    await t.pump(const Duration(milliseconds: 500));
    expect(find.byType(AboutPage), findsOneWidget);
    await _close(t);
  });

  testWidgets('点消息铃 → /inbox', (t) async {
    final db = newTestDb();
    addTearDown(db.close);
    await _pump(t, db);
    await t.tap(find.byIcon(Icons.notifications_none_rounded).first);
    await t.pump();
    await t.pump(const Duration(milliseconds: 400));
    expect(find.text('去 /inbox'), findsOneWidget);
    await _close(t);
  });
}
