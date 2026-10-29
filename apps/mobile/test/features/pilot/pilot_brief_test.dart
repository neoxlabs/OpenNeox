import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/pilot/pilot_brief.dart';

void main() {
  test('早报默认 08:00, 最多三件 (pilot:P-01)', () {
    expect(PilotBrief.defaultTime, '08:00');
    expect(PilotBrief.maxItems, 3);
    expect(PilotBrief.timeOf({}), '08:00');
    expect(PilotBrief.timeOf({'pilot.brief_time': '07:45'}), '07:45');
    expect(PilotBrief.timeOf({'pilot.brief_time': '25:00'}), '08:00');
    /* 分钟必须两位, 半截写法按坏值处理, 退回 08:00 */
    expect(PilotBrief.timeOf({'pilot.brief_time': '8:5'}), '08:00');
  });

  test('开关: 只有 off 才关', () {
    expect(PilotBrief.enabled({}), isTrue);
    expect(PilotBrief.enabled({'pilot.brief': 'on'}), isTrue);
    expect(PilotBrief.enabled({'pilot.brief': 'off'}), isFalse);
  });

  test('准点口径 8:00 ±5 分钟', () {
    expect(PilotBrief.onTime({}, '08:00'), isTrue);
    expect(PilotBrief.onTime({}, '08:05'), isTrue);
    expect(PilotBrief.onTime({}, '07:55'), isTrue);
    expect(PilotBrief.onTime({}, '08:06'), isFalse);
    expect(PilotBrief.onTime({}, '07:54'), isFalse);
    expect(PilotBrief.onTime({'pilot.brief_time': '07:45'}, '07:47'), isTrue);
  });

  test('连续 7 天 8:00 都在窗口内', () {
    for (var i = 0; i < 7; i++) {
      expect(PilotBrief.onTime({}, '08:00'), isTrue);
    }
  });
}
