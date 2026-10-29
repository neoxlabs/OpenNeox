/// tool_duration_test.dart — 工具耗时显示.
///
/// 欠了一轮的账 (2026-07-28 记): 桌面工具行一直显示 "27.2s / 3.6s", 手机没有 ——
/// `tool_done` 协议里没有耗时字段, 手机只能拿"收到两条事件的时刻"相减, 那掺了
/// 网络与转发延迟, 是假数。2026-07-29 由桌面按 runtime 事件时间戳算好带过来。
///
/// 这里锁死两件事: 拿到就存、拿不到不编。
library;

import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/storage/database.dart';
import 'package:neox_app/features/timeline/state/timeline_state.dart';
import 'package:neox_app/features/timeline/widgets/tool_block.dart';

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

  Future<TimelineEntry> runTool(
    String sid,
    Map<String, dynamic> donePayload,
  ) async {
    final n = container.read(timelineStateProvider(sid).notifier);
    n.applyStreaming('tool_running', {
      'tool_call_id': 'c1',
      'tool_name': 'readfile',
      'args': {'path': 'a.dart'},
    });
    n.applyStreaming('tool_done', {'tool_call_id': 'c1', ...donePayload});
    await Future<void>.delayed(const Duration(milliseconds: 120));
    return container
        .read(timelineStateProvider(sid))
        .entries
        .firstWhere((e) => e.kind == 'tool');
  }

  test('桌面带了 duration_ms → 存进 entry', () async {
    final e = await runTool(newSession(), {'ok': true, 'duration_ms': 27200});
    expect(e.pending, isFalse);
    expect(e.args?['duration_ms'], 27200);
  });

  test('桌面没带 → 不编数字 (宁可不显示)', () async {
    final e = await runTool(newSession(), {'ok': true});
    expect(e.args?['duration_ms'], isNull);
  });

  test('duration 为 0 / 负数当没有', () async {
    final a = await runTool(newSession(), {'ok': true, 'duration_ms': 0});
    expect(a.args?['duration_ms'], isNull);
    final b = await runTool(newSession(), {'ok': true, 'duration_ms': -5});
    expect(b.args?['duration_ms'], isNull);
  });

  test('带 duration 不影响失败态判定', () async {
    final e = await runTool(newSession(), {'ok': false, 'duration_ms': 1500});
    expect(e.toolSuccess, isFalse);
    expect(e.args?['duration_ms'], 1500);
  });

  test('已有 args 不被 duration 覆盖掉', () async {
    final e = await runTool(newSession(), {'ok': true, 'duration_ms': 900});
    expect(e.args?['path'] ?? e.args?['args'], isNotNull,
        reason: 'tool_running 带的参数要保留');
    expect(e.args?['duration_ms'], 900);
  });

  group('formatToolDuration — 与桌面同款', () {
    test('毫秒级', () => expect(formatToolDuration(340), '340ms'));
    test('秒级保留一位', () {
      expect(formatToolDuration(3600), '3.6s');
      expect(formatToolDuration(27200), '27.2s');
    });
    test('分钟级', () {
      expect(formatToolDuration(65000), '1m05s');
      expect(formatToolDuration(600000), '10m00s');
    });
  });
}
