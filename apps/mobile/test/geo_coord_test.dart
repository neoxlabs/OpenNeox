/// geo_coord_test.dart — 中国大陆定位要换 GCJ-02, 港澳台和海外不换 (2026-10-11 用户: 中国现在就有偏移)。
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/device/geo_coord.dart';

void main() {
  test('北京天安门: WGS-84 → GCJ-02 偏几百米, 方向是往东北', () {
    /* 公开对照: WGS (39.915, 116.404) ≈ GCJ (39.91640, 116.41025) */
    final (lat, lng) = wgs84ToGcj02(39.915, 116.404);
    expect(lat, closeTo(39.91640, 0.0002));
    expect(lng, closeTo(116.41025, 0.0002));
  });

  test('港澳台和海外原样返回', () {
    expect(wgs84ToGcj02(22.2783, 114.1747), (22.2783, 114.1747)); /* 香港 */
    expect(wgs84ToGcj02(25.0330, 121.5654), (25.0330, 121.5654)); /* 台北 */
    expect(wgs84ToGcj02(35.6762, 139.6503), (35.6762, 139.6503)); /* 东京 */
    expect(wgs84ToGcj02(37.7749, -122.4194), (37.7749, -122.4194)); /* 旧金山 */
  });

  test('深圳 / 珠海 (挨着港澳) 仍然要换', () {
    expect(needsGcj02(22.5431, 114.0579), isTrue); /* 福田 */
    expect(needsGcj02(22.4800, 113.9200), isTrue); /* 蛇口 */
    expect(needsGcj02(22.2710, 113.5767), isTrue); /* 珠海 */
    expect(needsGcj02(22.3964, 113.9760), isFalse); /* 屯门 */
    expect(needsGcj02(22.1987, 113.5439), isFalse); /* 澳门 */
  });

  test('GCJ-02 → BD-09 再偏一次', () {
    final (lat, lng) = gcj02ToBd09(39.91640, 116.41025);
    expect(lat, closeTo(39.9228, 0.001));
    expect(lng, closeTo(116.4168, 0.001));
  });
}
