/// database.dart — AppDatabase + Riverpod provider 入口.
///
/// drift 单例, 数据库文件存 ApplicationDocumentsDirectory/neox.sqlite.
/// codegen 生成 `database.g.dart` (`dart run build_runner build`).
library;

import 'dart:io';

import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import 'daos/inbox_pending_dao.dart';
import 'daos/paired_desktops_dao.dart';
import 'daos/session_events_dao.dart';
import 'daos/session_mirror_dao.dart';
import 'tables.dart';

part 'database.g.dart';

@DriftDatabase(
  tables: [PairedDesktops, SessionMirror, SessionEvents, InboxPending, ChatTurnSamples],
  daos: [
    PairedDesktopsDao,
    SessionMirrorDao,
    SessionEventsDao,
    InboxPendingDao,
  ],
)
class AppDatabase extends _$AppDatabase {
  AppDatabase() : super(_openConnection());

  /// 测试入口 — 允许塞入内存 db
  AppDatabase.forTesting(super.e);

  @override
  int get schemaVersion => 6;

  @override
  MigrationStrategy get migration => MigrationStrategy(
        onUpgrade: (m, from, to) async {
          if (from < 2) {
            /* v2 (2026-07-20): session_mirror.kind — 桌面 image 会话降级标识 */
            await m.addColumn(sessionMirror, sessionMirror.kind);
          }
          if (from < 3) {
            /* v3 (2026-07-28): session_mirror.parent_session_id — sub-agent 子会话
             * 父子关系, 抽屉嵌套显示用 */
            await m.addColumn(sessionMirror, sessionMirror.parentSessionId);
          }
          if (from < 4) {
            /* v4 (2026-08-09): paired_desktops.last_announce_at — 服务端记的
             * "这台最后一次上报存活"。用来判断该连哪台, 见 tables.dart 的注释:
             * 之前只能靠 lastConnectedAt, 会把早就死掉的旧记录当成首选。 */
            await m.addColumn(pairedDesktops, pairedDesktops.lastAnnounceAt);
          }
          if (from < 5) {
            /* v5 (2026-09-04): session_mirror.agent_mode — 这次会话是对话/工作/编码。
             * 模式此前只活在 SharedPreferences 的全局当前值里, 从没写进会话,
             * 见 tables.dart 那条注释里的两个后果。 */
            await m.addColumn(sessionMirror, sessionMirror.agentMode);
          }
          if (from < 6) {
            /* v6 (2026-10-18): chat_turn_samples — Chat 每轮首字打点 (chat:C8-11)。
             * 以前首字只在日志里, 重启就没了; 有这张表才能按模型 / 轮次查延迟。 */
            await m.createTable(chatTurnSamples);
          }
        },
      );
}

LazyDatabase _openConnection() {
  return LazyDatabase(() async {
    final dir = await getApplicationDocumentsDirectory();
    final file = File(p.join(dir.path, 'neox.sqlite'));
    return NativeDatabase.createInBackground(file);
  });
}

/// 全局 db provider — App 生命周期内单例
final appDatabaseProvider = Provider<AppDatabase>((ref) {
  final db = AppDatabase();
  ref.onDispose(db.close);
  return db;
});
