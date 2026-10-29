/// pilot_node_status_test.dart — 连接页「在不在线 / 最近办了什么」的判定 (pilot:D-18)。
///
/// 钉住三件事:
///   1. 通道断了就是没连上, 心跳再新也不算在线;
///   2. 连着时心跳 <60s 显示在线, 两拍 (3 分钟) 没到才说心跳停了 —— 一拍没回来不报警;
///   3. 最近动作说人话, 没办成要写出来。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/i18n/tr.dart';
import 'package:neox_app/core/pilot/pilot_node_status.dart';

void main() {
  final now = DateTime(2026, 10, 18, 21, 0, 0);

  group('在线判定', () {
    test('连着 + 心跳 12 秒前 → 在线', () {
      final st = PilotNodeStatus(connected: true, lastBeatAt: now.subtract(const Duration(seconds: 12)));
      expect(pilotNodeLink(st, now), PilotNodeLink.online);
      expect(pilotNodeLinkLabel(st, now), '在线');
      expect(pilotNodeBeatLabel(st, now), '心跳正常 · 12 秒前');
    });

    test('通道断了 → 没连上, 即使心跳刚刚还报过', () {
      final st = PilotNodeStatus(connected: false, lastBeatAt: now.subtract(const Duration(seconds: 2)));
      expect(pilotNodeLink(st, now), PilotNodeLink.offline);
      expect(pilotNodeLinkLabel(st, now), '没连上');
      expect(pilotNodeBeatLabel(st, now), '上次报到 刚刚');
    });

    test('从没连过 → 还没连上过', () {
      const st = PilotNodeStatus();
      expect(pilotNodeLinkLabel(st, now), '没连上');
      expect(pilotNodeBeatLabel(st, now), '还没连上过');
    });

    test('连着, 心跳 2 分钟前 → 仍算在线, 但副标题说有点久', () {
      final st = PilotNodeStatus(connected: true, lastBeatAt: now.subtract(const Duration(minutes: 2)));
      expect(pilotNodeLink(st, now), PilotNodeLink.online);
      expect(pilotNodeBeatLabel(st, now), '心跳 2 分钟前 · 有点久');
    });

    test('连着, 两拍 (3 分钟) 没心跳 → 心跳停了', () {
      final st = PilotNodeStatus(connected: true, lastBeatAt: now.subtract(const Duration(minutes: 4)));
      expect(pilotNodeLink(st, now), PilotNodeLink.stale);
      expect(pilotNodeLinkLabel(st, now), '心跳停了');
      expect(pilotNodeBeatLabel(st, now), '心跳停在 4 分钟前');
    });

    test('刚连上还没报到 → 在线', () {
      const st = PilotNodeStatus(connected: true);
      expect(pilotNodeLink(st, now), PilotNodeLink.online);
      expect(pilotNodeBeatLabel(st, now), '刚连上');
    });
  });

  group('最近动作', () {
    test('没办过 → 还没替它办过事', () {
      expect(pilotNodeActionLabel(const PilotNodeStatus(), now), '还没替它办过事');
    });

    test('工具名翻成人话 + 多久以前', () {
      final st = PilotNodeStatus(lastAction: 'set_alarm', lastActionAt: now.subtract(const Duration(minutes: 3)));
      expect(pilotNodeActionLabel(st, now), '定闹钟 · 3 分钟前');
    });

    test('没办成要写出来, 不能看起来像办成了', () {
      final st = PilotNodeStatus(
        lastAction: 'phone_ui',
        lastActionAt: now.subtract(const Duration(seconds: 40)),
        lastActionOk: false,
      );
      expect(pilotNodeActionLabel(st, now), '操作手机 · 40 秒前 · 没办成');
    });

    test('没见过的工具名原样显示, 不丢信息', () {
      expect(pilotActionName('brand_new_tool'), 'brand_new_tool');
      expect(pilotActionName(''), '办事');
    });

    test('多久以前: 刚刚 / 秒 / 分钟 / 小时 / 天', () {
      expect(pilotAgoShort(now.subtract(const Duration(seconds: 2)), now), '刚刚');
      expect(pilotAgoShort(now.subtract(const Duration(seconds: 30)), now), '30 秒前');
      expect(pilotAgoShort(now.subtract(const Duration(minutes: 5)), now), '5 分钟前');
      expect(pilotAgoShort(now.subtract(const Duration(hours: 3)), now), '3 小时前');
      expect(pilotAgoShort(now.subtract(const Duration(days: 2)), now), '2 天前');
      /* 时钟回拨: 不显示「-3 秒前」 */
      expect(pilotAgoShort(now.add(const Duration(seconds: 3)), now), '刚刚');
    });
  });

  group('英文界面', () {
    setUp(() => debugUiLanguageOverride = 'en');
    tearDown(() => debugUiLanguageOverride = 'zh');

    test('整行都是英文, 不混中文', () {
      final cjk = RegExp(r'[一-鿿]');
      final st = PilotNodeStatus(
        connected: true,
        lastBeatAt: now.subtract(const Duration(seconds: 12)),
        lastAction: 'set_alarm',
        lastActionAt: now.subtract(const Duration(minutes: 3)),
      );
      final link = pilotNodeLinkLabel(st, now, t: tr);
      final beat = pilotNodeBeatLabel(st, now, t: tr);
      final action = pilotNodeActionLabel(st, now, t: tr);
      expect(cjk.hasMatch(link), isFalse, reason: link);
      expect(cjk.hasMatch(beat), isFalse, reason: beat);
      expect(cjk.hasMatch(action), isFalse, reason: action);
      expect(link, 'Online');
      expect(action, 'Set alarm · 3 min ago');
      expect(pilotNodeActionLabel(PilotNodeStatus(lastAction: 'camera', lastActionAt: now, lastActionOk: false), now, t: tr),
          'Take photo · Just now · Not done');
      expect(pilotNodeBeatLabel(PilotNodeStatus(connected: true), now, t: tr), 'Just connected');
      expect(pilotNodeBeatLabel(const PilotNodeStatus(), now, t: tr), "Hasn't connected yet");
    });
  });

  group('状态写入', () {
    test('markConnected / markBeat / markAction 都保留彼此', () {
      final c = ProviderContainer();
      addTearDown(c.dispose);
      final n = c.read(pilotNodeStatusProvider.notifier);

      n.markConnected(true);
      n.markBeat(now);
      n.markAction('camera', ok: false, at: now);

      final s = c.read(pilotNodeStatusProvider);
      expect(s.connected, isTrue);
      expect(s.lastBeatAt, now);
      expect(s.lastAction, 'camera');
      expect(s.lastActionOk, isFalse);

      n.markConnected(false);
      final off = c.read(pilotNodeStatusProvider);
      expect(off.connected, isFalse);
      expect(off.lastBeatAt, now, reason: '断开不能把上一次心跳抹掉');
      expect(off.lastAction, 'camera');
    });

    test('空工具名不写 (phone.exec 没带 tool 时不编一条动作)', () {
      final c = ProviderContainer();
      addTearDown(c.dispose);
      c.read(pilotNodeStatusProvider.notifier).markAction('');
      expect(c.read(pilotNodeStatusProvider).lastAction, isNull);
    });
  });
}
