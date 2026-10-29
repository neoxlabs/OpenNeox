/// pilot_node_status_card_test.dart — 连接页顶部这块「这台手机」(pilot:D-18)。
///
/// 钉: 没连上 / 在线 / 心跳停了三种状态各显示什么, 最近动作有没有说人话。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/pilot/pilot_node_status.dart';
import 'package:neox_app/features/pilot/pilot_node_status_card.dart';

Future<ProviderContainer> _pump(WidgetTester t) async {
  final c = ProviderContainer();
  addTearDown(c.dispose);
  await t.pumpWidget(UncontrolledProviderScope(
    container: c,
    child: const MaterialApp(home: Scaffold(body: PilotNodeStatusCard())),
  ));
  return c;
}

void main() {
  testWidgets('还没连过: 说没连上, 不编一条动作', (t) async {
    await _pump(t);

    expect(find.text('这台手机'), findsOneWidget);
    expect(find.text('跟它的连接'), findsOneWidget);
    expect(find.text('没连上'), findsOneWidget);
    expect(find.text('还没连上过'), findsOneWidget);
    expect(find.text('最近替它办的事'), findsOneWidget);
    expect(find.text('还没替它办过事'), findsOneWidget);

    await t.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('连着 + 刚心跳过 + 刚办完一件事', (t) async {
    final c = await _pump(t);
    c.read(pilotNodeStatusProvider.notifier)
      ..markConnected(true)
      ..markBeat()
      ..markAction('set_alarm');
    await t.pump();

    expect(find.text('在线'), findsOneWidget);
    expect(find.text('心跳正常 · 刚刚'), findsOneWidget);
    expect(find.text('定闹钟 · 刚刚'), findsOneWidget);

    await t.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('连着但两拍没心跳: 标心跳停了, 动作没办成也写出来', (t) async {
    final c = await _pump(t);
    final stale = DateTime.now().subtract(const Duration(minutes: 5));
    c.read(pilotNodeStatusProvider.notifier)
      ..markConnected(true)
      ..markBeat(stale)
      ..markAction('phone_ui', ok: false, at: stale);
    await t.pump();

    expect(find.text('心跳停了'), findsOneWidget);
    expect(find.text('心跳停在 5 分钟前'), findsOneWidget);
    expect(find.text('操作手机 · 5 分钟前 · 没办成'), findsOneWidget);

    await t.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('断开后仍能看到上次报到与最近动作', (t) async {
    final c = await _pump(t);
    c.read(pilotNodeStatusProvider.notifier)
      ..markConnected(true)
      ..markBeat()
      ..markAction('camera');
    c.read(pilotNodeStatusProvider.notifier).markConnected(false);
    await t.pump();

    expect(find.text('没连上'), findsOneWidget);
    expect(find.text('上次报到 刚刚'), findsOneWidget);
    expect(find.text('拍照 · 刚刚'), findsOneWidget);

    await t.pumpWidget(const SizedBox.shrink());
  });
}
