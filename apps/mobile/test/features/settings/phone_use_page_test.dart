/// pilot:D-11 —— 设置 → Phone Use 的批量移除。
///
/// 走真实点击: 进允许名单 → 批量移除 → 勾两个 → 移出, 然后查 SharedPreferences。
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:neox_app/features/settings/phone_use_page.dart';

const _ch = MethodChannel('neox.phone/tools');

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_ch, (call) async {
      switch (call.method) {
        case 'apps':
          return [
            {'package': 'com.sankuai.meituan', 'name': '美团'},
            {'package': 'me.ele', 'name': '饿了么'},
          ];
        case 'status':
          return {'accessibility': true, 'notifications': true};
      }
      return null;
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_ch, null);
  });

  testWidgets('允许名单可一次移出多个 App', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: PhoneUsePage()));
    await tester.pumpAndSettle();

    await tester.tap(find.text('只许下面名单里的'));
    await tester.pumpAndSettle();
    expect(find.text('美团'), findsOneWidget);

    await tester.ensureVisible(find.text('批量移除…'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('批量移除…'));
    await tester.pumpAndSettle();

    await tester.ensureVisible(find.widgetWithText(CheckboxListTile, '美团'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(CheckboxListTile, '美团').last);
    await tester.tap(find.widgetWithText(CheckboxListTile, '饿了么').last);
    await tester.pump();

    await tester.tap(find.textContaining('移出所选 (2)'));
    await tester.pumpAndSettle();

    final prefs = await SharedPreferences.getInstance();
    final allow = prefs.getStringList('phone_use_allow_v1')!;
    expect(allow, isNot(contains('com.sankuai.meituan')));
    expect(allow, isNot(contains('me.ele')));
    expect(allow, contains('com.tencent.mm'));
  });

  testWidgets('批量面板列出全部 19 条 (主列表只看装了的, 没装的也能在这里清掉)', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: PhoneUsePage()));
    await tester.pumpAndSettle();

    await tester.tap(find.text('只许下面名单里的'));
    await tester.pumpAndSettle();
    /* 主列表只显示装了的两个 */
    expect(find.text('美团'), findsOneWidget);
    expect(find.text('com.tencent.mm'), findsNothing);

    await tester.ensureVisible(find.text('批量移除…'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('批量移除…'));
    await tester.pumpAndSettle();

    /* 面板里能看到没装的 (主列表看不见的那几条), 用包名当标题 */
    expect(find.byType(CheckboxListTile), findsWidgets);
    await tester.scrollUntilVisible(find.text('com.tencent.mm'), 120, scrollable: find.byType(Scrollable).last);
    expect(find.text('com.tencent.mm'), findsWidgets);
  });
}
