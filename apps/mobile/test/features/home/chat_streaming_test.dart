/// chat_streaming_test.dart — 首页聊天: 发出去的话 + 流进来的回答.
///
/// 流式渲染是用户盯着看的那一屏。这里用内存 timeline 驱动器把
/// 「一个字一个字进来」真的跑一遍; 用户那句话用真的 MessageRow 渲一遍。
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/storage/database.dart';
import 'package:neox_app/features/timeline/state/timeline_state.dart';
import 'package:neox_app/features/timeline/widgets/message_row.dart';
import 'package:neox_app/features/timeline/widgets/timeline_message_list.dart';
import 'package:neox_app/features/timeline/widgets/typing_dots.dart';
import 'package:neox_app/shared/theme/theme_mode_provider.dart';

import '../../support/mobile_test_support.dart';

const _sid = 'phone-test-session';

Future<ProviderContainer> _pump(
  WidgetTester t, {
  String? optimisticText,
}) async {
  phoneViewport(t);
  final prefs = await testPrefs();
  final db = newTestDb();
  addTearDown(db.close);
  final container = ProviderContainer(overrides: [
    sharedPreferencesProvider.overrideWithValue(prefs),
    appDatabaseProvider.overrideWithValue(db),
    timelineStateProvider(_sid).overrideWith((ref) => TimelineStateController.ephemeral(ref, _sid)),
  ]);
  addTearDown(container.dispose);
  await t.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        home: Scaffold(
          body: TimelineMessageList(sessionId: _sid, optimisticUserText: optimisticText),
        ),
      ),
    ),
  );
  await t.pump();
  await t.pump(const Duration(milliseconds: 20));
  return container;
}

Future<void> _delta(WidgetTester t, ProviderContainer c, String chunk) async {
  c.read(timelineStateProvider(_sid).notifier).applyStreaming('agent_text_delta', {
    'turn_id': 't1',
    'content': chunk,
  });
  await _frames(t);
}

/// 打字机每帧只吐几个字, 得给它几帧; 顺便把 32ms 的 flush 防抖跑完.
Future<void> _frames(WidgetTester t) async {
  for (var i = 0; i < 12; i++) {
    await t.pump(const Duration(milliseconds: 20));
  }
}

Future<void> _unmount(WidgetTester t) async {
  await t.pumpWidget(const SizedBox.shrink());
  await t.pump(const Duration(milliseconds: 300));
}

SessionEvent _ev(int seq, String kind, Map<String, dynamic> payload) => SessionEvent(
      sessionId: _sid,
      seq: seq,
      ts: DateTime.now().millisecondsSinceEpoch,
      kind: kind,
      payload: jsonEncode(payload),
    );

Future<void> _pumpRow(WidgetTester t, SessionEvent ev) async {
  phoneViewport(t);
  await t.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: ListView(children: [MessageRow(item: TimelineItem.single(ev))]),
      ),
    ),
  );
  await t.pump();
}

void main() {
  testWidgets('空会话: 不是空白, 给一句「想聊什么都行」', (t) async {
    await _pump(t);
    expect(find.text('想聊什么都行'), findsOneWidget);
  });

  testWidgets('自己发的话以用户气泡出现 (真 MessageRow)', (t) async {
    await _pumpRow(t, _ev(1, 'user_message', {'text': '帮我改下登录页'}));
    expect(find.text('帮我改下登录页'), findsOneWidget);
  });

  testWidgets('自己的话和回答能同时看到', (t) async {
    phoneViewport(t);
    await t.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ListView(
            children: [
              MessageRow(item: TimelineItem.single(_ev(1, 'user_message', {'text': '改登录页'}))),
              MessageRow(item: TimelineItem.single(_ev(2, 'agent_text', {'text': '改好了'}))),
            ],
          ),
        ),
      ),
    );
    await t.pump();
    expect(find.text('改登录页'), findsOneWidget);
    expect(find.text('改好了'), findsOneWidget);
  });

  testWidgets('流式回答: 第一段 chunk 立刻显示', (t) async {
    final c = await _pump(t);
    await _delta(t, c, '好的');
    expect(find.textContaining('好的', findRichText: true), findsOneWidget);
    await _unmount(t);
  });

  testWidgets('流式回答: 后续 chunk 接在同一段后面, 不是新开一条', (t) async {
    final c = await _pump(t);
    await _delta(t, c, '好的');
    await _delta(t, c, ', 我先看');
    await _delta(t, c, '一下代码');

    expect(find.textContaining('好的, 我先看一下代码', findRichText: true), findsOneWidget);
    expect(find.textContaining('好的', findRichText: true), findsOneWidget);
    await _unmount(t);
  });

  testWidgets('流式回答: 思考与正文能同时存在', (t) async {
    final c = await _pump(t);
    c.read(timelineStateProvider(_sid).notifier).applyStreaming('agent_thinking_delta', {
      'turn_id': 't1',
      'content': '先想一下',
    });
    await t.pump(const Duration(milliseconds: 60));
    await _delta(t, c, '给你答案');

    expect(find.textContaining('给你答案', findRichText: true), findsOneWidget);
    await _unmount(t);
  });

  testWidgets('流式收口 (agent_text_done): 文字还在, 不再标记流转中', (t) async {
    final c = await _pump(t);
    await _delta(t, c, '完成');
    c.read(timelineStateProvider(_sid).notifier).applyStreaming('agent_text_done', {'turn_id': 't1'});
    await t.pump(const Duration(milliseconds: 60));

    expect(find.textContaining('完成', findRichText: true), findsOneWidget);
    final snap = c.read(timelineStateProvider(_sid));
    expect(snap.entries.where((e) => e.kind == 'agent_text').single.streaming, isFalse);
    await _unmount(t);
  });

  testWidgets('一轮结束后 agentRunning 落下 (发送按钮会变回发送)', (t) async {
    final c = await _pump(t);
    await _delta(t, c, '在做');
    expect(c.read(timelineStateProvider(_sid)).agentRunning, isTrue);

    c.read(timelineStateProvider(_sid).notifier).applyStreaming('agent_turn_done', {'turn_id': 't1'});
    await t.pump(const Duration(milliseconds: 60));
    expect(c.read(timelineStateProvider(_sid)).agentRunning, isFalse);
    await _unmount(t);
  });

  testWidgets('发出去到回显那一帧: 占位气泡顶着, 不会是空白屏', (t) async {
    await _pump(t, optimisticText: '刚发出去的话');

    expect(find.text('刚发出去的话'), findsOneWidget);
    expect(find.byType(TypingDots), findsOneWidget);

    /* TypingDots 自带循环动画, 测试结束前卸掉 */
    await _unmount(t);
  });

  testWidgets('工具调用显示在时间线里', (t) async {
    final c = await _pump(t);
    c.read(timelineStateProvider(_sid).notifier).applyStreaming('tool_running', {
      'tool_call_id': 'call-1',
      'tool_name': 'shell',
      'args': {'command': 'ls'},
    });
    await t.pump();
    await _frames(t);

    final snap = c.read(timelineStateProvider(_sid));
    final tool = snap.entries.where((e) => e.toolName == 'shell').single;
    expect(tool.kind, 'tool');
    expect(tool.pending, isTrue, reason: '还在跑的工具应该是 pending');
    await _unmount(t);
  });

  testWidgets('断开重试 pill 不会把已有回答藏起来', (t) async {
    final c = await _pump(t);
    await _delta(t, c, '已经有一段了');
    expect(find.textContaining('已经有一段了', findRichText: true), findsOneWidget);

    c.read(timelineStateProvider(_sid).notifier).applyStreaming('stream_retry', {'attempt': 2});
    await t.pump(const Duration(milliseconds: 60));

    /* 列表可能把正文收进「过程」行, 但数据不能丢 */
    final snap = c.read(timelineStateProvider(_sid));
    expect(snap.entries.any((e) => e.text == '已经有一段了'), isTrue);
    expect(snap.retry, isNotNull);
    await _unmount(t);
  });
}
