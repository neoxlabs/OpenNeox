import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/features/pilot/pilot_capabilities.dart';
import 'package:neox_app/features/pilot/pilot_starter.dart';

void main() {
  testWidgets('新会话空状态: 列 5 条能办的事, 点一条只预填不发送, 另有全部能力入口', (tester) async {
    String? picked;
    var all = 0;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: PilotStarter(
          name: '小诺',
          onPick: (t) => picked = t,
          onCamera: () {},
          onAll: () => all++,
        ),
      ),
    ));

    expect(find.text('我是小诺。'), findsOneWidget);
    for (final c in pilotStarterCapabilities()) {
      expect(find.text(c.example), findsOneWidget, reason: c.id);
    }

    await tester.tap(find.text(pilotStarterCapabilities().first.example));
    expect(picked, pilotStarterCapabilities().first.example);

    await tester.tap(find.text('看全部能力 ›'));
    expect(all, 1);
  });
}
