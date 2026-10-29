/// reconnect_backoff_test.dart — 重连退避档位.
///
/// 背景 (2026-08-11 模拟器实录): 对着一台关机的电脑, 日志打出
/// `smart reconnect → 慢速档 (已试 1255 次, 每 20s 重试)`。每轮是
/// mDNS 扫描 + LAN 直连 + 云中继三件事, 射频被永久地每 20 秒拉起来一次。
///
/// 这里锁三条纪律:
///   1. 越试越远 —— 20s → 60s → 5min 封顶, 后台一律 5min;
///   2. **永不放弃** —— 再大的 attempt 也返回一个有限间隔, 绝不返回 null /
///      Duration.zero / 无穷。这条是历史教训: 原版"试 3 次就永久搁置", 电脑
///      恢复后手机再也不回来, 用户必须手动点。
///   3. (2026-09-17) 远程有自己的快速档 1s/2s/4s —— 原来远程失败跟 LAN 共用
///      计数, LAN 那 3 次在拨远程之前就被用光, 远程失败一次直接 20s。
///
/// 2026-09-17: 函数从 ws_client_provider.dart 挪到 connection_strategy.dart,
/// 档位数值不变, 所以原有断言原样保留。
library;

import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/network/connection_strategy.dart';

void main() {
  Duration fg(int attempt) =>
      slowReconnectInterval(attempt: attempt, foreground: true);
  Duration bg(int attempt) =>
      slowReconnectInterval(attempt: attempt, foreground: false);

  group('前台: 越试越远', () {
    test('刚进慢速档 → 20s', () {
      /* 快速档是 attempt 1..3, 第 4 次开始进慢速档 */
      expect(fg(4), const Duration(seconds: 20));
      expect(fg(10), const Duration(seconds: 20));
      expect(fg(13), const Duration(seconds: 20), reason: '慢速第 10 轮仍是 20s');
    });

    test('慢速第 11 轮起 → 60s', () {
      expect(fg(14), const Duration(seconds: 60));
      expect(fg(23), const Duration(seconds: 60));
    });

    test('慢速第 21 轮起 → 5 分钟封顶', () {
      expect(fg(24), const Duration(minutes: 5));
      expect(fg(100), const Duration(minutes: 5));
      expect(fg(1255), const Duration(minutes: 5),
          reason: '实录里那个 1255 次, 现在是 5 分钟一次而不是 20 秒一次');
    });
  });

  group('后台: 一律最远档', () {
    test('刚掉线就退到 5 分钟, 不等升档', () {
      expect(bg(4), const Duration(minutes: 5));
      expect(bg(1), const Duration(minutes: 5));
      expect(bg(1255), const Duration(minutes: 5));
    });
  });

  group('永不放弃', () {
    test('任意 attempt 都给出有限且为正的间隔', () {
      for (final n in [1, 4, 14, 24, 999, 100000]) {
        for (final foreground in [true, false]) {
          for (final relay in [true, false]) {
            final d = reconnectDelay(
              attempt: n,
              foreground: foreground,
              relayInvolved: relay,
            );
            expect(d > Duration.zero, isTrue,
                reason: 'attempt=$n foreground=$foreground relay=$relay 返回了非正间隔');
            expect(d <= const Duration(minutes: 5), isTrue,
                reason: '封顶不能超过 5 分钟, 否则等于事实上的放弃');
          }
          final s = slowReconnectInterval(attempt: n, foreground: foreground);
          expect(s > Duration.zero, isTrue);
          expect(s <= const Duration(minutes: 5), isTrue);
        }
      }
    });
  });

  group('快速档: 远程和 LAN 各有各的节奏', () {
    Duration relay(int a) =>
        reconnectDelay(attempt: a, foreground: true, relayInvolved: true);
    Duration lan(int a) =>
        reconnectDelay(attempt: a, foreground: true, relayInvolved: false);

    test('远程失败 → 1s / 2s / 4s, 第一次失败绝不直接 20s', () {
      expect(relay(1), const Duration(seconds: 1));
      expect(relay(2), const Duration(seconds: 2));
      expect(relay(3), const Duration(seconds: 4));
    });

    test('只走 LAN (远程不可用) → 仍是亚秒级 120/320/650ms', () {
      expect(lan(1), const Duration(milliseconds: 120));
      expect(lan(2), const Duration(milliseconds: 320));
      expect(lan(3), const Duration(milliseconds: 650));
    });

    test('快速档用完两者都进同一套慢速档', () {
      expect(relay(4), const Duration(seconds: 20));
      expect(lan(4), const Duration(seconds: 20));
      expect(relay(14), const Duration(seconds: 60));
    });

    test('快速档不受前后台影响 (后台只影响慢速档)', () {
      expect(
        reconnectDelay(attempt: 1, foreground: false, relayInvolved: true),
        const Duration(seconds: 1),
      );
      expect(
        reconnectDelay(attempt: 4, foreground: false, relayInvolved: true),
        const Duration(minutes: 5),
      );
    });
  });
}
