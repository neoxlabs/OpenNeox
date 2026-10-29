import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/features/timeline/models/payload_utils.dart';
import 'package:neox_app/features/timeline/widgets/markdown_view.dart';

Future<void> _render(WidgetTester tester, String md, {bool streaming = false}) async {
  await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: SingleChildScrollView(child: MarkdownView(data: md, streaming: streaming)))));
  await tester.pump();
}

const _weather =
    '{"location":"上海","forecast":[{"day":"10月7日 明天","high":"26","low":"15","text":"多云转晴","rain_chance":""},{"day":"10月8日","high":"26","low":"17","text":"晴"}]}';

void main() {
  test('stripStandaloneJson 不动代码块里的 JSON 和缩进', () {
    const src = '好的{"command":"ls"}\n\n```neox-card:weather\n$_weather\n```\n\n```py\nif x:\n    y()\n```\n\n后面。';
    final out = stripStandaloneJson(src);
    expect(out, contains(_weather));
    expect(out, contains('    y()'));
    expect(out, isNot(contains('"command"')));
    expect(out.startsWith('好的'), isTrue);
    expect(out.endsWith('后面。'), isTrue);
  });

  testWidgets('写完的天气卡直接出卡', (tester) async {
    await _render(tester, '明天多云。\n\n```neox-card:weather\n$_weather\n```\n\n后面晴。');
    expect(find.text('卡片生成中…'), findsNothing);
    expect(find.text('上海'), findsOneWidget);
  });

  testWidgets('尾逗号也能出卡', (tester) async {
    await _render(tester, '```neox-card:weather\n{"location":"上海","forecast":[{"day":"明天","high":"26","low":"15","text":"晴",},],}\n```');
    expect(find.text('上海'), findsOneWidget);
  });

  testWidgets('流式中半截 JSON 显示生成中', (tester) async {
    await _render(tester, '```neox-card:weather\n{"location":"上海","fore', streaming: true);
    expect(find.text('卡片生成中…'), findsOneWidget);
  });

  testWidgets('写完了还是坏 JSON 交回代码块, 不永远转圈', (tester) async {
    await _render(tester, '```neox-card:weather\n{"location":"上海","fore\n```');
    expect(find.text('卡片生成中…'), findsNothing);
    expect(find.textContaining('"location"'), findsOneWidget);
  });
}
