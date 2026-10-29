import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/features/pilot/pilot_keepalive_guide.dart';
import 'package:neox_app/features/pilot/pilot_keepalive_page.dart';
import 'package:flutter/material.dart';

void main() {
  const ch = MethodChannel(kPilotKeepAliveChannel);
  Map<String, Object?>? status = {
    'vendor': 'xiaomi',
    'manufacturer': 'Xiaomi',
    'brand': 'Redmi',
    'accessibility': true,
    'notifications': false,
    'battery': false,
    'items': ['accessibility', 'notifications', 'battery', 'autostart', 'background_popup', 'lockscreen'],
  };
  final opened = <String>[];

  setUp(() {
    opened.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(ch, (call) async {
      switch (call.method) {
        case 'status':
          return status;
        case 'open':
          opened.add('${(call.arguments as Map)['item']}');
          return {'opened': 'appDetails', 'item': (call.arguments as Map)['item'], 'vendor': 'xiaomi'};
      }
      return null;
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(ch, null);
  });

  Widget wrap(Widget child) => MaterialApp(home: child);

  testWidgets('检查页: 逐项显示已开 / 未开 / 请确认已开, 小米多两项', (tester) async {
    await tester.pumpWidget(wrap(const PilotKeepAlivePage()));
    await tester.pumpAndSettle();

    expect(find.text('让 Pilot 一直在线'), findsOneWidget);
    expect(find.text('还差 2 项'), findsOneWidget);
    expect(find.text('已开'), findsOneWidget);
    expect(find.text('未开'), findsNWidgets(2));
    /* 自启动 / 后台弹出 / 锁屏显示 查不了 */
    expect(find.text('请确认已开'), findsNWidgets(3));
    expect(find.text('后台弹出界面'), findsOneWidget);
    expect(find.text('锁屏显示'), findsOneWidget);
  });

  testWidgets('点一行会调原生 open; 跳不到时提示手动路径', (tester) async {
    await tester.pumpWidget(wrap(const PilotKeepAlivePage()));
    await tester.pumpAndSettle();

    await tester.tap(find.text('自启动'));
    await tester.pumpAndSettle();

    expect(opened, ['autostart']);
    expect(find.textContaining('手动路径：'), findsOneWidget);
    expect(find.textContaining('自启动'), findsWidgets);
  });

  testWidgets('全都开好时汇总说「能查的都开好了」', (tester) async {
    status = {...status!, 'accessibility': true, 'notifications': true, 'battery': true};
    await tester.pumpWidget(wrap(const PilotKeepAlivePage()));
    await tester.pumpAndSettle();
    expect(find.text('能查的都开好了'), findsOneWidget);
    expect(find.text('已开'), findsNWidgets(3));
    status = {...status!, 'notifications': false, 'battery': false};
  });
}
