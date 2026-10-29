/// desktop_ranking_test.dart — "该用哪台电脑" 排序的回归护栏.
///
/// 这条规则出过一次很贵的 P0 (2026-07-28 真机): 原实现是无排序的 `.first`,
/// 导致选中最早配对的失联老机, 发送动作反过来把健康连接顶掉。详见
/// `lib/core/session_routing/desktop_ranking.dart` 顶部注释。
///
/// 下面每个用例都对应一个真实会翻车的场景, 不是凑数。
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/session_routing/desktop_ranking.dart';

/// 测试替身 —— 只带排序用得上的三个字段 (时间用 epoch 毫秒, 与 drift 一致).
class TestDesktop {
  const TestDesktop(this.deviceId, {this.lastConnectedAt, required this.pairedAt});
  final String deviceId;
  final int? lastConnectedAt;
  final int pairedAt;
  @override
  String toString() => deviceId;
}

/// epoch 毫秒 —— 与 drift 里 PairedDesktop 的存储形式一致.
int _t(int daysAgo, {int minutesAgo = 0}) => DateTime(2026, 7, 28, 22, 0)
    .subtract(Duration(days: daysAgo, minutes: minutesAgo))
    .millisecondsSinceEpoch;

List<TestDesktop> rank(List<TestDesktop> input, {String? live}) => rankDesktopsForRouting<TestDesktop>(
      input,
      deviceId: (d) => d.deviceId,
      lastConnectedAt: (d) => d.lastConnectedAt,
      pairedAt: (d) => d.pairedAt,
      liveDeviceId: live,
    );

void main() {
  _livenessTests();
  _staleButRelativeTests();
  _preferredTests();
  group('已连接的那台永远排第一', () {
    test('P0 原场景: 老机在前 + 新机正连着 → 新机胜出', () {
      /* 真机复现: 「Mac」7 天前配对且插入更早, 「kimberly-air」刚配对且 WS 已
       * authenticated。旧实现取 .first 拿到 Mac → 连接被顶掉 → 发送失败。 */
      final old = TestDesktop('mac-old', lastConnectedAt: _t(7), pairedAt: _t(30));
      final fresh =
          TestDesktop('air-new', lastConnectedAt: _t(0, minutesAgo: 10), pairedAt: _t(0, minutesAgo: 12));

      final r = rank([old, fresh], live: 'air-new');
      expect(r.first.deviceId, 'air-new');
    });

    test('即使已连接的那台"最近连接时间"更旧, 仍然排第一', () {
      /* lastConnectedAt 的写入时机可能落后于真实连接状态 (刚握手还没落库),
       * 此时绝不能因为时间戳旧就把正连着的那台挤下去 —— 否则又会触发换连。 */
      final live = TestDesktop('live', lastConnectedAt: _t(9), pairedAt: _t(9));
      final recent = TestDesktop('recent', lastConnectedAt: _t(0), pairedAt: _t(3));

      final r = rank([live, recent], live: 'live');
      expect(r.first.deviceId, 'live');
    });

    test('liveDeviceId 指向一台不在列表里的设备 → 退化为按时间排序, 不炸', () {
      final a = TestDesktop('a', lastConnectedAt: _t(5), pairedAt: _t(9));
      final b = TestDesktop('b', lastConnectedAt: _t(1), pairedAt: _t(9));

      final r = rank([a, b], live: 'ghost');
      expect(r.map((e) => e.deviceId), ['b', 'a']);
    });
  });

  group('没有连接时按最近连接时间倒序', () {
    test('三台混合 → 最近连过的在最前', () {
      final a = TestDesktop('a', lastConnectedAt: _t(7), pairedAt: _t(30));
      final b = TestDesktop('b', lastConnectedAt: _t(1), pairedAt: _t(20));
      final c = TestDesktop('c', lastConnectedAt: _t(3), pairedAt: _t(10));

      expect(rank([a, b, c]).map((e) => e.deviceId), ['b', 'c', 'a']);
    });

    test('从没连上过 (lastConnectedAt=null) → 回落用 pairedAt', () {
      final never = TestDesktop('never', pairedAt: _t(0, minutesAgo: 5)); // 刚配对
      final stale = TestDesktop('stale', lastConnectedAt: _t(6), pairedAt: _t(40));

      /* 刚配对但还没连上过的, 应当优先于半年没连的老机 —— 用户刚做的动作最能
       * 代表意图。旧实现里这台会因为插入顺序靠后而永远选不上。 */
      expect(rank([stale, never]).first.deviceId, 'never');
    });

    test('全部都没连过 → 按 pairedAt 倒序', () {
      final x = TestDesktop('x', pairedAt: _t(9));
      final y = TestDesktop('y', pairedAt: _t(2));
      expect(rank([x, y]).map((e) => e.deviceId), ['y', 'x']);
    });
  });

  group('边界', () {
    test('空列表原样返回', () {
      expect(rank([]), isEmpty);
    });

    test('单台时原样返回 (不做无谓拷贝/排序)', () {
      final only = TestDesktop('only', pairedAt: _t(1));
      expect(rank([only]).single.deviceId, 'only');
    });

    test('不修改入参列表 (调用方可能复用)', () {
      final a = TestDesktop('a', lastConnectedAt: _t(7), pairedAt: _t(9));
      final b = TestDesktop('b', lastConnectedAt: _t(1), pairedAt: _t(9));
      final input = [a, b];
      rank(input, live: 'b');
      expect(input.map((e) => e.deviceId), ['a', 'b'], reason: '原列表顺序不该被改');
    });

    test('时间完全相同也不抛 (排序稳定即可)', () {
      final same = _t(2);
      final a = TestDesktop('a', lastConnectedAt: same, pairedAt: same);
      final b = TestDesktop('b', lastConnectedAt: same, pairedAt: same);
      expect(rank([a, b]).length, 2);
    });
  });
}

/* ══════════════════════════════════════════════════════════════════════
 * 存活优先 (2026-08-09 真机实锤)
 *
 * 账号下同一台 Mac 因为改过名/重装留了两条记录 —— device_id 和 pubkey 都变了,
 * 名字也不同 (`Mac` vs `kimberly-air-11531`), 按名字去重合不掉。而早就关机的
 * 那条碰巧有更晚的 lastConnectedAt, 于是手机每次冷启动都固执地去连那台死机器,
 * 两分钟前还在 announce 的活机器被跳过 —— 用户看到"电脑明明开着却连不上"。
 *
 * `/api/v1/devices/my` 一直在返回 last_announce_at, 客户端一直扔掉。
 * 这一组把"服务端说它还活着"钉成压过本地历史记忆的依据。
 * ══════════════════════════════════════════════════════════════════════ */

class _D {
  const _D(this.id, {this.connectedAt, required this.pairedAt, this.announceAt});
  final String id;
  final int? connectedAt;
  final int pairedAt;
  final int? announceAt;
}

void _livenessTests() {
  final now = DateTime(2026, 8, 9, 18, 0);
  final nowMs = now.millisecondsSinceEpoch;
  int minsAgo(int m) => nowMs - m * 60 * 1000;
  int daysAgo(int d) => nowMs - d * 24 * 60 * 60 * 1000;

  List<String> rank(List<_D> ds, {String? live}) => rankDesktopsForRouting<_D>(
        ds,
        deviceId: (d) => d.id,
        lastConnectedAt: (d) => d.connectedAt,
        pairedAt: (d) => d.pairedAt,
        lastAnnounceAt: (d) => d.announceAt,
        liveDeviceId: live,
        now: now,
      ).map((d) => d.id).toList();

  group('存活优先 — 服务端事实压过本地记忆', () {
    test('真机原场景: 死机器连接更近, 活机器仍然胜出', () {
      // Mac: 昨天还连过 (本地记忆更新), 但服务端三天没见过它 → 已经死了
      // air:  从没连上过, 但服务端两分钟前刚见过 → 它活着
      final order = rank([
        _D('Mac', connectedAt: daysAgo(1), pairedAt: daysAgo(30), announceAt: daysAgo(3)),
        _D('air', pairedAt: minsAgo(5), announceAt: minsAgo(2)),
      ]);
      expect(order.first, 'air',
          reason: '两分钟前还在上报的必须赢过昨天连过但已经死掉的');
    });

    test('都还活着 → 上报更近的排前面', () {
      final order = rank([
        _D('a', pairedAt: daysAgo(10), announceAt: minsAgo(8)),
        _D('b', pairedAt: daysAgo(10), announceAt: minsAgo(1)),
      ]);
      expect(order.first, 'b');
    });

    test('两台都活着且都有连接记录 → 跟用户的使用习惯走 (2026-09-22)', () {
      /* 用户实拍: Mac + Windows 都开着, 手机每次自动连接都去 Windows ——
       * 因为原来这一层比的是 announce 秒级新旧 (谁刚上报过), 那不是用户的习惯。 */
      final order = rank([
        _D('win', connectedAt: daysAgo(3), pairedAt: daysAgo(30), announceAt: minsAgo(1)),
        _D('mac', connectedAt: minsAgo(30), pairedAt: daysAgo(60), announceAt: minsAgo(2)),
      ]);
      expect(order.first, 'mac', reason: '两台都在线时, 该跟着"上次用的那台"走');
    });

    test('只有一台新鲜 → 仍然新鲜的那台胜 (08-09 的修复不被破坏)', () {
      /* 改过名留下的死记录: 它的 lastConnectedAt 更新, 但服务端三天没见过它 */
      final order = rank([
        _D('dead', connectedAt: minsAgo(10), pairedAt: daysAgo(30), announceAt: daysAgo(3)),
        _D('alive', connectedAt: daysAgo(9), pairedAt: daysAgo(2), announceAt: minsAgo(1)),
      ]);
      expect(order.first, 'alive');
    });

    test('都过期 → 退回按最近连接时间 (不因为都不新鲜就乱序)', () {
      final order = rank([
        _D('old', connectedAt: daysAgo(9), pairedAt: daysAgo(40), announceAt: daysAgo(9)),
        _D('newer', connectedAt: daysAgo(2), pairedAt: daysAgo(40), announceAt: daysAgo(8)),
      ]);
      expect(order.first, 'newer');
    });

    test('正连着的那台仍然压过一切 —— 包括更新鲜的别人', () {
      // 已连上的不能被抢走, 否则就是老那条"发送劫持连接"的 P0 复发
      final order = rank([
        _D('fresh', pairedAt: daysAgo(1), announceAt: minsAgo(1)),
        _D('connected', connectedAt: daysAgo(5), pairedAt: daysAgo(20), announceAt: daysAgo(5)),
      ], live: 'connected');
      expect(order.first, 'connected');
    });

    test('服务端没给 announce (老服务端 / 扫码配对的机器) → 行为跟以前一致', () {
      final order = rank([
        _D('a', connectedAt: daysAgo(5), pairedAt: daysAgo(9)),
        _D('b', connectedAt: daysAgo(1), pairedAt: daysAgo(9)),
      ]);
      expect(order.first, 'b');
    });

    test('只有一台有 announce → 它赢, 但不影响另一台仍可选', () {
      final order = rank([
        _D('noinfo', connectedAt: minsAgo(30), pairedAt: daysAgo(3)),
        _D('alive', pairedAt: daysAgo(3), announceAt: minsAgo(2)),
      ]);
      expect(order, ['alive', 'noinfo']);
    });

    test('新鲜窗口边界: 刚好过期的不算活着', () {
      final order = rank([
        _D('stale', connectedAt: minsAgo(1), pairedAt: daysAgo(1), announceAt: minsAgo(11)),
        _D('other', connectedAt: minsAgo(2), pairedAt: daysAgo(1), announceAt: minsAgo(30)),
      ]);
      // 两台都超出 10 分钟窗口 → 退回按连接时间, stale 更近
      expect(order.first, 'stale');
    });
  });
}

/// 第二次实测补的一层 —— 都不在线时, announce 的**相对新旧**仍然有意义.
void _staleButRelativeTests() {
  final now = DateTime(2026, 8, 9, 19, 0);
  int minsAgo(int m) => now.millisecondsSinceEpoch - m * 60 * 1000;

  List<String> rank(List<_D> ds) => rankDesktopsForRouting<_D>(
        ds,
        deviceId: (d) => d.id,
        lastConnectedAt: (d) => d.connectedAt,
        pairedAt: (d) => d.pairedAt,
        lastAnnounceAt: (d) => d.announceAt,
        now: now,
      ).map((d) => d.id).toList();

  group('都不在线时仍按上报新旧排 (真实数据: 11.6 小时 vs 36.7 天)', () {
    test('11 小时前露面的赢过 36 天前的 —— 哪怕后者本地连接记录更新', () {
      final order = rank([
        _D('Mac', connectedAt: minsAgo(60), pairedAt: minsAgo(99999),
            announceAt: minsAgo(52844)),
        _D('air', connectedAt: minsAgo(600), pairedAt: minsAgo(9999),
            announceAt: minsAgo(696)),
      ]);
      expect(order.first, 'air',
          reason: '差两个数量级不能因为都超出新鲜窗口就一视同仁');
    });

    test('一方没有 announce → 不拿它跟有 announce 的比, 退回连接时间', () {
      final order = rank([
        _D('qr', connectedAt: minsAgo(5), pairedAt: minsAgo(100)),
        _D('acct', connectedAt: minsAgo(500), pairedAt: minsAgo(100),
            announceAt: minsAgo(300)),
      ]);
      expect(order.first, 'qr', reason: '扫码配对的机器不归账号 sync 管, 没有可比的 announce');
    });
  });
}

/* ══════════════════════════════════════════════════════════════════════
 * 首选电脑压过客观排序 (2026-09-22 用户实拍)
 *
 * 配了 Mac + Windows、首选设在 Mac, 但**每次冷启动自动重连**都连去 Windows。
 * 排序函数答的是"客观上最可能连得上哪台", 它不知道用户想用哪台 —— 偏好必须是
 * 它之上的一层。这条规则有三个调用点 (发消息 / 逐台尝试 / 冷启动重连), 而
 * 第三处漏了, 它恰好是用户最先看到的那次连接。
 * ══════════════════════════════════════════════════════════════════════ */

void _preferredTests() {
  List<String> hoist(List<String> ids, String? preferred) =>
      hoistPreferred(ids, preferred, deviceId: (s) => s).toList();

  group('hoistPreferred — 用户的选择压过客观排序', () {
    test('首选排在后面 → 提到最前 (真机场景: win 在前, 用户要 mac)', () {
      expect(hoist(['win', 'air', 'mac'], 'mac'), ['mac', 'win', 'air']);
    });

    test('没设首选 → 原样, 客观排序不受影响', () {
      expect(hoist(['win', 'air'], null), ['win', 'air']);
      expect(hoist(['win', 'air'], ''), ['win', 'air']);
      expect(hoist(['win', 'air'], '   '), ['win', 'air']);
    });

    test('首选已在首位 → 原对象返回, 不做无谓拷贝', () {
      final input = ['mac', 'win'];
      expect(
        identical(hoistPreferred(input, 'mac', deviceId: (s) => s), input),
        isTrue,
      );
    });

    test('首选不在列表里 (已解除配对的机器) → 原样, 不炸', () {
      expect(hoist(['win', 'air'], 'ghost'), ['win', 'air']);
    });

    test('其余设备的相对顺序保持不变', () {
      expect(hoist(['a', 'b', 'c', 'd'], 'c'), ['c', 'a', 'b', 'd']);
    });
  });

  /* 2026-09-26 用户: Wi-Fi 切到远程时「不是切换到当前的电脑」—— 局域网一断,
   * 补连只看首选和心跳, 心跳更新鲜的另一台被连上。当前电脑要压过首选。 */
  group('orderByUserIntent — 当前电脑 > 首选 > 客观排序', () {
    List<String> order(List<String> ids, {String? preferred, String? current}) =>
        orderByUserIntent(ids, preferredDeviceId: preferred, currentDeviceId: current, deviceId: (s) => s);

    test('刚断开的当前电脑排第一, 哪怕另一台心跳更新鲜、哪怕首选是别的', () {
      expect(order(['win', 'mac'], current: 'mac'), ['mac', 'win']);
      expect(order(['win', 'air', 'mac'], preferred: 'air', current: 'mac'), ['mac', 'air', 'win']);
    });

    test('没有当前电脑 (过了粘性窗口 / 冷启动) → 回到首选 + 客观排序', () {
      expect(order(['win', 'mac'], preferred: 'mac'), ['mac', 'win']);
      expect(order(['win', 'mac']), ['win', 'mac']);
    });

    test('当前电脑已解除配对 → 不炸, 按首选', () {
      expect(order(['win', 'mac'], preferred: 'mac', current: 'ghost'), ['mac', 'win']);
    });
  });
}
