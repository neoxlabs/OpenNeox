/// pilot_chat_merge.dart — live 写出来的气泡与账本回读并成一条时间线 (pilot:U-08).
///
/// 一次来回会同时走两条路: 实时流把正在写的一段收成气泡 (没有账本 id), 这一轮结束后
/// 聊天页又从账本拉一遍 (同一句话有了 id)。原来 _load 直接用账本覆盖界面,
/// 两边时间戳差几秒、文字一样, 就出现两个一模一样的气泡。
///
/// 合并规则:
///   - 账本为准: 同一个 id, 或者同 role + 同一句话 (时间差在窗口内) 的本地行, 换回账本行; 本地没落账的行保留;
///   - 账本内部只有 id 相同才算重复 —— 同一句话隔一会儿真的说两次, 是两条;
///   - 最后按时间排, 同一时刻账本在前、本地在后, 顺序稳定。
library;

/// 「同一句话」的时间窗口: live 与账本的时间戳只差几秒, 但客户端时钟可能偏几分钟
const pilotMergeWindow = Duration(minutes: 3);

/// 把 [local] (界面上的行) 与 [ledger] (账本回读, 旧 → 新) 并成一条时间线
List<T> mergePilotChatLines<T>({
  required List<T> local,
  required List<T> ledger,
  required int? Function(T) idOf,
  required String Function(T) roleOf,
  required String Function(T) textOf,
  required DateTime Function(T) atOf,
  required T Function(T localRow, T ledgerRow) matched,
  Duration window = pilotMergeWindow,
}) {
  bool same(T a, T b) {
    final ia = idOf(a), ib = idOf(b);
    if (ia != null && ib != null) return ia == ib;
    if (roleOf(a) != roleOf(b)) return false;
    if (textOf(a).trim() != textOf(b).trim()) return false;
    final diff = atOf(a).difference(atOf(b)).inMilliseconds.abs();
    return diff <= window.inMilliseconds;
  }

  /* 账本先按 id 去重 (没有 id 的行保留: 那不是这条通路能判断的) */
  final rows = <T>[];
  for (final row in ledger) {
    final id = idOf(row);
    if (id != null && rows.any((k) => idOf(k) == id)) continue;
    rows.add(row);
  }

  final used = List<bool>.filled(rows.length, false);
  final replaced = <int, T>{};
  final extras = <T>[];
  for (final l in local) {
    var hit = -1;
    for (var i = 0; i < rows.length; i++) {
      if (used[i]) continue;
      if (same(rows[i], l)) {
        hit = i;
        break;
      }
    }
    if (hit >= 0) {
      used[hit] = true;
      replaced[hit] = matched(l, rows[hit]);
    } else {
      extras.add(l);
    }
  }

  /* (时间, 账本在前, 原顺序) 排序; Dart 的 sort 不稳定, 自己带序号 */
  final shaped = <(DateTime, int, int, T)>[
    for (var i = 0; i < rows.length; i++) (atOf(rows[i]), 0, i, replaced[i] ?? rows[i]),
    for (var i = 0; i < extras.length; i++) (atOf(extras[i]), 1, i, extras[i]),
  ]..sort((a, b) {
      final byTime = a.$1.compareTo(b.$1);
      if (byTime != 0) return byTime;
      final bySource = a.$2.compareTo(b.$2);
      return bySource != 0 ? bySource : a.$3.compareTo(b.$3);
    });
  return [for (final r in shaped) r.$4];
}
