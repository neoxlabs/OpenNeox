/// pilot_stop_freeze_test.dart — 点停止立刻冻结打字机 (pilot:U-07).
///
/// 验收: 停止后 200ms 内无新字, 显示已停。interrupt 还卡在网络上时也不能再长字。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/i18n/tr.dart';
import 'package:neox_app/core/pilot/pilot_cloud.dart';
import 'package:neox_app/features/pilot/pilot_chat_view.dart';
import 'package:neox_app/features/pilot/pilot_im.dart';
import 'package:neox_app/features/pilot/pilot_link.dart';

import '../../support/fake_pilot_cloud.dart';
import '../../support/mobile_test_support.dart';

final _pilot = PilotContact.fromJson({'session_id': 's-pilot', 'name': '小航', 'avatar': 'cat', 'persona': '你的生活助理'});

/// 推一条 live 事件并让它落到界面上 (流事件在 pump 之后才投递, 要再走一帧)
Future<void> _emit(WidgetTester t, FakePilotCloud cloud, String kind, {String text = '', String? step}) async {
  cloud.emit(kind, text: text, step: step);
  await t.pump();
  await t.pump();
}

Future<void> _pump(WidgetTester t, FakePilotCloud cloud) async {
  phoneViewport(t);
  await t.pumpWidget(
    ProviderScope(
      overrides: [pilotCloudProvider.overrideWithValue(cloud)],
      child: MaterialApp(home: Scaffold(body: SafeArea(child: PilotChatView(thread: PilotThread.direct(_pilot))))),
    ),
  );
  await t.pump();
  await t.pump(const Duration(milliseconds: 50));
  await t.pump(const Duration(milliseconds: 50));
}

void main() {
  testWidgets('停止后 100ms 内不再长字, 并显示「已停」', (t) async {
    final live = StreamController<PilotLive>();
    addTearDown(live.close);
    final gate = Completer<void>();
    final cloud = FakePilotCloud(liveController: live, interruptGate: gate);
    await _pump(t, cloud);

    expect(live.hasListener, isTrue, reason: '聊天视图应当已经订阅 live');
    await _emit(t, cloud, 'delta', text: '今天有三件事');
    expect(find.text('今天有三件事'), findsOneWidget);

    await t.tap(find.byTooltip(tr('让它停下')));
    await t.pump();
    expect(find.text(tr('已停')), findsOneWidget);
    expect(cloud.interrupts, ['s-pilot']);

    /* interrupt 还卡着, 云端却还在推字: 屏幕不能跟着长 */
    await _emit(t, cloud, 'delta', text: '还有很多要说的');
    await _emit(t, cloud, 'segment');
    await t.pump(const Duration(milliseconds: 100));
    expect(find.textContaining('还有很多要说的'), findsNothing);
    expect(find.text('今天有三件事'), findsOneWidget);
    expect(find.text(tr('已停')), findsOneWidget);

    gate.complete();
    await t.pump();
    expect(find.text(tr('已停')), findsOneWidget);
  });

  testWidgets('停的这一轮收尾后, 云端自己开新一轮: 解冻并显示增量', (t) async {
    final live = StreamController<PilotLive>();
    addTearDown(live.close);
    final cloud = FakePilotCloud(liveController: live, handleInterrupt: true);
    await _pump(t, cloud);

    await _emit(t, cloud, 'delta', text: '第一轮说到一半');
    await t.tap(find.byTooltip(tr('让它停下')));
    await t.pump();
    expect(find.text(tr('已停')), findsOneWidget);

    /* 这一轮还没收尾: 就算又来 busy / step 也不能解冻 (打断还在路上) */
    await _emit(t, cloud, 'busy');
    await _emit(t, cloud, 'step', step: '查记录');
    await _emit(t, cloud, 'delta', text: '同一轮剩下的字');
    expect(find.textContaining('同一轮剩下的字'), findsNothing);
    expect(find.text(tr('已停')), findsOneWidget);

    /* 这一轮收尾: 仍然停着, 等云端的下一轮 */
    await _emit(t, cloud, 'done');
    expect(find.textContaining('同一轮剩下的字'), findsNothing);
    expect(find.text(tr('已停')), findsOneWidget);

    /* 云端自己开了新一轮 (busy): 解冻, 增量照常显示 */
    await _emit(t, cloud, 'busy');
    await _emit(t, cloud, 'delta', text: '新的一轮开始说');
    expect(find.text(tr('已停')), findsNothing);
    expect(find.text('新的一轮开始说'), findsOneWidget);

    await _emit(t, cloud, 'segment');
    expect(find.text('新的一轮开始说'), findsOneWidget);
  });

  testWidgets('新一轮是 step 开的头: 同样解冻', (t) async {
    final live = StreamController<PilotLive>();
    addTearDown(live.close);
    final cloud = FakePilotCloud(liveController: live, handleInterrupt: true);
    await _pump(t, cloud);

    await _emit(t, cloud, 'delta', text: '先说到这里');
    await t.tap(find.byTooltip(tr('让它停下')));
    await t.pump();
    await _emit(t, cloud, 'done');
    expect(find.text(tr('已停')), findsOneWidget);

    await _emit(t, cloud, 'step', step: '查记录');
    expect(find.text(tr('已停')), findsNothing);
    await _emit(t, cloud, 'delta', text: '接着上一句说');
    expect(find.text('接着上一句说'), findsOneWidget);
  });

  testWidgets('停下时手上这段字定格成一个气泡, 不丢', (t) async {
    final live = StreamController<PilotLive>();
    addTearDown(live.close);
    final cloud = FakePilotCloud(liveController: live, handleInterrupt: true);
    await _pump(t, cloud);

    await _emit(t, cloud, 'delta', text: '我先说一半');
    await t.tap(find.byTooltip(tr('让它停下')));
    await t.pump();

    expect(find.text('我先说一半'), findsOneWidget);
    expect(find.text(tr('已停')), findsOneWidget);
  });
}
