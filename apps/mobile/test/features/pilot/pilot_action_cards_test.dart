/// pilot_action_cards_test.dart — 动作卡: 置顶等你点, 批准后原地变结果 (pilot:U-06).
///
/// 验收: 卡固定顶部; 批准后 5 秒内变结果 (轮询 3 秒)。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/i18n/tr.dart';
import 'package:neox_app/core/pilot/pilot_cloud.dart';
import 'package:neox_app/features/pilot/pilot_action_cards.dart';
import 'package:neox_app/features/pilot/pilot_chat_view.dart';
import 'package:neox_app/features/pilot/pilot_im.dart';
import 'package:neox_app/features/pilot/pilot_link.dart';

import '../../support/fake_pilot_cloud.dart';
import '../../support/mobile_test_support.dart';

Map<String, dynamic> _card({String state = 'pending', String result = ''}) => {
      'id': 'c1',
      'title': '发短信给妈妈',
      'summary': '今天回家吃饭吗',
      'options': ['批准', '不要'],
      'actionState': state,
      'actionResult': result,
      'action': {'action': 'send_sms', 'preview': '今天回家吃饭吗'},
    };

Future<void> _pump(WidgetTester t, FakePilotCloud cloud) async {
  phoneViewport(t);
  await t.pumpWidget(
    ProviderScope(
      overrides: [pilotCloudProvider.overrideWithValue(cloud)],
      child: const MaterialApp(home: Scaffold(body: PilotActionCards(pilotId: 's-pilot'))),
    ),
  );
  await t.pump();
  await t.pump(const Duration(milliseconds: 50));
}

void main() {
  testWidgets('等你点的卡: 标题 + 正文 + 批准 / 不要', (t) async {
    final cloud = FakePilotCloud(actionsByState: {
      'pending': [_card()],
      'approved': [],
    });
    await _pump(t, cloud);

    expect(find.text('发短信给妈妈'), findsOneWidget);
    expect(find.text('今天回家吃饭吗'), findsOneWidget);
    expect(find.text(tr('批准')), findsOneWidget);
    expect(find.text(tr('不要')), findsOneWidget);
  });

  testWidgets('批准 → 正在办 → 原地变结果, 几秒后收走', (t) async {
    final cloud = FakePilotCloud(actionsByState: {
      'pending': [_card()],
      'approved': [],
    });
    await _pump(t, cloud);

    await t.tap(find.text(tr('批准')));
    await t.pump();
    expect(cloud.answers.single.id, 'c1');
    expect(cloud.answers.single.answer, '批准');

    /* 云端把它挪到 approved: 3 秒轮询内变成「正在办…」 */
    cloud.actionsByState = {
      'pending': [],
      'approved': [_card(state: 'approved')],
    };
    await t.pump(const Duration(seconds: 3));
    expect(find.text(tr('正在办…')), findsOneWidget);

    /* 办完: 卡原地换成结果 (不再消失) */
    cloud.actionsByState = {
      'pending': [],
      'approved': [],
      'done': [_card(state: 'done', result: '已发送（1 条）')],
    };
    await t.pump(const Duration(seconds: 3));
    expect(find.text(tr('办好了')), findsOneWidget);
    expect(find.text('已发送（1 条）'), findsOneWidget);
    expect(find.text('发短信给妈妈'), findsOneWidget);

    /* 停一会儿自己收走 */
    await t.pump(const Duration(seconds: 7));
    expect(find.text(tr('办好了')), findsNothing);
  });

  testWidgets('卡钉在对话顶上: 不在滚动列表里, 列表滚了它还在', (t) async {
    phoneViewport(t);
    final now = DateTime.now().millisecondsSinceEpoch;
    final cloud = FakePilotCloud(
      actionsByState: {
        'pending': [_card()],
      },
      messagesRows: [
        for (var i = 0; i < 30; i++)
          {'id': i + 1, 'role': i.isEven ? 'user' : 'assistant', 'text': '第 $i 条', 'at': now - (30 - i) * 60000},
      ],
    );
    final pilot = PilotContact.fromJson({'session_id': 's-pilot', 'name': '小航', 'avatar': 'cat'});
    await t.pumpWidget(
      ProviderScope(
        overrides: [pilotCloudProvider.overrideWithValue(cloud)],
        child: MaterialApp(
          home: Scaffold(body: SafeArea(child: PilotChatView(thread: PilotThread.direct(pilot)))),
        ),
      ),
    );
    await t.pump();
    await t.pump(const Duration(milliseconds: 50));
    await t.pump(const Duration(milliseconds: 50));

    expect(find.text('发短信给妈妈'), findsOneWidget);
    expect(find.ancestor(of: find.text('发短信给妈妈'), matching: find.byType(ListView)), findsNothing,
        reason: '卡在列表外, 不跟着消息滚');

    await t.drag(find.byType(ListView), const Offset(0, -600));
    await t.pump();
    expect(find.text('发短信给妈妈'), findsOneWidget);
    expect(find.text(tr('批准')), findsOneWidget);
  });

  testWidgets('没办成: 显示失败, 不冒充成功', (t) async {
    final cloud = FakePilotCloud(actionsByState: {
      'pending': [],
      'approved': [_card(state: 'approved')],
    });
    await _pump(t, cloud);
    await t.pump(const Duration(seconds: 3));

    cloud.actionsByState = {
      'pending': [],
      'approved': [],
      'failed': [_card(state: 'failed', result: '手机没连上')],
    };
    await t.pump(const Duration(seconds: 3));

    expect(find.text(tr('没办成')), findsOneWidget);
    expect(find.text('手机没连上'), findsOneWidget);
    expect(find.text(tr('办好了')), findsNothing);
  });
}
