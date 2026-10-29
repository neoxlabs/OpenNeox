/// send_retry_test.dart — 发送失败一键重发 (chat:C1-07).
///
/// 失败卡本身也要能测: 「重发」按钮必须出现, 点了真的触发重发回调。
library;

import 'dart:convert';

import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/local_agent/send_retry.dart';
import 'package:neox_app/core/session_routing/send_failure_note.dart';
import 'package:neox_app/core/storage/database.dart';
import 'package:neox_app/features/timeline/state/timeline_state.dart';
import 'package:neox_app/features/timeline/widgets/message_row.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late AppDatabase db;

  setUp(() {
    db = AppDatabase.forTesting(NativeDatabase.memory());
  });

  tearDown(() async {
    await db.close();
  });

  Future<void> insert(
    String sid,
    int seq,
    String kind,
    Map<String, Object?> payload,
  ) {
    return db.sessionEventsDao.insertEvent(
      SessionEventsCompanion.insert(
        sessionId: sid,
        seq: seq,
        ts: 1000 + seq,
        kind: kind,
        payload: jsonEncode(payload),
      ),
    );
  }

  group('retryTextFor', () {
    test('失败卡在末尾时仍取到原话 (跳过 client_error)', () async {
      await insert('s1', 1, 'user_message', {'text': '帮我订明天的会议室'});
      await insert('s1', 2, kClientErrorKind, {'text': '❌ 发送失败'});

      expect(await retryTextFor(db, 's1'), '帮我订明天的会议室');
    });

    test('session_meta 也不挡路', () async {
      await insert('s1', 1, 'user_message', {'text': '原话'});
      await insert('s1', 2, kClientErrorKind, {'text': '❌ 失败'});
      await insert('s1', 3, 'session_meta', {'model_id': 'deepseek-v4-flash'});

      expect(await retryTextFor(db, 's1'), '原话');
    });

    test('最后一条不是用户消息 → null (没有可重发的)', () async {
      await insert('s2', 1, 'user_message', {'text': '问题'});
      await insert('s2', 2, 'agent_text', {'text': '回答'});

      expect(await retryTextFor(db, 's2'), isNull);
    });

    test('空会话 → null', () async {
      expect(await retryTextFor(db, 's3'), isNull);
    });
  });

  group('失败卡', () {
    testWidgets('按钮文案是「重发」, 点一下触发 onRetry', (tester) async {
      var taps = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: MessageRow(
              entry: TimelineEntry(
                id: 'err-1',
                kind: kClientErrorKind,
                sequence: 2,
                timestamp: 1000,
                text: '❌ 网络断了',
                args: {'text': '❌ 网络断了'},
              ),
              onRetry: () => taps++,
            ),
          ),
        ),
      );

      expect(find.text('重发'), findsOneWidget);
      await tester.tap(find.text('重发'));
      expect(taps, 1);
    });
  });
}
