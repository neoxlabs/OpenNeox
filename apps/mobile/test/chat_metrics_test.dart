/// chat_metrics_test.dart — Chat 首字打点入库 (chat:C8-11).
///
/// 守三件事:
///   1. 每轮写一行, turn_index 按会话递增 (按轮次可查);
///   2. 按模型汇总 avg / p50 时跳过没等到字的那几轮 (-1);
///   3. 超过保留上限时删最旧的.
library;

import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/storage/database.dart';
import 'package:neox_app/core/telemetry/chat_metric.dart';
import 'package:neox_app/core/telemetry/chat_metrics.dart';

ChatTurnMetric _metric({
  String sessionId = 's1',
  String modelId = 'deepseek-v4.1-flash',
  bool lightChat = true,
  int firstTokenMs = 900,
  bool gotFirstToken = true,
  DateTime? at,
}) {
  return ChatTurnMetric(
    sessionId: sessionId,
    modelId: modelId,
    lightChat: lightChat,
    sendToRequestMs: 100,
    requestToFirstMs: gotFirstToken ? firstTokenMs - 100 : -1,
    firstTokenMs: gotFirstToken ? firstTokenMs : -1,
    gotFirstToken: gotFirstToken,
    at: at ?? DateTime(2026, 10, 18, 10),
  );
}

void main() {
  late AppDatabase db;
  late ChatMetricsStore store;

  setUp(() {
    db = AppDatabase.forTesting(NativeDatabase.memory());
    store = ChatMetricsStore(db);
  });

  tearDown(() async {
    await db.close();
  });

  test('每轮一行, turn_index 按会话递增', () async {
    expect(await store.record(_metric()), 1);
    expect(await store.record(_metric()), 2);
    /* 另一个会话自己从 1 开始 */
    expect(await store.record(_metric(sessionId: 's2')), 1);

    final turns = await store.recentTurns('s1');
    expect(turns.map((t) => t.turnIndex), [1, 2]);
    expect(turns.first.modelId, 'deepseek-v4.1-flash');
    expect(turns.first.outcome, 'ok');
    expect(turns.first.lightChat, isTrue);
    expect(turns.first.sendToRequestMs, 100);
    expect(turns.first.requestToFirstMs, 800);
    expect(turns.first.firstTokenMs, 900);
  });

  test('没等到字的那轮 outcome=no_first_token, 不进平均', () async {
    await store.record(_metric(firstTokenMs: 600));
    await store.record(_metric(sessionId: 's2', gotFirstToken: false));
    await store.record(_metric(sessionId: 's3', firstTokenMs: 1000));

    final turns = await store.recentTurns('s2');
    expect(turns.single.outcome, 'no_first_token');
    expect(turns.single.firstTokenMs, -1);

    final stats = await store.firstTokenByModel();
    expect(stats, hasLength(1));
    expect(stats.single.turns, 2);
    expect(stats.single.avgFirstTokenMs, 800);
    expect(stats.single.p50FirstTokenMs, 1000);
    /* 总数含没等到字的那轮 */
    expect(await store.turnCount(), 3);
  });

  test('按模型分开统计', () async {
    await store.record(_metric(firstTokenMs: 500));
    await store.record(_metric(firstTokenMs: 700));
    await store.record(_metric(sessionId: 's2', modelId: 'deepseek-v4-pro', firstTokenMs: 2500));

    final stats = await store.firstTokenByModel();
    expect(stats.map((s) => s.modelId), ['deepseek-v4.1-flash', 'deepseek-v4-pro']);
    expect(stats.first.turns, 2);
    expect(stats.first.avgFirstTokenMs, 600);
    expect(stats.last.avgFirstTokenMs, 2500);
  });

  test('超过保留上限删最旧', () async {
    for (var i = 0; i < 5; i++) {
      await store.record(_metric(sessionId: 's$i'));
    }
    await store.prune(keep: 3);
    expect(await store.turnCount(), 3);
    /* 留下的是最新三行 */
    expect((await store.recentTurns('s0')).isEmpty, isTrue);
    expect((await store.recentTurns('s4')).single.turnIndex, 1);
  });

  test('百分位: 空样本返 -1, 小样本不越界', () {
    expect(percentile(const [], 50), -1);
    expect(percentile([100, 200, 300], 50), 200);
    expect(percentile([100], 95), 100);
  });
}
