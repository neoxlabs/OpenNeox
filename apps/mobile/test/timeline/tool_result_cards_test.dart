import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/features/timeline/widgets/rich_cards.dart';
import 'package:neox_app/features/timeline/widgets/tool_result_cards.dart';

void main() {
  group('parseWebSearchOutput (WebSearchTool 写的格式)', () {
    test('标题 / 链接 / 日期 / 摘要都拆得开, 缺日期也行', () {
      const out = '1. 上海周末去哪玩\n'
          '   https://www.example.com/a\n'
          '   2026-10-01T08:00:00Z\n'
          '   十个适合带娃的地方\n'
          '2. 第二条\n'
          '   https://news.site.cn/b\n'
          '   只有摘要 没有日期';
      final hits = parseWebSearchOutput(out);
      expect(hits, hasLength(2));
      expect(hits[0].title, '上海周末去哪玩');
      expect(hits[0].url, 'https://www.example.com/a');
      expect(hits[0].host, 'example.com');
      expect(hits[0].date, '2026-10-01');
      expect(hits[0].snippet, '十个适合带娃的地方');
      expect(hits[1].date, isNull);
      expect(hits[1].snippet, '只有摘要 没有日期');
    });

    test('没搜到的那句话不出卡', () {
      expect(parseWebSearchOutput('没有搜到结果, 换个搜索词再试'), isEmpty);
    });
  });

  group('parseLocationOutput', () {
    test('get_location 的输出', () {
      final r = parseLocationOutput('纬度 31.2304, 经度 121.4737 (精度约 35 米, 刚定位)');
      expect(r, isNotNull);
      expect(r!.lat, closeTo(31.2304, 1e-9));
      expect(r.lng, closeTo(121.4737, 1e-9));
      expect(r.note, '精度约 35 米, 刚定位');
    });
    test('不是坐标就不出卡', () {
      expect(parseLocationOutput('没有定位权限 (用户拒绝了授权)'), isNull);
    });
  });

  group('buildNeoxCard', () {
    test('认识的 kind + 合法 JSON 出卡', () {
      expect(buildNeoxCard('weather', '{"location":"上海","current":{"temp":"23°","text":"多云"}}'), isNotNull);
      expect(buildNeoxCard('restaurant', '{"items":[{"name":"老吉士","rating":4.6}]}'), isNotNull);
    });
    test('不认识的 kind 交回代码块', () {
      expect(buildNeoxCard('diff', '{"files":[]}'), isNull);
    });
    test('流式写到一半: 生成中占位, 不露半截 JSON', () {
      final w = buildNeoxCard('weather', '{"location":"上海","cur', streaming: true);
      expect(w, isNotNull);
      expect(w.runtimeType.toString(), '_PendingCard');
    });
    test('写完了但 JSON 坏了: 交回代码块显示原文', () {
      expect(buildNeoxCard('weather', '{"location": 上海}'), isNull);
    });
  });

  testWidgets('天气卡 / 地点卡能渲染', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(
          child: Column(children: [
            buildNeoxCard('weather',
                '{"location":"上海","current":{"temp":23,"text":"小雨","humidity":"80%"},"forecast":[{"day":"明天","high":25,"low":19,"text":"多云"}]}')!,
            buildNeoxCard('restaurant', '{"title":"附近咖啡","items":[{"name":"Manner","rating":4.5,"address":"南京西路 1 号","phone":"021-1"}]}')!,
            const LocationCard(lat: 31.23, lng: 121.47, note: '刚定位'),
          ]),
        ),
      ),
    ));
    expect(find.text('上海'), findsOneWidget);
    expect(find.text('23°'), findsOneWidget);
    expect(find.text('Manner'), findsOneWidget);
    expect(find.text('我的位置'), findsOneWidget);
  });
}
