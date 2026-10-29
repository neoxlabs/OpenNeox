/// device_display_name_test.dart — 机器码不该被当成设备名显示.
///
/// 2026-09-22 真机实拍: 「运行位置」chip 和设置页「连接」格都显示过
/// `JDMCVMPHIYKSSVX` —— 那是桌面端的 deviceId, 被服务端上报后原样存进了
/// 配对记录的 deviceName 字段。用户看到的是一串机器码, 不是"哪台电脑"。
library;

import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/device/device_display_name.dart';

void main() {
  group('friendlyDeviceName — 认得出人话才返回', () {
    test('机器码 (uuid / 十六进制) 不认', () {
      expect(friendlyDeviceName('3f2a9c0d1e4b5a6c7d8e'), isNull);
      expect(friendlyDeviceName('550e8400-e29b-41d4-a716-446655440000'), isNull);
    });

    test('Windows 默认主机名是名字, 不是机器码 (2026-10-11 列表一排「未命名电脑」)', () {
      expect(friendlyDeviceName('DESKTOP-9QJ4H1M'), 'DESKTOP-9QJ4H1M');
      expect(friendlyDeviceName('LAPTOP-AB12CD34'), 'LAPTOP-AB12CD34');
      expect(friendlyDeviceName('MACHINE-01'), 'MACHINE-01');
      /* 公司 Windows 机的计算机名就长这样 —— 曾被当成机器码藏成「未命名电脑」 */
      expect(friendlyDeviceName('JDMCVMPHIYKSSVX'), 'JDMCVMPHIYKSSVX');
    });

    test('正常设备名能过 —— 空格 / 小写 / 中文 / 短名', () {
      expect(friendlyDeviceName('Kimberly MacBook Pro'), 'Kimberly MacBook Pro');
      expect(friendlyDeviceName('windows'), 'windows');
      expect(friendlyDeviceName('示例用户的电脑'), '示例用户的电脑');
      expect(friendlyDeviceName('Mac'), 'Mac');
      expect(friendlyDeviceName('air-2024'), 'air-2024');
    });

    test('空 / 纯空白 → null (调用方负责退回「电脑」)', () {
      expect(friendlyDeviceName(null), isNull);
      expect(friendlyDeviceName(''), isNull);
      expect(friendlyDeviceName('   '), isNull);
    });

    test('两端空白先 trim 再判', () {
      expect(friendlyDeviceName('  Kimberly Mac  '), 'Kimberly Mac');
      expect(friendlyDeviceName('  550e8400-e29b-41d4-a716-446655440000  '), isNull);
    });
  });
}
