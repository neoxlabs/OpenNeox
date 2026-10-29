/// chat_metrics.dart — Chat 首字打点入库与查询 (chat:C8-11, 表 chat_turn_samples).
///
/// 手机端以前只在日志里打 `[chat-ttft]`, 重启就没了 —— 「快了」只能靠体感说。
/// 这里把每轮一行写进本地库, 能按模型 / 轮次查:
///   · [record]                 一轮算完写一行 (turn_index 由同一会话已有行数推出)
///   · [recentTurns]            某个会话最近几轮 (按轮次看)
///   · [firstTokenByModel]      按模型汇总 avg / p50 (按模型看)
///
/// 保留策略跟桌面 `token_usage` 同一口径: 只留最近 [maxRows] 行, 超量删最旧。
/// 写入失败不该影响这一轮对话 —— 调用方 (phone_local_agent) 用 unawaited 且吞掉异常。
library;

import 'dart:math' as math;

import 'package:drift/drift.dart';

import '../storage/database.dart';
import 'chat_metric.dart';

/// 按模型汇总的首字统计。
class ChatFirstTokenStat {
  const ChatFirstTokenStat({
    required this.modelId,
    required this.turns,
    required this.avgFirstTokenMs,
    required this.p50FirstTokenMs,
  });

  final String modelId;

  /// 统计了多少轮「真出了字」的请求 (没等到字的那几轮不进平均)。
  final int turns;

  final int avgFirstTokenMs;
  final int p50FirstTokenMs;
}

class ChatMetricsStore {
  ChatMetricsStore(this._db);

  final AppDatabase _db;

  /// 本机最多留多少行 —— 5,000 轮足够看一两周的习惯, 再老的删掉。
  static const int maxRows = 5000;

  /// 写一轮打点。返回这一轮在会话里的序号 (1 起)。
  Future<int> record(ChatTurnMetric m) async {
    final countExpr = _db.chatTurnSamples.id.count();
    final q = _db.selectOnly(_db.chatTurnSamples)
      ..addColumns([countExpr])
      ..where(_db.chatTurnSamples.sessionId.equals(m.sessionId));
    final existing = (await q.getSingle()).read(countExpr) ?? 0;
    final turnIndex = existing + 1;

    await _db.into(_db.chatTurnSamples).insert(
          ChatTurnSamplesCompanion.insert(
            sessionId: m.sessionId,
            turnIndex: turnIndex,
            modelId: m.modelId,
            lightChat: Value(m.lightChat),
            sendToRequestMs: m.sendToRequestMs,
            requestToFirstMs: m.requestToFirstMs,
            firstTokenMs: m.firstTokenMs,
            outcome: m.gotFirstToken ? 'ok' : 'no_first_token',
            createdAt: m.at.millisecondsSinceEpoch,
          ),
        );
    await prune();
    return turnIndex;
  }

  /// 某个会话最近几轮 (默认 50), 按轮次升序 —— 「第 3 轮比第 1 轮慢」一眼看得出。
  Future<List<ChatTurnSample>> recentTurns(String sessionId, {int limit = 50}) async {
    final rows = await (_db.select(_db.chatTurnSamples)
          ..where((t) => t.sessionId.equals(sessionId))
          ..orderBy([(t) => OrderingTerm.desc(t.turnIndex)])
          ..limit(limit))
        .get();
    return rows.reversed.toList(growable: false);
  }

  /// 按模型汇总最近 [days] 天的首字 (只看真出了字的轮次)。
  Future<List<ChatFirstTokenStat>> firstTokenByModel({
    int days = 30,
    DateTime? now,
    int sampleLimit = 2000,
  }) async {
    final since = (now ?? DateTime.now())
        .subtract(Duration(days: days))
        .millisecondsSinceEpoch;
    final rows = await (_db.select(_db.chatTurnSamples)
          ..where((t) =>
              t.createdAt.isBiggerOrEqualValue(since) &
              t.firstTokenMs.isBiggerOrEqualValue(0))
          ..orderBy([(t) => OrderingTerm.desc(t.createdAt)])
          ..limit(sampleLimit))
        .get();

    final byModel = <String, List<int>>{};
    for (final r in rows) {
      byModel.putIfAbsent(r.modelId, () => <int>[]).add(r.firstTokenMs);
    }
    final stats = <ChatFirstTokenStat>[];
    byModel.forEach((modelId, values) {
      stats.add(ChatFirstTokenStat(
        modelId: modelId,
        turns: values.length,
        avgFirstTokenMs: _avg(values),
        p50FirstTokenMs: percentile(values, 50),
      ));
    });
    stats.sort((a, b) => b.turns.compareTo(a.turns));
    return stats;
  }

  /// 超过 [maxRows] 时删最旧的。
  Future<void> prune({int keep = maxRows}) async {
    final countExpr = _db.chatTurnSamples.id.count();
    final total = (await (_db.selectOnly(_db.chatTurnSamples)..addColumns([countExpr]))
            .getSingle())
        .read(countExpr) ??
        0;
    if (total <= keep) return;

    final idExpr = _db.chatTurnSamples.id;
    final cutoffRow = await (_db.selectOnly(_db.chatTurnSamples)
          ..addColumns([idExpr])
          ..orderBy([OrderingTerm.desc(idExpr)])
          ..limit(1, offset: keep - 1))
        .getSingleOrNull();
    final cutoff = cutoffRow?.read(idExpr);
    if (cutoff == null) return;
    await (_db.delete(_db.chatTurnSamples)
          ..where((t) => t.id.isSmallerThanValue(cutoff)))
        .go();
  }

  /// 最近 [days] 天的轮次总数 (含没等到字的)。
  Future<int> turnCount({int days = 30, DateTime? now}) async {
    final since = (now ?? DateTime.now())
        .subtract(Duration(days: days))
        .millisecondsSinceEpoch;
    final countExpr = _db.chatTurnSamples.id.count();
    final row = await (_db.selectOnly(_db.chatTurnSamples)
          ..addColumns([countExpr])
          ..where(_db.chatTurnSamples.createdAt.isBiggerOrEqualValue(since)))
        .getSingle();
    return row.read(countExpr) ?? 0;
  }
}

int _avg(List<int> values) {
  if (values.isEmpty) return -1;
  var sum = 0;
  for (final v in values) {
    sum += v;
  }
  return sum ~/ values.length;
}

/// 最近秩法取百分位 (样本少时也不会离谱)。
int percentile(List<int> values, int p) {
  if (values.isEmpty) return -1;
  final sorted = List<int>.of(values)..sort();
  final rank = ((p / 100) * (sorted.length - 1)).round();
  return sorted[math.min(rank, sorted.length - 1)];
}
