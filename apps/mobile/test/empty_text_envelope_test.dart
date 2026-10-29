/// empty_text_envelope_test.dart — 空正文事件不许把 payload 原文印出来.
///
/// 2026-07-30 真机 (发行包侧装, `sleep 90` 那轮): 时间轴上白纸黑字印着
///   `{"role":"assistant","content":"","turn_id":"chat-1785377865655"}`
/// 出现两次。根因在 `_stringFrom(payload, fallback)` —— payload 是 Map 但
/// `content` 是空串、也没有 `text`/`message` 时, 它退回 `fallback` = 整个
/// payload 的 JSON 原文, 于是信封被当正文渲染。
///
/// 这里钉两件事:
///   1. Map 进来就绝不退回原文 (没文本就是空)
///   2. 空正文的 agent_text 不建条目, 且不覆盖本轮流式已产出的正文
/// 同时保住那个 fallback 唯一的正当用途: payload 压根不是 JSON 时, 原文即正文.
library;

import 'dart:convert';

import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/storage/database.dart';
import 'package:neox_app/features/timeline/state/timeline_state.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late ProviderContainer container;
  late AppDatabase db;
  var seq = 0;

  setUp(() {
    db = AppDatabase.forTesting(NativeDatabase.memory());
    container = ProviderContainer(
      overrides: [appDatabaseProvider.overrideWithValue(db)],
    );
  });
  tearDown(() async {
    container.dispose();
    await db.close();
  });

  String newSession() => 'sess${++seq}';

  /// 走 drift/hydrate 那条路 (真机上出问题的就是它) — 直接塞 session_events.
  Future<TimelineSnapshot> hydrate(
    String sid,
    List<({String kind, Object payload})> events,
  ) async {
    container.read(timelineStateProvider(sid).notifier); /* 先挂上 watch */
    var n = 0;
    for (final e in events) {
      await db.sessionEventsDao.insertEvent(
        SessionEventsCompanion.insert(
          sessionId: sid,
          seq: ++n,
          ts: 1785377860000 + n * 1000,
          kind: e.kind,
          payload: e.payload is String
              ? e.payload as String
              : jsonEncode(e.payload),
        ),
      );
    }
    await Future<void>.delayed(const Duration(milliseconds: 500));
    return container.read(timelineStateProvider(sid));
  }

  String allText(TimelineSnapshot s) =>
      s.entries.map((e) => e.text ?? '').join('\n');

  group('空 content 的 assistant 信封', () {
    test('不建条目, 更不许把 JSON 原文印出来', () async {
      final s = await hydrate(newSession(), [
        (
          kind: 'agent_text',
          payload: {
            'role': 'assistant',
            'content': '',
            'turn_id': 'chat-1785377865655',
          },
        ),
      ]);
      expect(allText(s), isNot(contains('"role"')));
      expect(allText(s), isNot(contains('turn_id')));
      expect(s.entries.where((e) => e.kind == 'agent_text'), isEmpty);
    });

    test('真机那一轮的完整形态: 两条空信封 + 一条真正文 → 只留真正文', () async {
      final s = await hydrate(newSession(), [
        (
          kind: 'agent_text',
          payload: {
            'role': 'assistant',
            'content': '',
            'turn_id': 'chat-1785377865655',
          },
        ),
        (
          kind: 'agent_text',
          payload: {
            'role': 'assistant',
            'content': 'sleep 90 已完成, 退出码 0。',
            'turn_id': 'chat-1785377865655',
          },
        ),
        (
          kind: 'agent_text',
          payload: {
            'role': 'assistant',
            'content': '',
            'turn_id': 'chat-1785377973735',
          },
        ),
      ]);
      final texts = s.entries
          .where((e) => e.kind == 'agent_text')
          .map((e) => e.text)
          .toList();
      expect(texts, ['sleep 90 已完成, 退出码 0。']);
      expect(allText(s), isNot(contains('{"role"')));
    });

    test('空的 content 数组 / 只有非 text 分段 也算没文本', () async {
      final s = await hydrate(newSession(), [
        (kind: 'agent_text', payload: {'role': 'assistant', 'content': []}),
        (
          kind: 'agent_text',
          payload: {
            'role': 'assistant',
            'content': [
              {'type': 'thinking', 'thinking': '嗯'},
            ],
          },
        ),
      ]);
      expect(s.entries.where((e) => e.kind == 'agent_text'), isEmpty);
      expect(allText(s), isNot(contains('thinking')));
    });
  });

  group('不能顺手弄坏的东西', () {
    test('content 分段里的 text 照旧拼出来', () async {
      final s = await hydrate(newSession(), [
        (
          kind: 'agent_text',
          payload: {
            'role': 'assistant',
            'content': [
              {'type': 'text', 'text': '前半'},
              {'type': 'text', 'text': '后半'},
            ],
          },
        ),
      ]);
      expect(
        s.entries.firstWhere((e) => e.kind == 'agent_text').text,
        /* 同一条消息里分开的两段正文之间补一个换行 —— 不然上一句和下一段的标题粘在一起 (见 agent_runner emit) */
        '前半\n后半',
      );
    });

    test('payload 压根不是 JSON → 原文即正文 (fallback 唯一正当用途)', () async {
      final s = await hydrate(newSession(), [
        (kind: 'agent_text', payload: '这不是 JSON, 整段就是答案'),
      ]);
      expect(
        s.entries.firstWhere((e) => e.kind == 'agent_text').text,
        '这不是 JSON, 整段就是答案',
      );
    });

    test('空信封不覆盖本轮流式已产出的正文, 只把它收口', () async {
      final sid = newSession();
      final n = container.read(timelineStateProvider(sid).notifier);
      n.applyStreaming('agent_text_delta', {
        'content': '流出来的答案',
        'turn_id': 'chat-1',
      });
      n.applyRemoteEvents([
        SessionEvent(
          sessionId: sid,
          seq: 9,
          ts: 1785377999000,
          kind: 'agent_text',
          payload: jsonEncode({
            'role': 'assistant',
            'content': '',
            'turn_id': 'chat-1',
          }),
        ),
      ]);
      await Future<void>.delayed(const Duration(milliseconds: 150));
      final s = container.read(timelineStateProvider(sid));
      final texts = s.entries
          .where((e) => e.kind == 'agent_text')
          .map((e) => e.text)
          .toList();
      expect(texts, ['流出来的答案'], reason: '流式正文不能被空信封抹掉');
      expect(
        s.entries.firstWhere((e) => e.kind == 'agent_text').streaming,
        isFalse,
        reason: '空信封的作用只剩收口 — 光标不该一直闪',
      );
    });

    test('tool_result 输出为空 → 不印 JSON 信封', () async {
      final s = await hydrate(newSession(), [
        (
          kind: 'tool_call',
          payload: {'tool_call_id': 'c1', 'tool_name': 'bash'},
        ),
        (kind: 'tool_result', payload: {'tool_call_id': 'c1', 'content': ''}),
      ]);
      expect(allText(s), isNot(contains('tool_call_id')));
    });
  });
}
