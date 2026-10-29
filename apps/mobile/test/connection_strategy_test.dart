/// connection_strategy_test.dart — 选路 / 网络变化 / 状态文案的纯决策.
///
/// 2026-09-17 用户原话: "我都是移动网络了，你还去测试同 WiFi 连接，这不是扯淡吗？"
/// 这里锁住: 蜂窝下绝不碰 LAN; Wi-Fi 下 LAN 与远程赛跑; 切网不拆活着的远程;
/// 状态栏说的是真正在走的路。
library;

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/network/connection_strategy.dart';

void main() {
  group('classifyConnectivity', () {
    test('wifi / ethernet → 可能有局域网', () {
      expect(classifyConnectivity([ConnectivityResult.wifi]),
          NetworkKind.localCapable);
      expect(classifyConnectivity([ConnectivityResult.ethernet]),
          NetworkKind.localCapable);
      expect(
          classifyConnectivity(
              [ConnectivityResult.wifi, ConnectivityResult.mobile]),
          NetworkKind.localCapable,
          reason: 'Android 常同时报 wifi + mobile');
    });

    test('只有蜂窝 (含 vpn 跑在蜂窝上) → cellularOnly', () {
      expect(classifyConnectivity([ConnectivityResult.mobile]),
          NetworkKind.cellularOnly);
      expect(
          classifyConnectivity(
              [ConnectivityResult.vpn, ConnectivityResult.mobile]),
          NetworkKind.cellularOnly);
      expect(
          classifyConnectivity(
              [ConnectivityResult.mobile, ConnectivityResult.other]),
          NetworkKind.cellularOnly);
    });

    test('none / 空 → offline', () {
      expect(classifyConnectivity([ConnectivityResult.none]),
          NetworkKind.offline);
      expect(classifyConnectivity(const []), NetworkKind.offline);
    });

    test('只报 vpn / other → unknown (看不出底下是什么, 不做假设)', () {
      expect(classifyConnectivity([ConnectivityResult.vpn]),
          NetworkKind.unknown);
      expect(classifyConnectivity([ConnectivityResult.other]),
          NetworkKind.unknown);
    });
  });

  group('planRoute', () {
    RoutePlan plan(
      NetworkKind network, {
      bool lan = true,
      bool relayKey = true,
      bool loggedIn = true,
      bool autoFallback = true,
    }) =>
        planRoute(
          network: network,
          hasLanToken: lan,
          hasRelayKey: relayKey,
          loggedIn: loggedIn,
          autoFallbackEnabled: autoFallback,
        );

    test('蜂窝 + 远程可用 → 只走远程, 不碰 LAN', () {
      final p = plan(NetworkKind.cellularOnly);
      expect(p.kind, RouteKind.relayOnly);
      expect(p.usesLan, isFalse);
      expect(p.usesRelay, isTrue);
    });

    test('蜂窝 + 远程不可用 → unavailable 并说清原因, 不偷偷去试 LAN', () {
      final notLoggedIn = plan(NetworkKind.cellularOnly, loggedIn: false);
      expect(notLoggedIn.kind, RouteKind.unavailable);
      expect(notLoggedIn.usesLan, isFalse);
      expect(notLoggedIn.reason, contains('移动网络'));
      expect(notLoggedIn.reason, contains('登录'));

      final off = plan(NetworkKind.cellularOnly, autoFallback: false);
      expect(off.kind, RouteKind.unavailable);
      expect(off.reason, contains('设置中关闭'));

      final noKey = plan(NetworkKind.cellularOnly, relayKey: false);
      expect(noKey.kind, RouteKind.unavailable);
      expect(noKey.reason, contains('密钥'));
    });

    test('Wi-Fi + 两条路都有 → 赛跑', () {
      expect(plan(NetworkKind.localCapable).kind, RouteKind.raceLanFirst);
    });

    test('unknown 网络 → 同 Wi-Fi 处理 (赛跑), 不假设是蜂窝', () {
      expect(plan(NetworkKind.unknown).kind, RouteKind.raceLanFirst);
    });

    test('Wi-Fi + 远程不可用 → 只走 LAN, 且带上"为什么没走远程"', () {
      final p = plan(NetworkKind.localCapable, loggedIn: false);
      expect(p.kind, RouteKind.lanOnly);
      expect(p.relayUnavailableReason, isNotNull);
    });

    test('Wi-Fi + 只有远程密钥 (账号配对无 LAN token) → 只走远程', () {
      expect(plan(NetworkKind.localCapable, lan: false).kind,
          RouteKind.relayOnly);
    });

    test('两条路都不可用 → unavailable', () {
      final p = plan(NetworkKind.localCapable, lan: false, loggedIn: false);
      expect(p.kind, RouteKind.unavailable);
      expect(p.reason, isNotNull);
    });

    test('断网 → 等网络, 不拨号', () {
      final p = plan(NetworkKind.offline);
      expect(p.kind, RouteKind.waitForNetwork);
      expect(p.usesLan, isFalse);
      expect(p.usesRelay, isFalse);
    });
  });

  group('decideOnNetworkChange', () {
    NetworkChangeAction decide(
      NetworkKind from,
      NetworkKind to,
      ActivePath via,
    ) =>
        decideOnNetworkChange(from: from, to: to, connectedVia: via);

    test('Wi-Fi → 蜂窝, 远程连着 → 只验证, 绝不拆远程', () {
      expect(
        decide(NetworkKind.localCapable, NetworkKind.cellularOnly,
            ActivePath.relay),
        NetworkChangeAction.verifyCurrent,
      );
    });

    test('蜂窝 → Wi-Fi, 远程连着 → 保持远程 + 后台试 LAN', () {
      expect(
        decide(NetworkKind.cellularOnly, NetworkKind.localCapable,
            ActivePath.relay),
        NetworkChangeAction.keepRelayTryLan,
      );
    });

    test('Wi-Fi → 蜂窝, LAN 连着 → LAN 必死, 重连 (按新网络走远程)', () {
      expect(
        decide(
            NetworkKind.localCapable, NetworkKind.cellularOnly, ActivePath.lan),
        NetworkChangeAction.reconnect,
      );
    });

    test('Wi-Fi → Wi-Fi, LAN 连着 → 验证 (可能换了 SSID)', () {
      expect(
        decide(
            NetworkKind.localCapable, NetworkKind.localCapable, ActivePath.lan),
        NetworkChangeAction.verifyCurrent,
      );
    });

    test('蜂窝重复事件, 远程连着 → 忽略', () {
      expect(
        decide(NetworkKind.cellularOnly, NetworkKind.cellularOnly,
            ActivePath.relay),
        NetworkChangeAction.ignore,
      );
    });

    test('任何 → 断网: 不抖动, 等着', () {
      for (final via in ActivePath.values) {
        for (final from in NetworkKind.values) {
          expect(decide(from, NetworkKind.offline, via),
              NetworkChangeAction.waitOffline);
        }
      }
    });

    test('没连着时网络变了 (非断网) → 重连', () {
      for (final to in [
        NetworkKind.cellularOnly,
        NetworkKind.localCapable,
        NetworkKind.unknown,
      ]) {
        expect(decide(NetworkKind.offline, to, ActivePath.none),
            NetworkChangeAction.reconnect);
      }
    });

    test('远程连着时, 除非断网, 永远不会得到 reconnect', () {
      for (final from in NetworkKind.values) {
        for (final to in NetworkKind.values) {
          expect(decide(from, to, ActivePath.relay),
              isNot(NetworkChangeAction.reconnect),
              reason: '$from→$to 拆了一条活着的远程连接');
        }
      }
    });
  });

  group('状态文案必须是真话', () {
    const relayOnly = RoutePlan(RouteKind.relayOnly);
    const race = RoutePlan(RouteKind.raceLanFirst);

    test('蜂窝走远程失败, 文案不提 Wi-Fi', () {
      final msg = retryStatusMessage(
        plan: relayOnly,
        nextIn: const Duration(seconds: 2),
        detail: '电脑已离线',
      );
      expect(msg, isNot(contains('Wi-Fi')));
      expect(msg, contains('远程'));
      expect(msg, contains('电脑已离线'));
      expect(msg, contains('2 秒后重试'));
    });

    /* 2026-09-18 契约改了: 状态栏只说"在连 / 连上了 / 连不上(+短理由)"。
     * 走哪条路是实现细节, 写进去就是用户原话里的"废话太多 解释一堆", 长句还会
     * 在窄屏换行把行高撑开。真话的要求不变: 蜂窝下不许提 Wi-Fi。 */
    test('正在连接: 一句话, 且蜂窝下不提 Wi-Fi', () {
      final cellular = connectingStatusMessage(
        RouteKind.relayOnly,
        NetworkKind.cellularOnly,
      );
      expect(cellular, isNot(contains('Wi-Fi')));
      expect(cellular, '正在远程连接');
      final race = connectingStatusMessage(
        RouteKind.raceLanFirst,
        NetworkKind.localCapable,
      );
      expect(race, '正在连接');
      expect(race.runes.length, lessThanOrEqualTo(12));
    });

    test('赛跑失败: 不铺开讲两条路', () {
      final msg = retryStatusMessage(
        plan: race,
        nextIn: const Duration(seconds: 4),
      );
      expect(msg, '没连上 · 4 秒后重试');
    });

    test('失败原因太长就不塞进状态栏 (换行会把行高撑开)', () {
      final short = retryStatusMessage(
        plan: relayOnly,
        nextIn: const Duration(seconds: 2),
        detail: '电脑已离线',
      );
      expect(short, contains('电脑已离线'));
      final long = retryStatusMessage(
        plan: relayOnly,
        nextIn: const Duration(seconds: 2),
        detail: 'WebSocketException: connection closed before full header was received',
      );
      expect(long, '远程没连上 · 2 秒后重试');
    });

    test('只走 LAN: 必须说明为什么没走远程 (降级可见)', () {
      const lanOnly = RoutePlan(RouteKind.lanOnly,
          relayUnavailableReason: '登录后才能远程连接');
      final msg = retryStatusMessage(
          plan: lanOnly, nextIn: const Duration(milliseconds: 120));
      expect(msg, contains('登录后才能远程连接'));
    });

    test('半路掉线说"断开", 不说"没连上"', () {
      final msg = retryStatusMessage(
        plan: race,
        nextIn: const Duration(seconds: 1),
        detail: '连接已断开',
        dropped: true,
      );
      expect(msg, startsWith('已断开'));
      expect(msg, isNot(contains('没连上')));
    });

    /* 2026-09-17 线上定位: 电脑心跳在 (presence online) 但它的中继长连接 24 小时
     * 没拨号。手机只看 online 就拨, 连上中继拿到"对端离线"再断开, 每轮 0.6 秒,
     * 无限循环 —— 用户判词"远程连接是废物"。现在服务端给出中继事实, 这里必须认。 */
    test('电脑在线但中继没接入 → 远程不可用, 且理由点名中继', () {
      final why = relayUnavailableReason(
        hasRelayKey: true,
        loggedIn: true,
        autoFallbackEnabled: true,
        peerRelayOnline: false,
      );
      expect(why, isNotNull);
      expect(why, contains('远程通道'));
      expect(why!.runes.length, lessThanOrEqualTo(12));
    });

    test('服务端没说中继状态 (老服务端) → 按能连处理, 不许拦', () {
      expect(
        relayUnavailableReason(
          hasRelayKey: true,
          loggedIn: true,
          autoFallbackEnabled: true,
        ),
        isNull,
      );
      expect(
        planRoute(
          network: NetworkKind.cellularOnly,
          hasLanToken: false,
          hasRelayKey: true,
          loggedIn: true,
          autoFallbackEnabled: true,
        ).kind,
        RouteKind.relayOnly,
      );
    });

    test('中继没接入 + 有 LAN token → 退回同 Wi-Fi, 不是彻底不可用', () {
      final plan = planRoute(
        network: NetworkKind.localCapable,
        hasLanToken: true,
        hasRelayKey: true,
        loggedIn: true,
        autoFallbackEnabled: true,
        peerRelayOnline: false,
      );
      expect(plan.kind, RouteKind.lanOnly);
      expect(plan.relayUnavailableReason, contains('远程通道'));
    });

    test('慢速档文案写分钟', () {
      expect(
        retryStatusMessage(plan: relayOnly, nextIn: const Duration(minutes: 5)),
        contains('5 分钟后重试'),
      );
    });
  });

  test('远程最坏定局时间覆盖 token 封顶 + WS 超时 + 验证 + 让先', () {
    final sum = kConnectSideTaskCap +
        const Duration(seconds: 6) +
        kRelayPeerVerifyTimeout +
        kRelayHeadStart;
    expect(kRelayWorstCaseSettle >= sum, isTrue);
  });
}
