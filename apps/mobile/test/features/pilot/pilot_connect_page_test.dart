/// pilot_connect_page_test.dart — 手机「连接」页 (pilot:D-18)。
///
/// 只钉新增的那一块: 有云端实现时页面上有「这台手机 / 跟它的连接 / 最近替它办的事」,
/// 没有云端实现的版本不画 (否则永远显示「没连上」, 像故障)。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:neox_app/core/pilot/pilot_cloud.dart';
import 'package:neox_app/core/pilot/pilot_node_status.dart';
import 'package:neox_app/features/pilot/pilot_connect_page.dart';

/// 连接页只读这个对象非空与否; 真的云端实现要网络, 测试里不碰。
class _FakeCloud implements PilotCloud {
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Future<void> _pump(WidgetTester t, {PilotCloud? cloud}) async {
  SharedPreferences.setMockInitialValues({});
  final c = ProviderContainer(overrides: [pilotCloudProvider.overrideWithValue(cloud)]);
  addTearDown(c.dispose);
  await t.pumpWidget(UncontrolledProviderScope(container: c, child: const MaterialApp(home: PilotConnectPage())));
  await t.pump();
  await t.pump(const Duration(milliseconds: 50));
}

void main() {
  testWidgets('有云端: 顶部显示连接状态和最近一条动作', (t) async {
    final c = ProviderContainer(overrides: [pilotCloudProvider.overrideWithValue(_FakeCloud())]);
    addTearDown(c.dispose);
    c.read(pilotNodeStatusProvider.notifier)
      ..markConnected(true)
      ..markBeat()
      ..markAction('phone_call');

    SharedPreferences.setMockInitialValues({});
    await t.pumpWidget(UncontrolledProviderScope(container: c, child: const MaterialApp(home: PilotConnectPage())));
    await t.pump();
    await t.pump(const Duration(milliseconds: 50));

    expect(find.text('这台手机'), findsOneWidget);
    expect(find.text('跟它的连接'), findsOneWidget);
    expect(find.text('在线'), findsOneWidget);
    expect(find.text('打电话 · 刚刚'), findsOneWidget);
    /* 原来的权限区还在, 没有被挤掉 */
    expect(find.text('给它看的'), findsOneWidget);

    await t.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('没有云端实现: 不画这块', (t) async {
    await _pump(t);
    expect(find.text('这台手机'), findsNothing);
    expect(find.text('跟它的连接'), findsNothing);
    expect(find.text('给它看的'), findsOneWidget);
  });
}
