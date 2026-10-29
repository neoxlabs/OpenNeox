/// stream_freeze_test.dart — 点停止后立即冻结打字机 (chat:C9-08) 的第一层.
///
/// 两层里的**状态层**: `markCancelRequested` 之后, 桌面 / 网关还没收到 cancel 之前
/// 残留的正文与思考增量不许再上屏; 已经产出的内容保留; 收口 / 新一轮开始解冻。
library;

import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/storage/database.dart';
import 'package:neox_app/features/timeline/state/stream_freeze.dart';
import 'package:neox_app/features/timeline/state/timeline_state.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('isTypewriterStreamKind', () {
    test('正文与思考算打字机', () {
      expect(isTypewriterStreamKind('agent_text_delta'), isTrue);
      expect(isTypewriterStreamKind('agent_thinking_delta'), isTrue);
    });

    test('工具进度 / 生命周期事件不算 —— 它们有自己的收口语义', () {
      expect(isTypewriterStreamKind('tool_progress'), isFalse);
      expect(isTypewriterStreamKind('agent_text_done'), isFalse);
      expect(isTypewriterStreamKind('session_interrupted'), isFalse);
    });
  });

  group('TimelineStateController 停止冻结', () {
    late ProviderContainer container;
    late AppDatabase db;

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

    /// flush 是微任务 + 32ms 节流合并的 —— 等一个窗口再取快照。
    Future<TimelineSnapshot> snap(String sid) async {
      await Future<void>.delayed(const Duration(milliseconds: 100));
      return container.read(timelineStateProvider(sid));
    }

    TimelineStateController ctrl(String sid) =>
        container.read(timelineStateProvider(sid).notifier);

    String textOf(TimelineSnapshot s) => s.entries
        .where((e) => e.kind == 'agent_text')
        .map((e) => e.text ?? '')
        .join();

    String thinkingOf(TimelineSnapshot s) => s.entries
        .where((e) => e.kind == 'agent_thinking')
        .map((e) => e.thinking ?? e.text ?? '')
        .join();

    test('停止后残留的正文增量不再上屏, 已产出的字保留', () async {
      final c = ctrl('c9f-1');
      c.markAgentStarting();
      c.applyStreaming('agent_text_delta', {
        'turn_id': 't1',
        'content': '前半句',
      });
      await snap('c9f-1');

      c.markCancelRequested();
      c.applyStreaming('agent_text_delta', {
        'turn_id': 't1',
        'content': '——这段是点了停止之后才到的',
      });
      final s = await snap('c9f-1');
      expect(s.streamFrozen, isTrue);
      expect(textOf(s), '前半句', reason: '已显示的字不截断, 但不再变长');
    });

    test('思考增量同样冻结', () async {
      final c = ctrl('c9f-2');
      c.markAgentStarting();
      c.applyStreaming('agent_thinking_delta', {
        'turn_id': 't1',
        'content': '先想一下',
      });
      c.markCancelRequested();
      c.applyStreaming('agent_thinking_delta', {
        'turn_id': 't1',
        'content': '继续想',
      });
      final s = await snap('c9f-2');
      expect(thinkingOf(s), '先想一下');
    });

    test('收口事件 (agent_turn_done) 解冻 —— 冻结不会永久卡住', () async {
      final c = ctrl('c9f-3');
      c.markAgentStarting();
      c.markCancelRequested();
      c.applyStreaming('agent_turn_done', {'turn_id': 't1'});
      final s = await snap('c9f-3');
      expect(s.streamFrozen, isFalse);

      /* 解冻之后下一轮的增量照常上屏 */
      c.applyStreaming('agent_text_delta', {
        'turn_id': 't2',
        'content': '新一轮回答',
      });
      expect(textOf(await snap('c9f-3')), '新一轮回答');
    });

    test('session_interrupted 也解冻', () async {
      final c = ctrl('c9f-4');
      c.markAgentStarting();
      c.markCancelRequested();
      c.applyStreaming('session_interrupted', {'turn_id': 't1'});
      expect((await snap('c9f-4')).streamFrozen, isFalse);
    });

    test('停止后紧接着发下一条: markAgentStarting 解冻, 新回答不被吞', () async {
      final c = ctrl('c9f-5');
      c.markAgentStarting();
      c.markCancelRequested();
      c.markAgentStarting();
      c.applyStreaming('agent_text_delta', {
        'turn_id': 't2',
        'content': '新的',
      });
      final s = await snap('c9f-5');
      expect(s.streamFrozen, isFalse);
      expect(textOf(s), '新的');
    });

    test('未点停止时行为不变 (增量照常上屏)', () async {
      final c = ctrl('c9f-6');
      c.markAgentStarting();
      c.applyStreaming('agent_text_delta', {'turn_id': 't1', 'content': 'A'});
      c.applyStreaming('agent_text_delta', {'turn_id': 't1', 'content': 'B'});
      final s = await snap('c9f-6');
      expect(s.streamFrozen, isFalse);
      expect(textOf(s), 'AB');
    });
  });
}
