/// answer_versions_test.dart — 重新生成保留旧版本 / 可来回切 (chat:C1-06).
///
/// 锁三件事:
///   1. 重新生成前把当前答案记进上一条 user_message 的 answer_versions;
///   2. 切换版本 = 当前答案和选中的旧答案对调, 两个方向都成立 (来回切);
///   3. 时间线投影把旧版本挂到最后一条 agent_text 上, 并给出锚点 seq。
library;

import 'dart:convert';

import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/local_agent/answer_versions.dart';
import 'package:neox_app/core/storage/database.dart';
import 'package:neox_app/features/timeline/state/timeline_state.dart';

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
    Map<String, Object?> payload, {
    int ts = 1000,
  }) {
    return db.sessionEventsDao.insertEvent(
      SessionEventsCompanion.insert(
        sessionId: sid,
        seq: seq,
        ts: ts + seq,
        kind: kind,
        payload: jsonEncode(payload),
      ),
    );
  }

  group('captureAnswerVersionForRegenerate', () {
    test('把当前答案记到 user_message 上, 重复点不重复记', () async {
      await insert('s1', 1, 'user_message', {'text': '讲个笑话'});
      await insert('s1', 2, 'agent_text', {'text': '第一版答案', 'turn_id': 't1'});

      final captured = await captureAnswerVersionForRegenerate(db, 's1');
      expect(captured, '第一版答案');

      final user = (await db.sessionEventsDao.getBySessionId('s1'))
          .firstWhere((e) => e.kind == 'user_message');
      expect(answerVersionsFromPayload(user.payload), ['第一版答案']);

      /* 又点了一次 (还没出新答案): 同一段不再记第二遍 */
      await captureAnswerVersionForRegenerate(db, 's1');
      final again = (await db.sessionEventsDao.getBySessionId('s1'))
          .firstWhere((e) => e.kind == 'user_message');
      expect(answerVersionsFromPayload(again.payload), ['第一版答案']);
    });

    test('没有回答时不写旧版本', () async {
      await insert('s2', 1, 'user_message', {'text': '还在等'});
      final captured = await captureAnswerVersionForRegenerate(db, 's2');
      expect(captured, isNull);
      final user = (await db.sessionEventsDao.getBySessionId('s2')).single;
      expect(answerVersionsFromPayload(user.payload), isEmpty);
    });

    test('失败回滚撤掉刚记下的那版', () async {
      await insert('s3', 1, 'user_message', {'text': '问题'});
      await insert('s3', 2, 'agent_text', {'text': '旧答案', 'turn_id': 't1'});
      await captureAnswerVersionForRegenerate(db, 's3');

      await revertCapturedAnswerVersion(db, 's3', '旧答案');

      final user = (await db.sessionEventsDao.getBySessionId('s3'))
          .firstWhere((e) => e.kind == 'user_message');
      expect(answerVersionsFromPayload(user.payload), isEmpty);
    });
  });

  group('selectAnswerVersionOn', () {
    test('切成旧版, 再切回来 —— 两版内容都不丢', () async {
      await insert('s4', 1, 'user_message', {
        'text': '写个标题',
        'answer_versions': ['旧版答案'],
      });
      await insert('s4', 2, 'agent_text', {'text': '新版答案', 'turn_id': 't2'});

      expect(await selectAnswerVersionOn(db, 's4', 1, 0), isTrue);

      var events = await db.sessionEventsDao.getBySessionId('s4');
      expect(
        (jsonDecode(events[1].payload) as Map)['text'],
        '旧版答案',
        reason: '选中的旧版应该成为当前显示的答案',
      );
      expect(answerVersionsFromPayload(events[0].payload), ['新版答案']);

      /* 再点一次那个位置 = 切回新版 */
      expect(await selectAnswerVersionOn(db, 's4', 1, 0), isTrue);
      events = await db.sessionEventsDao.getBySessionId('s4');
      expect((jsonDecode(events[1].payload) as Map)['text'], '新版答案');
      expect(answerVersionsFromPayload(events[0].payload), ['旧版答案']);
    });

    test('下标越界 / 没有答案时不动数据', () async {
      await insert('s5', 1, 'user_message', {
        'text': '问题',
        'answer_versions': ['旧版'],
      });
      await insert('s5', 2, 'agent_text', {'text': '当前', 'turn_id': 't1'});

      expect(await selectAnswerVersionOn(db, 's5', 1, 5), isFalse);
      expect(await selectAnswerVersionOn(db, 's5', 99, 0), isFalse);

      final events = await db.sessionEventsDao.getBySessionId('s5');
      expect((jsonDecode(events[1].payload) as Map)['text'], '当前');
    });
  });

  group('timeline 投影', () {
    test('旧版本挂到最后一条 agent_text 上, 带 user_message 锚点', () async {
      await insert('s6', 1, 'user_message', {
        'text': '问题',
        'answer_versions': ['第一版'],
      });
      await insert('s6', 2, 'agent_text', {'text': '第二版', 'turn_id': 't2'});

      final container = ProviderContainer(
        overrides: [appDatabaseProvider.overrideWithValue(db)],
      );
      addTearDown(container.dispose);
      container.read(timelineStateProvider('s6'));
      await Future<void>.delayed(const Duration(milliseconds: 300));
      final snap = container.read(timelineStateProvider('s6'));

      final answer = snap.entries.lastWhere((e) => e.kind == 'agent_text');
      expect(answer.text, '第二版');
      expect(answer.answerVersions, ['第一版']);
      expect(answer.answerAnchorSeq, 1);
    });
  });
}
