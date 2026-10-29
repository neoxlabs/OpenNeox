import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/features/pilot/pilot_capabilities.dart';
import 'package:neox_app/features/pilot/pilot_keepalive_guide.dart';

void main() {
  test('只收「现在能做」的场景, 不出现要研发的下单 / 打车 / 早报', () {
    expect(kPilotCapabilities.map((c) => c.id).toList(),
        ['S05', 'S06', 'S03', 'S04', 'S11', 'S14', 'S13', 'S12']);
    expect(kPilotCapabilities.where((c) => c.id == 'S02'), isEmpty);
    expect(kPilotCapabilities.where((c) => c.title.contains('打车')), isEmpty);
  });

  test('每项都有能力名 / 怎么做 / 示例说法 / 权限说明', () {
    for (final c in kPilotCapabilities) {
      expect(c.title.trim(), isNotEmpty, reason: c.id);
      expect(c.ability.trim(), isNotEmpty, reason: c.id);
      expect(c.example.trim(), isNotEmpty, reason: c.id);
      expect(c.permission.trim(), isNotEmpty, reason: c.id);
    }
    /* 示例说法互不重复, 点了才不会填错 */
    expect(kPilotCapabilities.map((c) => c.example).toSet().length, kPilotCapabilities.length);
  });

  test('空状态露 5 项 (天天用、风险低), 且顺序跟总表一致', () {
    final starters = pilotStarterCapabilities();
    expect(starters.length, 5);
    expect(starters.map((c) => c.id).toList(), ['S05', 'S06', 'S03', 'S04', 'S11']);
  });

  test('keepAliveId 只能是保活检查页查得了的三项', () {
    for (final c in kPilotCapabilities) {
      if (c.keepAliveId != null) {
        expect(['accessibility', 'notifications', 'battery'], contains(c.keepAliveId), reason: c.id);
      }
    }
  });

  test('权限状态: 没拿到 status / 系统查不了 → unknown; 查得到就按开关', () {
    final notify = kPilotCapabilities.firstWhere((c) => c.id == 'S05');
    final sms = kPilotCapabilities.firstWhere((c) => c.id == 'S04');
    expect(pilotCapState(notify, null), PilotCapState.unknown);
    expect(pilotCapState(sms, null), PilotCapState.unknown);

    final off = PilotKeepAliveStatus.from({'notifications': false, 'accessibility': true});
    expect(pilotCapState(notify, off), PilotCapState.off);
    expect(pilotCapState(sms, off), PilotCapState.unknown, reason: '短信系统查不了, 不冒充已开/未开');

    final on = PilotKeepAliveStatus.from({'notifications': true, 'accessibility': true});
    expect(pilotCapState(notify, on), PilotCapState.on);
  });

  test('缺权限计数只数「明确没开」的项', () {
    final off = PilotKeepAliveStatus.from({'notifications': false, 'accessibility': false});
    /* S05 / S06 / S14 / S13 都靠通知, S03 靠无障碍; 其余查不了不算 */
    expect(pilotCapMissingCount(kPilotCapabilities, off), 5);
    expect(pilotCapMissingCount(kPilotCapabilities, null), 0);

    final on = PilotKeepAliveStatus.from({'notifications': true, 'accessibility': true});
    expect(pilotCapMissingCount(kPilotCapabilities, on), 0);
  });
}
