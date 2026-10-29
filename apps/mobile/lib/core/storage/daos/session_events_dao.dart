/// session_events_dao.dart — session timeline 事件 CRUD.
///
/// 复合主键 (session_id, seq), 写入用 insertOnConflictUpdate 实现幂等
/// (Desktop 重连补传时同 seq 不会重复入库).
library;

import 'package:drift/drift.dart';

import '../database.dart';
import '../tables.dart';

part 'session_events_dao.g.dart';

@DriftAccessor(tables: [SessionEvents])
class SessionEventsDao extends DatabaseAccessor<AppDatabase>
    with _$SessionEventsDaoMixin {
  SessionEventsDao(super.db);

  Future<List<SessionEvent>> getBySessionId(String sessionId) {
    return (select(sessionEvents)
          ..where((t) => t.sessionId.equals(sessionId))
          ..orderBy([(t) => OrderingTerm.asc(t.seq)]))
        .get();
  }

  Stream<List<SessionEvent>> watchBySessionId(String sessionId) {
    return (select(sessionEvents)
          ..where((t) => t.sessionId.equals(sessionId))
          ..orderBy([(t) => OrderingTerm.asc(t.seq)]))
        .watch();
  }

  Future<int?> getMaxSeq(String sessionId) async {
    final maxSeq = sessionEvents.seq.max();
    final query = selectOnly(sessionEvents)
      ..addColumns([maxSeq])
      ..where(sessionEvents.sessionId.equals(sessionId));
    final row = await query.getSingleOrNull();
    return row?.read(maxSeq);
  }

  Future<int?> getMinSeq(String sessionId) async {
    final minSeq = sessionEvents.seq.min();
    final query = selectOnly(sessionEvents)
      ..addColumns([minSeq])
      ..where(sessionEvents.sessionId.equals(sessionId));
    final row = await query.getSingleOrNull();
    return row?.read(minSeq);
  }

  Future<void> insertEvent(SessionEventsCompanion entry) {
    return into(sessionEvents).insertOnConflictUpdate(entry);
  }

  Future<void> insertBatch(List<SessionEventsCompanion> entries) async {
    if (entries.isEmpty) return;
    await batch((b) {
      b.insertAllOnConflictUpdate(sessionEvents, entries);
    });
  }

  /// 删指定 seq — client_error 这类"下次发送成功就该消失"的临时记录用.
  Future<int> deleteSeqs(String sessionId, List<int> seqs) {
    if (seqs.isEmpty) return Future.value(0);
    return (delete(sessionEvents)
          ..where((t) => t.sessionId.equals(sessionId) & t.seq.isIn(seqs)))
        .go();
  }

  /// 改一条事件的 payload (补挂产物卡这种事后修正用)
  Future<int> updatePayload(String sessionId, int seq, String payload) {
    return (update(sessionEvents)..where((t) => t.sessionId.equals(sessionId) & t.seq.equals(seq)))
        .write(SessionEventsCompanion(payload: Value(payload)));
  }

  /// 某类事件 (全部会话) —— 一次性数据修正用
  Future<List<SessionEvent>> getByKind(String kind) {
    return (select(sessionEvents)..where((t) => t.kind.equals(kind))).get();
  }

  Future<int> deleteBySessionId(String sessionId) {
    return (delete(sessionEvents)..where((t) => t.sessionId.equals(sessionId)))
        .go();
  }
}
