/// lan_endpoint_test.dart — 什么地址算局域网 / 什么接口是蜂窝.
///
/// 2026-09-17: 运营商 NAT 的 100.64.0.0/10 与蜂窝接口上的 10.x 地址不能让
/// "手机在局域网里"成立, 否则蜂窝下还会去试同 Wi-Fi 直连。
library;

import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/network/lan_endpoint.dart';

void main() {
  group('isUsableLanIpv4Host', () {
    test('RFC1918 私网段是局域网', () {
      expect(isUsableLanIpv4Host('192.168.1.10'), isTrue);
      expect(isUsableLanIpv4Host('10.0.0.5'), isTrue);
      expect(isUsableLanIpv4Host('172.16.3.4'), isTrue);
      expect(isUsableLanIpv4Host('172.31.255.1'), isTrue);
    });

    test('100.64.0.0/10 (运营商 NAT / Tailscale) 不是局域网', () {
      expect(isUsableLanIpv4Host('100.64.0.1'), isFalse);
      expect(isUsableLanIpv4Host('100.100.1.2'), isFalse);
      expect(isUsableLanIpv4Host('100.127.255.254'), isFalse);
    });

    test('公网 / 环回 / 链路本地 / 组播 不是局域网', () {
      expect(isUsableLanIpv4Host('8.8.8.8'), isFalse);
      expect(isUsableLanIpv4Host('127.0.0.1'), isFalse);
      expect(isUsableLanIpv4Host('169.254.1.1'), isFalse);
      expect(isUsableLanIpv4Host('224.0.0.251'), isFalse);
      expect(isUsableLanIpv4Host('172.32.0.1'), isFalse);
    });
  });

  group('isCellularInterfaceName', () {
    test('iOS / Android 蜂窝接口', () {
      for (final n in [
        'pdp_ip0',
        'pdp_ip1',
        'rmnet_data0',
        'rmnet0',
        'v4-rmnet_data2',
        'ccmni1',
        'seth_lte0',
        'wwan0',
        'clat4',
      ]) {
        expect(isCellularInterfaceName(n), isTrue, reason: n);
      }
    });

    test('Wi-Fi / 有线 / 热点接口不是蜂窝', () {
      for (final n in ['en0', 'en1', 'wlan0', 'eth0', 'bridge100', 'ap0']) {
        expect(isCellularInterfaceName(n), isFalse, reason: n);
      }
    });
  });
}
