/// compaction_divider_test.dart — 上下文压缩分隔线.
///
/// 2026-07-29 真机: 手机端**从来没显示过**压缩 —— 桌面把事件包成
/// `{type:'raw_response_event', event_type:'context_compaction'}`,
/// 而 mobile-bridge 只认 `type==='context_compaction'`, 39470 条事件里一条都没转发过。
/// 桌面侧已补上转发, 这里锁住手机端收到之后的渲染与取值。
library;

import 'package:flutter/material.dart';
import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/storage/database.dart';
import 'package:neox_app/shared/clay/clay.dart' show ClaySpinner;
import 'package:neox_app/features/timeline/state/timeline_state.dart';
import 'package:neox_app/features/timeline/widgets/agent_activity_rows.dart';

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

  Future<List<TimelineEntry>> entriesAfter(
    String sid,
    void Function() act,
  ) async {
    act();
    await Future<void>.delayed(const Duration(milliseconds: 120));
    return container.read(timelineStateProvider(sid)).entries;
  }

  test('压缩事件进 timeline, 带上前后 token 数', () async {
    final sid = newSession();
    final entries = await entriesAfter(sid, () {
      container.read(timelineStateProvider(sid).notifier).applyStreaming(
        'context_compaction',
        {
          'status': 'completed',
          'original_tokens': 7484,
          'final_tokens': 6583,
        },
      );
    });
    final c = entries.singleWhere((e) => e.kind == 'compaction');
    expect(c.args?['original_tokens'], 7484);
    expect(c.args?['final_tokens'], 6583);
  });

  test('桌面 Mode C 的字段名 (before/after) 也认', () async {
    final sid = newSession();
    final entries = await entriesAfter(sid, () {
      container.read(timelineStateProvider(sid).notifier).applyStreaming(
        'context_compaction',
        {'before_tokens': 9000, 'after_tokens': 4000},
      );
    });
    final c = entries.singleWhere((e) => e.kind == 'compaction');
    expect(
      c.args?['original_tokens'] ?? c.args?['before_tokens'],
      9000,
    );
  });

  test('多次压缩各留一条分隔线, 不互相覆盖', () async {
    final sid = newSession();
    final n = container.read(timelineStateProvider(sid).notifier);
    final entries = await entriesAfter(sid, () {
      n.applyStreaming('context_compaction', {
        'original_tokens': 8000,
        'final_tokens': 5000,
      });
      n.applyStreaming('context_compaction', {
        'original_tokens': 7000,
        'final_tokens': 4000,
      });
    });
    expect(entries.where((e) => e.kind == 'compaction'), hasLength(2));
  });

  group('分隔线渲染 — 与桌面同形', () {
    Widget wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

    TimelineEntry compactionEntry({
      int? orig,
      int? fin,
      bool running = false,
      String? message,
    }) =>
        TimelineEntry(
          id: 'c1',
          kind: 'compaction',
          sequence: 1,
          timestamp: 0,
          pending: running,
          args: {
            if (orig != null) 'original_tokens': orig,
            if (fin != null) 'final_tokens': fin,
            if (message != null) 'message': message,
          },
        );

    /* 陶土稿 v5: 居中「已压缩 · 7.5k → 6.6k」, 两边细线; 不再写「释放 N」 */
    testWidgets('有 token 数时: 标题 + 前后数字', (tester) async {
      await tester.pumpWidget(
        wrap(CompactionDivider(entry: compactionEntry(orig: 7484, fin: 6583))),
      );
      expect(find.text('已压缩'), findsOneWidget);
      expect(find.textContaining('7.5k → 6.6k'), findsOneWidget);
    });

    testWidgets('没拿到 token 数时只留标题, 不编数字', (tester) async {
      await tester.pumpWidget(wrap(CompactionDivider(entry: compactionEntry())));
      expect(find.text('已压缩'), findsOneWidget);
      expect(find.textContaining('→'), findsNothing);
      expect(find.textContaining('释放'), findsNothing);
    });

    testWidgets('压缩后反而变大 (no-op 校准) 不显示"释放"', (tester) async {
      await tester.pumpWidget(
        wrap(CompactionDivider(entry: compactionEntry(orig: 6000, fin: 6200))),
      );
      expect(find.textContaining('释放'), findsNothing);
    });
  });

  group('进行中态 — 点完立刻有反馈', () {
    Widget wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

    TimelineEntry running({String? message}) => TimelineEntry(
          id: 'c1',
          kind: 'compaction',
          sequence: 1,
          timestamp: 0,
          pending: true,
          args: {if (message != null) 'message': message},
        );

    testWidgets('running 时显示"正在压缩…" + 转圈, 不编数字', (tester) async {
      await tester.pumpWidget(wrap(CompactionDivider(entry: running())));
      expect(find.text('正在压缩…'), findsOneWidget);
      expect(find.text('已压缩'), findsNothing);
      expect(find.byType(ClaySpinner), findsOneWidget);
      expect(find.textContaining('→'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('running 时带上 runtime 的阶段文案 (分析中/保存中)', (tester) async {
      await tester.pumpWidget(
        wrap(CompactionDivider(entry: running(message: '◆ 分析中'))),
      );
      expect(find.text('◆ 分析中'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });
  });

  group('同一次压缩只留一条分隔线 (running → completed 原地演化)', () {
    test('先 running 后 completed 不产生两条', () async {
      final sid = newSession();
      final n = container.read(timelineStateProvider(sid).notifier);
      final entries = await entriesAfter(sid, () {
        n.applyStreaming('context_compaction', {
          'status': 'running',
          'message': '⚡ 正在压缩历史',
        });
        n.applyStreaming('context_compaction', {
          'status': 'completed',
          'original_tokens': 42700,
          'final_tokens': 10500,
        });
      });
      final rows = entries.where((e) => e.kind == 'compaction').toList();
      expect(rows, hasLength(1));
      expect(rows.single.pending, isFalse);
      expect(rows.single.args?['original_tokens'], 42700);
      expect(rows.single.args?['final_tokens'], 10500);
    });

    test('running 阶段的空数字不覆盖已完成的真实值', () async {
      final sid = newSession();
      final n = container.read(timelineStateProvider(sid).notifier);
      final entries = await entriesAfter(sid, () {
        n.applyStreaming('context_compaction', {
          'status': 'running',
        });
        n.applyStreaming('context_compaction', {
          'status': 'completed',
          'original_tokens': 8000,
          'final_tokens': 3000,
        });
        /* 完成后又来一条 running (下一轮压缩) → 应当是新的一条 */
        n.applyStreaming('context_compaction', {'status': 'running'});
      });
      final rows = entries.where((e) => e.kind == 'compaction').toList();
      expect(rows, hasLength(2));
      expect(rows.first.args?['original_tokens'], 8000);
      expect(rows.last.pending, isTrue);
    });
  });
}