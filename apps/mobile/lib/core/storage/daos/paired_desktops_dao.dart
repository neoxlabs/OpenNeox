/// paired_desktops_dao.dart — 已配对 Desktop 设备 CRUD.
library;

import 'package:drift/drift.dart';

import '../database.dart';
import '../tables.dart';

part 'paired_desktops_dao.g.dart';

@DriftAccessor(tables: [PairedDesktops])
class PairedDesktopsDao extends DatabaseAccessor<AppDatabase>
    with _$PairedDesktopsDaoMixin {
  PairedDesktopsDao(super.db);

  Future<List<PairedDesktop>> getAll() => select(pairedDesktops).get();

  Stream<List<PairedDesktop>> watchAll() => select(pairedDesktops).watch();

  /// 2026-06-24: 首页/会话列表只显示【真实能连】的桌面.
  ///   "能连" = 有 last_connected_at (历史上至少连上过一次) OR 7 天内 pair 过.
  ///   过滤掉: pair 了 7+ 天但从没连上的 (用户换 wifi / 桌面 reinstall 后留下的残留).
  ///   user 痛点: Mac 反复换 wifi → 每次 hostname 变 → mobile DB 攒 5+ 个 desktop entry,
  ///   实际只 1 个能连, UI 占位干扰严重. 7 天 grace 留给"刚 pair 还没第一次连"场景.
  Stream<List<PairedDesktop>> watchReachable() {
    final cutoff = DateTime.now().subtract(const Duration(days: 7)).millisecondsSinceEpoch;
    return (select(pairedDesktops)
      ..where((t) => t.lastConnectedAt.isNotNull() | t.pairedAt.isBiggerOrEqualValue(cutoff))
      ..orderBy([
        (t) => OrderingTerm.desc(t.lastConnectedAt),
        (t) => OrderingTerm.desc(t.pairedAt),
      ])).watch();
  }

  /// 启动时自动清理: 7 天前 pair 但从没连上过的 entry 全删 (明显残留).
  Future<int> cleanupStale({Duration olderThan = const Duration(days: 7)}) {
    final cutoff = DateTime.now().subtract(olderThan).millisecondsSinceEpoch;
    return (delete(pairedDesktops)
      ..where((t) => t.lastConnectedAt.isNull() & t.pairedAt.isSmallerThanValue(cutoff))).go();
  }

  /// 按 device_name 查 — pair 时去重用.
  Future<List<PairedDesktop>> findByDeviceName(String name) {
    return (select(pairedDesktops)
      ..where((t) => t.deviceName.equals(name))).get();
  }

  /// 启动时 dedupe 已存在的【同 device_name 多 entry】(历史残留):
  ///   同名只保留最新 (last_connected_at desc, then paired_at desc) 一条, 删其余.
  /// 这条等于"启动一次性回归 1 桌面 1 entry", 不依赖 pair 协议改动.
  Future<int> dedupeByName() async {
    final all = await getAll();
    final byName = <String, List<PairedDesktop>>{};
    for (final d in all) {
      final name = (d.deviceName ?? '').trim();
      if (name.isEmpty) continue;
      byName.putIfAbsent(name, () => []).add(d);
    }
    int removed = 0;
    for (final entry in byName.entries) {
      if (entry.value.length <= 1) continue;
      /* 排序: 有 last_connected_at 的优先 (DESC), 其次 paired_at DESC. 保留第一个. */
      entry.value.sort((a, b) {
        final lcA = a.lastConnectedAt ?? -1;
        final lcB = b.lastConnectedAt ?? -1;
        if (lcA != lcB) return lcB.compareTo(lcA);
        return b.pairedAt.compareTo(a.pairedAt);
      });
      for (var i = 1; i < entry.value.length; i++) {
        await deleteByDeviceId(entry.value[i].deviceId);
        removed++;
      }
    }
    return removed;
  }

  Future<PairedDesktop?> findByDeviceId(String deviceId) {
    return (select(pairedDesktops)
          ..where((t) => t.deviceId.equals(deviceId)))
        .getSingleOrNull();
  }

  /// PK 是自增 `id`, UNIQUE 在 `device_id` — insertOnConflictUpdate 默认按 PK
  /// 检测不会命中, 会抛 UNIQUE constraint failed. 用 DoUpdate + target=deviceId
  /// 显式指定 conflict 列, 让 SQLite 走 ON CONFLICT (device_id) DO UPDATE.
  Future<int> upsert(PairedDesktopsCompanion entry) {
    return into(pairedDesktops).insert(
      entry,
      onConflict: DoUpdate((_) => entry, target: [pairedDesktops.deviceId]),
    );
  }

  Future<int> deleteByDeviceId(String deviceId) {
    return (delete(pairedDesktops)..where((t) => t.deviceId.equals(deviceId)))
        .go();
  }

  Future<int> updateLastConnected(String deviceId, int ts) {
    return (update(pairedDesktops)..where((t) => t.deviceId.equals(deviceId)))
        .write(PairedDesktopsCompanion(lastConnectedAt: Value(ts)));
  }

  /// 换 WiFi 后 mDNS 找到新 IP/Port → 更新已配对记录, 不动 deviceToken 等不变字段.
  Future<int> updateLanEndpoint(String deviceId, String host, int port) {
    return (update(pairedDesktops)..where((t) => t.deviceId.equals(deviceId)))
        .write(PairedDesktopsCompanion(
          lastSeenLanIp: Value(host),
          lastSeenLanPort: Value(port),
        ));
  }
}
