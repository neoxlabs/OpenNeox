/// inbox_pending_dao.dart — Mode B 离线 inbox CRUD.
library;

import 'package:drift/drift.dart';

import '../database.dart';
import '../tables.dart';

part 'inbox_pending_dao.g.dart';

@DriftAccessor(tables: [InboxPending])
class InboxPendingDao extends DatabaseAccessor<AppDatabase>
    with _$InboxPendingDaoMixin {
  InboxPendingDao(super.db);

  Future<List<InboxPendingData>> getQueuedFor(String desktopDeviceId) {
    return (select(inboxPending)
          ..where(
            (t) =>
                t.desktopDeviceId.equals(desktopDeviceId) &
                t.status.equals('queued'),
          )
          ..orderBy([(t) => OrderingTerm.asc(t.createdAt)]))
        .get();
  }

  Stream<List<InboxPendingData>> watchQueuedFor(String desktopDeviceId) {
    return (select(inboxPending)
          ..where(
            (t) =>
                t.desktopDeviceId.equals(desktopDeviceId) &
                t.status.equals('queued'),
          )
          ..orderBy([(t) => OrderingTerm.asc(t.createdAt)]))
        .watch();
  }

  Future<void> enqueue(InboxPendingCompanion entry) {
    return into(inboxPending).insert(entry);
  }

  Future<int> markStatus(String id, String status, {int? deliveredAt}) {
    return (update(inboxPending)..where((t) => t.id.equals(id))).write(
      InboxPendingCompanion(
        status: Value(status),
        deliveredAt: deliveredAt != null
            ? Value(deliveredAt)
            : const Value.absent(),
      ),
    );
  }

  Future<int> deleteByDesktopDeviceId(String desktopDeviceId) {
    return (delete(inboxPending)
          ..where((t) => t.desktopDeviceId.equals(desktopDeviceId)))
        .go();
  }

  Future<int> deleteExpired(int olderThanTs) {
    return (delete(inboxPending)..where((t) => t.createdAt.isSmallerThanValue(olderThanTs)))
        .go();
  }
}
