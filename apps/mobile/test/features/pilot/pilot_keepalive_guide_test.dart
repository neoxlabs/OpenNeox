import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/features/pilot/pilot_keepalive_guide.dart';

void main() {
  test('厂商判定: 小米/华为/荣耀/OPPO/一加/realme/vivo/iQOO/三星/原生', () {
    expect(pilotVendorOf('Xiaomi', brand: 'Redmi'), PilotVendor.xiaomi);
    expect(pilotVendorOf('POCO'), PilotVendor.xiaomi);
    expect(pilotVendorOf('HUAWEI'), PilotVendor.huawei);
    expect(pilotVendorOf('HONOR'), PilotVendor.huawei);
    expect(pilotVendorOf('Hihonor'), PilotVendor.huawei);
    expect(pilotVendorOf('OPPO'), PilotVendor.oppo);
    expect(pilotVendorOf('OnePlus'), PilotVendor.oppo);
    expect(pilotVendorOf('realme'), PilotVendor.oppo);
    expect(pilotVendorOf('vivo'), PilotVendor.vivo);
    expect(pilotVendorOf('iQOO'), PilotVendor.vivo);
    expect(pilotVendorOf('samsung'), PilotVendor.samsung);
    expect(pilotVendorOf('Google', brand: 'google'), PilotVendor.stock);
    expect(pilotVendorOf(''), PilotVendor.stock);
  });

  test('小米多列后台弹出 / 锁屏显示两项, 别家只列四项', () {
    expect(pilotKeepAliveItems(PilotVendor.xiaomi).map((e) => e.id).toList(),
        ['accessibility', 'notifications', 'battery', 'autostart', 'background_popup', 'lockscreen']);
    for (final v in PilotVendor.values.where((v) => v != PilotVendor.xiaomi)) {
      expect(pilotKeepAliveItems(v).map((e) => e.id).toList(),
          ['accessibility', 'notifications', 'battery', 'autostart'], reason: '$v');
    }
  });

  test('真能检测的只有无障碍 / 通知 / 电池; 自启动等标「请确认已开」', () {
    final items = pilotKeepAliveItems(PilotVendor.xiaomi);
    expect({for (final i in items) i.id: i.detectable}, {
      'accessibility': true,
      'notifications': true,
      'battery': true,
      'autostart': false,
      'background_popup': false,
      'lockscreen': false,
    });
  });

  test('每个厂商每一项都有一句手动路径', () {
    for (final v in PilotVendor.values) {
      for (final it in pilotKeepAliveItems(v)) {
        expect(it.manualPath.trim(), isNotEmpty, reason: '$v / ${it.id}');
        expect(it.title.trim(), isNotEmpty);
      }
    }
  });

  test('status 解析: 厂商 / 三项真状态 / 就绪计数', () {
    final st = PilotKeepAliveStatus.from({
      'vendor': 'xiaomi',
      'manufacturer': 'Xiaomi',
      'brand': 'Redmi',
      'accessibility': true,
      'notifications': false,
      'battery': false,
      'items': ['accessibility', 'notifications', 'battery', 'autostart'],
    });
    expect(st.vendor, PilotVendor.xiaomi);
    expect(st.stateOf('accessibility'), isTrue);
    expect(st.stateOf('notifications'), isFalse);
    expect(st.stateOf('battery'), isFalse);
    expect(st.stateOf('autostart'), isNull);
    expect(st.readyCount, 1);
    expect(st.detectableCount, 3);
    expect(st.items.length, 4);
  });

  test('status 没带 items 时按厂商补全', () {
    final st = PilotKeepAliveStatus.from({'manufacturer': 'HUAWEI'});
    expect(st.vendor, PilotVendor.huawei);
    expect(st.items.map((e) => e.id).toList(), ['accessibility', 'notifications', 'battery', 'autostart']);
    expect(st.readyCount, 0);
  });
}
