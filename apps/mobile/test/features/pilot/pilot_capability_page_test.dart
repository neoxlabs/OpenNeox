import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/features/pilot/pilot_capabilities.dart';
import 'package:neox_app/features/pilot/pilot_capability_page.dart';
import 'package:neox_app/features/pilot/pilot_keepalive_guide.dart';

void main() {
  const ch = MethodChannel(kPilotKeepAliveChannel);

  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(ch, (call) async {
      if (call.method != 'status') return null;
      return <String, Object?>{
        'vendor': 'xiaomi',
        'manufacturer': 'Xiaomi',
        'brand': 'Redmi',
        'accessibility': true,
        'notifications': false,
        'battery': true,
        'items': ['accessibility', 'notifications', 'battery', 'autostart'],
      };
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(ch, null);
  });

  testWidgets('列出现在能做的每一项, 没开权限的标「未开」并提示还差几项', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: PilotCapabilityPage()));
    await tester.pumpAndSettle();

    expect(find.text('我能帮你做什么'), findsOneWidget);
    for (final c in kPilotCapabilities) {
      expect(find.text(c.title), findsOneWidget, reason: c.id);
    }
    /* 靠通知的 4 项标「未开」, 无障碍已开, 短信/拨号/电脑查不了 */
    expect(find.text('未开'), findsNWidgets(4));
    expect(find.textContaining('有 4 项还差权限'), findsOneWidget);
    expect(find.text('试用中'), findsNWidgets(2));
  });

  testWidgets('点一句示例 → 带着这句话返回, 由上层填进输入框', (tester) async {
    String? popped;
    await tester.pumpWidget(MaterialApp(
      home: Builder(
        builder: (ctx) => Scaffold(
          body: TextButton(
            onPressed: () async {
              popped = await Navigator.of(ctx).push<String>(
                  MaterialPageRoute(builder: (_) => const PilotCapabilityPage()));
            },
            child: const Text('open'),
          ),
        ),
      ),
    ));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('「明早 8 点提醒我交房租」'));
    await tester.pumpAndSettle();

    expect(popped, '明早 8 点提醒我交房租');
    expect(find.text('open'), findsOneWidget);
  });
}
