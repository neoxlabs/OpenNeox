/// session_mirror_dao.dart — session 列表 (Desktop session 镜像) CRUD.
library;

import 'package:drift/drift.dart';

import '../database.dart';
import '../tables.dart';

part 'session_mirror_dao.g.dart';

@DriftAccessor(tables: [SessionMirror])
class SessionMirrorDao extends DatabaseAccessor<AppDatabase>
    with _$SessionMirrorDaoMixin {
  SessionMirrorDao(super.db);

  Future<List<SessionMirrorData>> getAll() {
    return (select(
      sessionMirror,
    )..orderBy([(t) => OrderingTerm.desc(t.lastMessageAt)])).get();
  }

  Stream<List<SessionMirrorData>> watchAll() {
    return (select(
      sessionMirror,
    )..orderBy([(t) => OrderingTerm.desc(t.lastMessageAt)])).watch();
  }

  /// 某个模式下的会话 (工作 / 编码 首页的「最近」用).
  ///
  /// 带上 agent_mode 为 NULL 的行: 那是 2026-09-04 加这一列之前建的存量会话,
  /// 它们的模式**无从知道**。宁可在两个 home 里都出现, 也不要因为一个我们自己
  /// 没记的字段, 让用户以为会话丢了 —— 少一条比多一条难查得多。
  /// 'assistant' (已删的「对话」模式) 归工作 —— 跟桌面 normalizeAgentMode 同口径。
  /// 子会话 (parentSessionId 非空) 不进: 它们在抽屉里嵌套显示, 不占顶层。
  Stream<List<SessionMirrorData>> watchByMode(String wireMode, {int limit = 6}) {
    final modes = wireMode == 'work' ? const ['work', 'assistant'] : [wireMode];
    return (select(sessionMirror)
          ..where((t) =>
              (t.agentMode.isIn(modes) | t.agentMode.isNull()) &
              t.parentSessionId.isNull())
          ..orderBy([(t) => OrderingTerm.desc(t.lastMessageAt)])
          ..limit(limit))
        .watch();
  }

  Future<SessionMirrorData?> findById(String id) {
    return (select(
      sessionMirror,
    )..where((t) => t.id.equals(id))).getSingleOrNull();
  }

  Future<List<SessionMirrorData>> getByDesktopDeviceId(String desktopDeviceId) {
    return (select(
      sessionMirror,
    )..where((t) => t.desktopDeviceId.equals(desktopDeviceId))).get();
  }

  /// 一台电脑上的会话 (远程连接 → 某台电脑页), 最近的在前; 子 Agent 不列
  /// (跟抽屉同一条: 认不出父会话的「子 Agent xxx」也不列, 见 neox_drawer)
  Stream<List<SessionMirrorData>> watchByDesktop(String desktopDeviceId) {
    return (select(sessionMirror)
          ..where((t) =>
              t.desktopDeviceId.equals(desktopDeviceId) &
              t.parentSessionId.isNull() &
              t.kind.equals('image').not() &
              (t.title.isNull() | t.title.like('子 Agent %').not()))
          ..orderBy([(t) => OrderingTerm.desc(t.lastMessageAt), (t) => OrderingTerm.desc(t.createdAt)]))
        .watch();
  }

  /// 单 session watch — timeline_page header 监听 title 变化用.
  Stream<SessionMirrorData?> watchById(String id) {
    return (select(
      sessionMirror,
    )..where((t) => t.id.equals(id))).watchSingleOrNull();
  }

  Future<int> upsert(SessionMirrorCompanion entry) {
    return into(sessionMirror).insertOnConflictUpdate(entry);
  }

  /// 只改模式 —— 不能走 [upsert]: 只带 id + agentMode 的 companion 过不了插入校验
  /// (desktopDeviceId / createdAt 必填), 整条写失败。
  Future<int> setAgentMode(String id, String agentMode) {
    return (update(sessionMirror)..where((t) => t.id.equals(id))).write(
      SessionMirrorCompanion(agentMode: Value(agentMode)),
    );
  }

  /// 只改标题 (同 [setAgentMode]: 半条 companion 不能走 upsert)
  Future<int> setTitle(String id, String title) {
    return (update(sessionMirror)..where((t) => t.id.equals(id))).write(
      SessionMirrorCompanion(title: Value(title)),
    );
  }

  Future<int> updateLastSeq(String id, int seq, int ts) {
    return (update(sessionMirror)..where((t) => t.id.equals(id))).write(
      SessionMirrorCompanion(lastSeq: Value(seq), lastMessageAt: Value(ts)),
    );
  }

  Future<int> deleteById(String id) {
    return (delete(sessionMirror)..where((t) => t.id.equals(id))).go();
  }

  Future<int> deleteByDesktopDeviceId(String desktopDeviceId) {
    return (delete(
      sessionMirror,
    )..where((t) => t.desktopDeviceId.equals(desktopDeviceId))).go();
  }
}
