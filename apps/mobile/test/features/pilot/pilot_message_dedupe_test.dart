/// pilot_message_dedupe_test.dart — live 说了、账本回读又说一遍 (pilot:U-08).
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/pilot/pilot_cloud.dart';
import 'package:neox_app/features/pilot/pilot_chat_view.dart';
import 'package:neox_app/features/pilot/pilot_im.dart';
import 'package:neox_app/features/pilot/pilot_link.dart';

import '../../support/fake_pilot_cloud.dart';
import '../../support/mobile_test_support.dart';

final _pilot = PilotContact.fromJson({'session_id': 's-pilot', 'name': '小航', 'avatar': 'cat'});

/// 推一条 live 事件并让它落到界面上 (流事件在 pump 之后才投递, 要再走一帧)
Future<void> _emit(WidgetTester t, FakePilotCloud cloud, String kind, {String text = ''}) async {
  cloud.emit(kind, text: text);
  await t.pump();
  await t.pump();
}

Future<void> _pump(WidgetTester t, FakePilotCloud cloud) async {
  phoneViewport(t);
  await t.pumpWidget(
    ProviderScope(
      overrides: [pilotCloudProvider.overrideWithValue(cloud)],
      child: MaterialApp(home: Scaffold(body: SafeArea(child: PilotChatView(thread: PilotThread.group(_pilot))))),
    ),
  );
  await t.pump();
  await t.pump(const Duration(milliseconds: 50));
  await t.pump(const Duration(milliseconds: 50));
}

void main() {
  testWidgets('这一轮说完, 账本再回读: 那句话只有一个气泡', (t) async {
    final live = StreamController<PilotLive>();
    addTearDown(live.close);
    final cloud = FakePilotCloud(liveController: live);
    await _pump(t, cloud);

    /* live: 说一段, 收成一个气泡 */
    await _emit(t, cloud, 'delta', text: '今天三件事：开会、交周报、买牛奶');
    await _emit(t, cloud, 'segment');
    expect(find.text('今天三件事：开会、交周报、买牛奶'), findsOneWidget);

    /* 这一轮结束: 群窗口会重拉账本, 账本里也有同一句 */
    cloud.messagesRows = [
      {
        'id': 11,
        'role': 'assistant',
        'text': '今天三件事：开会、交周报、买牛奶',
        'at': DateTime.now().millisecondsSinceEpoch,
      },
    ];
    await _emit(t, cloud, 'done');
    await t.pump(const Duration(milliseconds: 80));
    await t.pump(const Duration(milliseconds: 80));

    expect(find.text('今天三件事：开会、交周报、买牛奶'), findsOneWidget, reason: '不能出现两个一样的气泡');
  });
}
