import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/network/edge_route.dart';

void main() {
  const hk = EdgeDef('hk', alias: {
    'neox-dev.com': 'hk.neox-dev.com',
    'gateway.neox-dev.com': 'gw-hk.neox-dev.com',
  });

  group('chooseEdge (跟桌面端同一规则)', () {
    test('海外: Cloudflare 快 → 留在 Cloudflare', () {
      expect(chooseEdge({'cf': const EdgeSample(3, 60), 'hk': const EdgeSample(3, 260)}, 'cf'), 'cf');
    });
    test('国内: Cloudflare 掉包 → 香港', () {
      expect(chooseEdge({'cf': const EdgeSample(2, 3100), 'hk': const EdgeSample(3, 320)}, 'cf'), 'hk');
    });
    test('只慢一点不切 (防抖); 慢一半以上才切', () {
      expect(chooseEdge({'cf': const EdgeSample(3, 500), 'hk': const EdgeSample(3, 400)}, 'cf'), 'cf');
      expect(chooseEdge({'cf': const EdgeSample(3, 1500), 'hk': const EdgeSample(3, 400)}, 'cf'), 'hk');
    });
    test('香港挂了回 Cloudflare; 全都不通保持现状', () {
      expect(chooseEdge({'cf': const EdgeSample(3, 3000), 'hk': const EdgeSample(0, null)}, 'hk'), 'cf');
      expect(chooseEdge({'cf': const EdgeSample(0, null), 'hk': const EdgeSample(0, null)}, 'hk'), 'hk');
    });
  });

  group('mapBaseForEdge', () {
    test('香港: 接口地址换成专用入口; 不在映射里的原样', () {
      expect(mapBaseForEdge('https://neox-dev.com', hk), 'https://hk.neox-dev.com');
      expect(mapBaseForEdge('https://dl.neox-dev.com', hk), 'https://dl.neox-dev.com');
      expect(mapBaseForEdge('http://10.0.0.1', hk), 'http://10.0.0.1');
    });
    test('Cloudflare 线路不改', () {
      expect(mapBaseForEdge('https://neox-dev.com', const EdgeDef('cf')), 'https://neox-dev.com');
    });
  });

  group('EdgeDef.fromJson (服务端清单)', () {
    test('alias 指向外部域名的整条拒收', () {
      expect(EdgeDef.fromJson({'id': 'x', 'alias': {'neox-dev.com': 'evil.example.com'}}), isNull);
      expect(EdgeDef.fromJson({'id': 'hk', 'alias': {'neox-dev.com': 'hk.neox-dev.com'}})?.alias['neox-dev.com'], 'hk.neox-dev.com');
    });
  });
}
